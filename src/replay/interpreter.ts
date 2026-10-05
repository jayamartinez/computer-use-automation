// Deterministic replay. Every decision here is a comparison against the artifact; no model is
// consulted, and nothing touches the UI except through the guarded executor.

import type { Artifact, ArtifactSignature, Expect, Step } from "../artifact/schema.ts";
import { renderDeep, type Scopes } from "../artifact/template.ts";
import { redact } from "../evidence/redact.ts";
import type { RunLog } from "../evidence/run-log.ts";
import type { GuardedExecutor } from "../executor/guarded-executor.ts";
import { ensureAuthenticated } from "../executor/login.ts";
import { checkRequires } from "../executor/policy.ts";
import type { Failure, OutputValue, ReplayResult } from "../outcome/result.ts";
import type { Profile, Tenant } from "../profile/schema.ts";
import type { Target } from "../surface/target.ts";
import type { Signature } from "../surface/types.ts";
import { inputProblem, outputAsText, parseOutput } from "./values.ts";

const CHECKPOINT_TIMEOUT_MS = 2_000;

export type ReplayOptions = {
  runId: string;
  artifact: Artifact;
  inputs: Record<string, string>;
  profile: Profile;
  tenant: Tenant;
  secrets: Record<string, string>;
  executor: GuardedExecutor;
  log: RunLog;
  logPath: string;
};

type StepRef = { id: string; intent: string };
type Problem = Pick<Failure, "category" | "expected" | "observed"> & {
  step: StepRef;
  screen: boolean;
};

export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const { artifact, inputs, tenant, executor, log } = options;
  const started = Date.now();
  const warnings: ReplayResult["warnings"] = [];
  const outputs: Record<string, OutputValue> = {};
  let stepsCompleted = 0;

  const common = () => ({
    runId: options.runId,
    capability: { id: artifact.id, version: artifact.version, contentHash: artifact.contentHash },
    tenant: tenant.tenant,
    durationMs: Date.now() - started,
    stepsCompleted,
    recoveries: [],
    interventions: [],
    warnings,
    log: options.logPath,
  });

  const fail = async (problem: Problem): Promise<ReplayResult> => {
    const evidence = problem.screen ? await executor.captureEvidence(problem.step.id) : undefined;
    const failure: Failure = {
      category: problem.category,
      stepId: problem.step.id,
      intent: problem.step.intent,
      expected: problem.expected,
      observed: problem.observed,
      // No irreversible step can be dispatched yet, so nothing can have been committed.
      sideEffects: "none",
      safeToRetry: problem.category !== "invalid_input" && problem.category !== "policy_denied",
      ...(evidence ? { evidence } : {}),
    };
    log.write("run_end", { status: "failure", failure });
    return { ...common(), status: "failure", failure };
  };

  log.write("run_start", {
    runId: options.runId,
    capability: artifact.id,
    version: artifact.version,
    contentHash: artifact.contentHash,
    tenant: tenant.tenant,
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([name, value]) => [
        name,
        redact(value, artifact.inputs[name]?.sensitivity ?? "pii"),
      ]),
    ),
  });

  const invalid = inputProblems(artifact, inputs);
  if (invalid) {
    return fail({
      category: "invalid_input",
      step: { id: "validate_inputs", intent: "Validate inputs against the capability contract" },
      expected: "Inputs matching the declared types",
      observed: invalid,
      screen: false,
    });
  }

  const preflight = checkRequires(tenant.policy, artifact.requires);
  if (preflight.decision === "deny") {
    return fail({
      category: "policy_denied",
      step: {
        id: "preflight",
        intent: "Check the capability's requirements against tenant policy",
      },
      expected: "Requirements within the tenant policy",
      observed: preflight.reason,
      screen: false,
    });
  }

  const login = await ensureAuthenticated(executor, options.profile, options.secrets);
  if (!login.ok) {
    return fail({
      category: login.denied ? "policy_denied" : "unexpected_state",
      step: { id: "login", intent: "Sign in using the app profile" },
      expected: "The authenticated shell",
      observed: login.reason,
      screen: !login.denied,
    });
  }

  const scopes: Scopes = { inputs };
  const target = (name: string): Target => renderDeep(artifact.targets[name]!, scopes);
  const bind = (signature: ArtifactSignature): Signature => {
    if ("all" in signature) return { all: signature.all.map(bind) };
    if ("any" in signature) return { any: signature.any.map(bind) };
    if ("resolvable" in signature) return { resolvable: target(signature.resolvable) };
    if ("cellEquals" in signature) {
      const { target: name, value } = signature.cellEquals;
      return { textEquals: { target: target(name), value: renderDeep(value, scopes) } };
    }
    return renderDeep(signature, scopes);
  };
  const bindExpect = (expect: Expect, step: Step): Signature =>
    "valueEquals" in expect
      ? {
          valueEquals: {
            target: target(step.target),
            value: renderDeep(expect.valueEquals, scopes),
          },
        }
      : bind(expect);

  /** One attempt at a step. Returns a problem instead of throwing so the caller can retry. */
  const attempt = async (step: Step): Promise<Problem | undefined> => {
    const result = await executor.perform({
      epoch: executor.epoch,
      stepId: step.id,
      intent: step.intent,
      action: step.action,
      targetName: step.target,
      target: target(step.target),
      risk: step.risk,
      // The log keeps the template, so a rendered input never reaches it.
      ...(step.action === "fill"
        ? { value: { actual: renderDeep(step.value, scopes), logged: step.value } }
        : {}),
      timeoutMs: step.timeoutMs,
    });
    if (result.status === "denied") {
      return {
        category: "policy_denied",
        step,
        expected: `Policy allows ${step.action} (${step.risk}) on "${step.target}"`,
        observed: result.reason,
        screen: true,
      };
    }
    if (result.status === "unresolved") {
      return {
        category: result.kind === "ambiguous" ? "target_ambiguous" : "target_unresolved",
        step,
        expected: `Exactly one element for target "${step.target}" within ${step.timeoutMs} ms`,
        observed:
          result.kind === "ambiguous"
            ? `${result.count} elements matched; refusing to choose one`
            : "No strategy matched any element",
        screen: true,
      };
    }
    if (result.strategyIndex > 0 && !warnings.some((w) => w.stepId === step.id)) {
      warnings.push({ kind: "locator_fallback", stepId: step.id });
    }

    if (step.action === "extract") {
      const spec = artifact.outputs[step.output]!;
      const value = parseOutput(result.element.text, spec);
      if (value === undefined) {
        return {
          category: "extraction_invalid",
          step,
          expected: `Text that parses as ${spec.type} for output "${step.output}"`,
          observed: `The text at "${step.target}" did not parse as ${spec.type}`,
          screen: true,
        };
      }
      outputs[step.output] = value;
      return undefined;
    }

    if (!(await executor.waitFor(bindExpect(step.expect, step), step.timeoutMs))) {
      return {
        category: "unexpected_state",
        step,
        expected: `${JSON.stringify(step.expect)} within ${step.timeoutMs} ms`,
        observed: "The expected state did not appear; see the evidence files",
        screen: true,
      };
    }
    return undefined;
  };

  for (const step of artifact.steps) {
    let problem = await attempt(step);
    for (
      let retry = 1;
      problem && problem.category !== "policy_denied" && retry <= step.retry.max;
      retry++
    ) {
      log.write("step_retry", { stepId: step.id, retry, category: problem.category });
      problem = await attempt(step);
    }
    if (problem) return fail(problem);
    stepsCompleted += 1;
    log.write("step_ok", { stepId: step.id });
  }

  const checkpoint: StepRef = {
    id: "checkpoint",
    intent: "Verify the capability's success checkpoint",
  };
  for (const predicate of artifact.checkpoint.all) {
    const holds =
      "outputParsed" in predicate
        ? predicate.outputParsed in outputs
        : await executor.waitFor(bind(predicate), CHECKPOINT_TIMEOUT_MS);
    if (!holds) {
      return fail({
        category: "unexpected_state",
        step: checkpoint,
        expected: JSON.stringify(predicate),
        observed: "The checkpoint predicate does not hold on the final screen",
        screen: true,
      });
    }
  }
  log.write("checkpoint_ok");

  log.write("run_end", {
    status: "success",
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([name, value]) => [
        name,
        redact(outputAsText(value), artifact.outputs[name]!.sensitivity),
      ]),
    ),
  });
  return { ...common(), status: "success", outputs };
}

function inputProblems(artifact: Artifact, inputs: Record<string, string>): string | undefined {
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(artifact.inputs)) {
    const value = inputs[name];
    if (value === undefined) problems.push(`"${name}" is missing`);
    else {
      const problem = inputProblem(value, spec);
      // The value itself is left out: it may be sensitive and this text is logged.
      if (problem) problems.push(`"${name}" ${problem}`);
    }
  }
  for (const name of Object.keys(inputs)) {
    if (!(name in artifact.inputs)) problems.push(`"${name}" is not an input of this capability`);
  }
  return problems.length > 0 ? problems.join("; ") : undefined;
}
