// Deterministic replay. Every decision here is a comparison against the artifact or the app
// profile; no model is consulted, and nothing touches the UI except through the guarded executor.

import type { Artifact, ArtifactSignature, Expect, Step } from "../artifact/schema.ts";
import { renderDeep, type Scopes } from "../artifact/template.ts";
import { redact } from "../evidence/redact.ts";
import type { RunLog } from "../evidence/run-log.ts";
import type { GuardedExecutor } from "../executor/guarded-executor.ts";
import { ensureAuthenticated } from "../executor/login.ts";
import type { HandoffController } from "../handoff/controller.ts";
import { checkRequires } from "../executor/policy.ts";
import {
  safeToRetry,
  type Failure,
  type FailureCategory,
  type OutputValue,
  type ReplayResult,
} from "../outcome/result.ts";
import type { Condition, Profile, Tenant } from "../profile/schema.ts";
import type { Target } from "../surface/target.ts";
import type { Signature } from "../surface/types.ts";
import { inputProblem, outputAsText, parseOutput } from "./values.ts";

const CHECKPOINT_TIMEOUT_MS = 2_000;
const HANDLER_TIMEOUT_MS = 5_000;

// Only failures that come from the step itself use its retry budget. A disposition, a policy
// decision or a human has already decided everything else.
const STEP_RETRYABLE: FailureCategory[] = [
  "target_unresolved",
  "target_ambiguous",
  "unexpected_state",
  "extraction_invalid",
];

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
  /**
   * The caller's explicit permission to run irreversible steps unattended. It takes effect only
   * for an `approved` artifact.
   */
  allowIrreversible?: boolean;
  /**
   * The route to a person. Without one, an escalation fails as `escalation_timeout`, an
   * unapproved irreversible step as `policy_denied`, and an unknown outcome stays unknown.
   */
  handoff?: HandoffController;
};

type StepRef = { id: string; intent: string };
/** A step that acts on a target: every kind except `assert`. */
type ActingStep = Exclude<Step, { action: "assert" }>;
type Problem = Pick<Failure, "category" | "expected" | "observed"> & {
  step: StepRef;
  screen: boolean;
  /** For `outcome_unknown`: what was observed after dispatch, as its own category. */
  cause?: FailureCategory;
  /** Set when a person has said what happened; otherwise derived from what was dispatched. */
  sideEffects?: Failure["sideEffects"];
};

type Stop =
  | { kind: "outcome"; code: string }
  | { kind: "restart"; condition: string }
  | { kind: "problem"; problem: Problem };
type StepEnd = { kind: "done" } | Stop;
/** After a condition is handled: carry on with the step, or stop it. */
type Handled =
  | { kind: "continue" }
  // A person resolved an escalated condition and returned control; the screen must be matched
  // again without running the step that led there.
  | { kind: "resync"; condition: string }
  | Exclude<Stop, { kind: "outcome" }>;

// What the screen may show after an action, in the order it is checked on one observation.
// Conditions come first: an error page or an interstitial means the screen is not in any state
// the artifact describes. Outcomes come before the expected state because a business result is
// an answer, not a detour.
type Candidate =
  | { kind: "condition"; condition: Condition; signature: Signature }
  | { kind: "outcome"; code: string; signature: Signature }
  | { kind: "expect"; signature: Signature };

const label = (c: Candidate): string =>
  c.kind === "expect"
    ? "expected state"
    : c.kind === "outcome"
      ? `outcome ${c.code}`
      : `condition ${c.condition.id}`;

const problem = (
  step: StepRef,
  category: FailureCategory,
  expected: string,
  observed: string,
): Extract<Stop, { kind: "problem" }> => ({
  kind: "problem",
  problem: { category, step, expected, observed, screen: true },
});

export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const { artifact, inputs, profile, tenant, executor, log, handoff } = options;
  const started = Date.now();
  const warnings: ReplayResult["warnings"] = [];
  const recoveries: ReplayResult["recoveries"] = [];
  const recoveryAttempts = new Map<string, number>();
  let outputs: Record<string, OutputValue> = {};
  let stepsCompleted = 0;
  let irreversibleDispatched = false;
  // The control epoch in which each assert step last passed. A pre-commit read-back is only
  // valid in the epoch it ran in: a transfer of control may have changed the screen.
  const assertedIn = new Map<string, number>();
  const unattended = artifact.status === "approved" && options.allowIrreversible === true;

  const common = () => ({
    runId: options.runId,
    capability: { id: artifact.id, version: artifact.version, contentHash: artifact.contentHash },
    tenant: tenant.tenant,
    durationMs: Date.now() - started,
    stepsCompleted,
    recoveries,
    interventions: handoff?.interventions ?? [],
    warnings,
    log: options.logPath,
  });

  const warn = (kind: ReplayResult["warnings"][number]["kind"], stepId: string): void => {
    if (!warnings.some((w) => w.kind === kind && w.stepId === stepId)) {
      warnings.push({ kind, stepId });
    }
  };

  const fail = async (p: Problem): Promise<ReplayResult> => {
    const evidence = p.screen ? await executor.captureEvidence(p.step.id) : undefined;
    const sideEffects = p.sideEffects ?? (irreversibleDispatched ? "possible" : "none");
    const failure: Failure = {
      category: p.category,
      stepId: p.step.id,
      intent: p.step.intent,
      expected: p.expected,
      observed: p.observed,
      sideEffects,
      safeToRetry: safeToRetry(p.category, sideEffects),
      outputsVerified: false,
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

  const scopes: Scopes = { inputs };
  const target = (name: string): Target => renderDeep(artifact.targets[name]!, scopes);
  const bind = (signature: ArtifactSignature): Signature => {
    if ("all" in signature) return { all: signature.all.map(bind) };
    if ("any" in signature) return { any: signature.any.map(bind) };
    if ("resolvable" in signature) return { resolvable: target(signature.resolvable) };
    if ("cellEquals" in signature) {
      const { target: name, value, as } = signature.cellEquals;
      return {
        textEquals: {
          target: target(name),
          value: renderDeep(value, scopes),
          ...(as ? { as } : {}),
        },
      };
    }
    return renderDeep(signature, scopes);
  };
  const bindExpect = (expect: Expect, step: ActingStep): Signature =>
    "valueEquals" in expect
      ? {
          valueEquals: {
            target: target(step.target),
            value: renderDeep(expect.valueEquals, scopes),
          },
        }
      : bind(expect);

  const noteRecovery = (condition: string, atStep: string): void => {
    const entry = recoveries.find((r) => r.condition === condition && r.atStep === atStep);
    if (entry) entry.attempts += 1;
    else recoveries.push({ condition, atStep, attempts: 1 });
  };

  const recover = async (
    condition: Extract<Condition, { disposition: "recover" }>,
    step: StepRef,
  ): Promise<Handled> => {
    const attempt = (recoveryAttempts.get(condition.id) ?? 0) + 1;
    recoveryAttempts.set(condition.id, attempt);
    if (attempt > condition.maxAttempts) {
      return problem(
        step,
        "recovery_exhausted",
        `At most ${condition.maxAttempts} recoveries from condition ${condition.id} in one run`,
        `Condition ${condition.id} matched again after ${condition.maxAttempts} recoveries`,
      );
    }
    noteRecovery(condition.id, step.id);
    if (condition.handler) {
      const result = await executor.perform({
        epoch: executor.epoch,
        stepId: step.id,
        intent: `Recover from ${condition.id} (app profile)`,
        action: "click",
        targetName: `${condition.id}.handler`,
        target: condition.handler.click,
        risk: "read",
        timeoutMs: HANDLER_TIMEOUT_MS,
      });
      if (result.status === "denied") {
        return problem(
          step,
          "policy_denied",
          `Policy allows the ${condition.id} handler`,
          result.reason,
        );
      }
      if (result.status === "unresolved") {
        return problem(
          step,
          "unexpected_state",
          `The control that clears condition ${condition.id}`,
          `Condition ${condition.id} matched but its handler control was not found`,
        );
      }
      // The old screen stays up until the next one loads, and racing before it is gone would
      // match the same condition again and spend another recovery. A condition still there
      // after a slow load's worth of time has come back (an identical page can follow), so it
      // is left to the race, where it counts against maxAttempts.
      await executor.waitForAbsence(condition.signature, profile.timeouts.slowLoadMs);
    }
    if (condition.resume === "continue") return { kind: "continue" };
    // Restarting repeats every step. That is only safe if none of them can have committed.
    if (irreversibleDispatched) {
      return problem(
        step,
        "outcome_unknown",
        `A restart after condition ${condition.id} with nothing committed`,
        `Condition ${condition.id} requires a restart, but an irreversible step was already dispatched`,
      );
    }
    return { kind: "restart", condition: condition.id };
  };

  const handle = async (condition: Condition, step: StepRef): Promise<Handled> => {
    log.write("condition", {
      stepId: step.id,
      condition: condition.id,
      disposition: condition.disposition,
    });
    switch (condition.disposition) {
      case "recover":
        return recover(condition, step);
      case "fail":
        return problem(
          step,
          "app_error",
          "The application to process the request",
          `Condition ${condition.id} matched`,
        );
      case "escalate": {
        if (!handoff) {
          return problem(
            step,
            "escalation_timeout",
            "An operator to take over the session",
            `Condition ${condition.id} needs a human and this run has no operator channel`,
          );
        }
        const taken = await handoff.takeover("takeover", {
          stepId: step.id,
          intent: step.intent,
          reason: `Condition ${condition.id} needs a person`,
          condition: condition.id,
        });
        switch (taken.resolution) {
          case "returned":
            // A person may have clicked a commit control; restarting would then be unsafe.
            if (taken.humanCommitted) irreversibleDispatched = true;
            return { kind: "resync", condition: condition.id };
          case "timeout":
            return problem(
              step,
              "escalation_timeout",
              "An operator to take over the session",
              `Nobody resolved condition ${condition.id} within the time allowed`,
            );
          case "aborted":
          case "declined":
            return problem(
              step,
              "aborted_by_human",
              "An operator to resolve the condition and return control",
              `The operator stopped the run at condition ${condition.id}`,
            );
          default:
            return taken satisfies never;
        }
      }
      default:
        return condition satisfies never;
    }
  };

  /** An irreversible action was dispatched and what it did cannot be determined. */
  const unknownOutcome = (
    step: StepRef,
    cause: FailureCategory,
    observed: string,
  ): Extract<Stop, { kind: "problem" }> => ({
    kind: "problem",
    problem: {
      category: "outcome_unknown",
      cause,
      step,
      expected: "The step's expected state after the irreversible action",
      observed,
      screen: true,
    },
  });

  /**
   * An unknown outcome, routed to a person when there is one. They look at the live session and
   * say what happened; the click is never repeated. If the expected state is on screen when
   * control comes back (a slow commit finished), the step simply succeeded.
   */
  const unknown = async (
    step: Exclude<Step, { action: "extract" }>,
    cause: FailureCategory,
    observed: string,
  ): Promise<StepEnd> => {
    const stop = unknownOutcome(step, cause, observed);
    if (!handoff) return stop;
    const taken = await handoff.takeover("unknown_outcome", {
      stepId: step.id,
      intent: step.intent,
      reason: observed,
    });
    if (taken.resolution !== "returned") return stop;
    const now = await executor.race([expected(step)], profile.timeouts.slowLoadMs);
    handoff.resynced(now !== undefined);
    if (now) {
      log.write("state", { stepId: step.id, matched: "expected state", after: "unknown_outcome" });
      return { kind: "done" };
    }
    // A verdict proves the side effect, not the outputs: those were never read from a
    // checkpointed screen, so the result stays a failure either way.
    switch (taken.answer) {
      case "committed":
        return {
          kind: "problem",
          problem: {
            ...stop.problem,
            category: cause,
            sideEffects: "committed",
            observed: `${observed}; the operator confirmed the action committed`,
          },
        };
      case "not_committed":
        return {
          kind: "problem",
          problem: {
            ...stop.problem,
            category: cause,
            sideEffects: "none",
            observed: `${observed}; the operator confirmed nothing was committed`,
          },
        };
      default:
        return stop;
    }
  };

  /** What a step waits for: its expected state, or for an `assert`, its check. */
  const expected = (step: Exclude<Step, { action: "extract" }>): Signature =>
    step.action === "assert" ? bind(step.check) : bindExpect(step.expect, step);

  /** The state race after an action: wait for the first known state and act on it. */
  const settle = async (step: Exclude<Step, { action: "extract" }>): Promise<StepEnd> => {
    const candidates: Candidate[] = [
      ...profile.conditions.map((condition) => ({
        kind: "condition" as const,
        condition,
        signature: condition.signature,
      })),
      ...artifact.outcomes
        .filter((outcome) => outcome.afterSteps.includes(step.id))
        .map((outcome) => ({
          kind: "outcome" as const,
          code: outcome.code,
          signature: bind(outcome.signature),
        })),
      { kind: "expect", signature: expected(step) },
    ];
    // Only a step that has just dispatched an irreversible action is judged this way; a later
    // step's failure keeps its own category and reports possible side effects.
    const committing = step.risk === "irreversible";
    // Set after a person returns control: the condition they resolved. Until the screen matches
    // something known, the handoff is resynchronising, and the step is never run again.
    let returnedFrom: string | undefined;
    let wait = step.timeoutMs;
    const endResync = (ok: boolean): void => {
      if (returnedFrom !== undefined) handoff?.resynced(ok);
      returnedFrom = undefined;
    };
    for (;;) {
      const hit = await executor.race(
        candidates.map((c) => c.signature),
        wait,
      );
      if (!hit && returnedFrom !== undefined) {
        endResync(false);
        return problem(
          step,
          "unexpected_state",
          "The step's expected state, one of its outcomes or a known condition after control was returned",
          `After control was returned the screen matched none of ${candidates.map(label).join(", ")}; ` +
            "the step that escalated is not run again",
        );
      }
      if (!hit && committing) {
        return unknown(
          step,
          "unexpected_state",
          `No known state appeared within ${step.timeoutMs} ms after the irreversible action`,
        );
      }
      if (!hit) {
        return problem(
          step,
          "unexpected_state",
          `The expected state ${JSON.stringify(
            step.action === "assert" ? step.check : step.expect,
          )} within ${step.timeoutMs} ms`,
          `No known state appeared; checked ${candidates.map(label).join(", ")}`,
        );
      }
      const matched = candidates[hit.index]!;
      log.write("state", { stepId: step.id, matched: label(matched), ms: hit.ms });
      if (hit.ms > profile.timeouts.slowLoadMs) warn("slow_load", step.id);
      switch (matched.kind) {
        case "expect":
          endResync(true);
          return { kind: "done" };
        case "outcome":
          endResync(true);
          return { kind: "outcome", code: matched.code };
        case "condition": {
          const { condition } = matched;
          if (condition.id === returnedFrom) {
            endResync(false);
            return problem(
              step,
              "unexpected_state",
              `Condition ${condition.id} resolved by the operator`,
              `Condition ${condition.id} is still on screen after control was returned`,
            );
          }
          // A notice can still be acknowledged: that repeats nothing. Anything else after a
          // commit (an error page, an expired session, an escalation) leaves the result unknown.
          if (
            committing &&
            !(condition.disposition === "recover" && condition.resume === "continue")
          ) {
            log.write("condition", {
              stepId: step.id,
              condition: condition.id,
              disposition: condition.disposition,
            });
            return unknown(
              step,
              condition.disposition === "fail" ? "app_error" : "unexpected_state",
              `Condition ${condition.id} matched after the irreversible action was dispatched`,
            );
          }
          const handled = await handle(condition, step);
          if (handled.kind === "resync") {
            log.write("resync", { stepId: step.id, condition: handled.condition });
            returnedFrom = handled.condition;
            wait = profile.timeouts.slowLoadMs;
            break;
          }
          // A restart carries on with automation; anything else ends the step.
          if (handled.kind !== "continue") {
            endResync(handled.kind === "restart");
            return handled;
          }
          // The action stands; wait again for where it leads.
          break;
        }
        default:
          return matched satisfies never;
      }
    }
  };

  /** One attempt at a step. Problems are returned, not thrown, so the step can be retried. */
  const attempt = async (step: Step): Promise<StepEnd> => {
    // An assert acts on nothing; the state race over its check is the whole step.
    if (step.action === "assert") {
      const end = await settle(step);
      if (end.kind === "done") assertedIn.set(step.id, executor.epoch);
      return end;
    }
    let approved = unattended;
    if (step.risk === "irreversible" && !unattended && handoff) {
      const answer = await handoff.approval({
        stepId: step.id,
        intent: step.intent,
        reason:
          artifact.status === "approved"
            ? "The caller did not allow irreversible steps to run unattended"
            : "The capability is a draft, not approved for unattended runs",
      });
      if (answer !== "approve") {
        return problem(
          step,
          answer === "deny" ? "aborted_by_human" : "escalation_timeout",
          "Approval for the irreversible step",
          answer === "deny" ? "The approver denied it" : "No approver answered in time",
        );
      }
      approved = true;
    }
    if (step.risk === "irreversible") {
      // The schema puts an assert right before every irreversible step. Run it again if
      // control changed hands since it passed (an approval wait counts).
      const index = artifact.steps.indexOf(step);
      const check = artifact.steps[index - 1];
      if (check?.action === "assert" && assertedIn.get(check.id) !== executor.epoch) {
        log.write("reassert", { stepId: step.id, assertStep: check.id });
        const end = await attempt(check);
        if (end.kind !== "done") return end;
      }
    }
    for (;;) {
      const result = await executor.perform({
        epoch: executor.epoch,
        stepId: step.id,
        intent: step.intent,
        action: step.action,
        targetName: step.target,
        target: target(step.target),
        risk: step.risk,
        // The log keeps the template, so a rendered input never reaches it.
        ...(step.action === "fill" || step.action === "select"
          ? { value: { actual: renderDeep(step.value, scopes), logged: step.value } }
          : {}),
        timeoutMs: step.timeoutMs,
        ...(step.risk === "irreversible" ? { approved } : {}),
      });
      if (result.status === "dispatch_error") {
        if (step.risk === "irreversible") {
          irreversibleDispatched = true;
          const observed = "The surface failed while performing the irreversible action";
          return step.action === "extract"
            ? unknownOutcome(step, "unexpected_state", observed)
            : unknown(step, "unexpected_state", observed);
        }
        return problem(
          step,
          "unexpected_state",
          `The surface performs ${step.action} on "${step.target}"`,
          "The surface failed while performing the action",
        );
      }
      if (result.status === "denied") {
        return problem(
          step,
          "policy_denied",
          `Policy allows ${step.action} (${step.risk}) on "${step.target}"`,
          result.reason,
        );
      }
      if (result.status === "unresolved") {
        // A known condition on screen explains a missing control better than drift does.
        const hit = await executor.race(
          profile.conditions.map((c) => c.signature),
          0,
        );
        if (hit) {
          const handled = await handle(profile.conditions[hit.index]!, step);
          if (handled.kind === "continue") continue;
          // The control was missing because of the condition, so this step has not acted yet
          // and runs now. Only a step whose own action led to an escalation is never re-run.
          if (handled.kind === "resync") {
            handoff?.resynced(true);
            continue;
          }
          return handled;
        }
        return problem(
          step,
          result.kind === "ambiguous" ? "target_ambiguous" : "target_unresolved",
          `Exactly one element for target "${step.target}" within ${step.timeoutMs} ms`,
          result.kind === "ambiguous"
            ? `${result.count} elements matched; refusing to choose one`
            : "No strategy matched any element",
        );
      }
      if (step.risk === "irreversible") irreversibleDispatched = true;
      if (result.strategyIndex > 0) warn("locator_fallback", step.id);

      if (step.action !== "extract") return settle(step);
      const spec = artifact.outputs[step.output]!;
      const value = parseOutput(result.element.text, spec);
      if (value === undefined) {
        return problem(
          step,
          "extraction_invalid",
          `Text that parses as ${spec.type} for output "${step.output}"`,
          `The text at "${step.target}" did not parse as ${spec.type}`,
        );
      }
      outputs[step.output] = value;
      return { kind: "done" };
    }
  };

  /** Runs every step once, from the authenticated shell. Returns why it stopped early, if it did. */
  const runSteps = async (): Promise<{ stop: Stop; step: Step } | undefined> => {
    for (const step of artifact.steps) {
      let end = await attempt(step);
      for (
        let retry = 1;
        end.kind === "problem" &&
        STEP_RETRYABLE.includes(end.problem.category) &&
        retry <= step.retry.max;
        retry++
      ) {
        log.write("step_retry", { stepId: step.id, retry, category: end.problem.category });
        end = await attempt(step);
      }
      if (end.kind !== "done") return { stop: end, step };
      stepsCompleted += 1;
      log.write("step_ok", { stepId: step.id });
    }
    return undefined;
  };

  // A restart is bounded by the recovering condition's maxAttempts, so this loop ends.
  for (;;) {
    const login = await ensureAuthenticated(executor, profile, options.secrets);
    if (!login.ok) {
      return fail({
        category: login.denied ? "policy_denied" : "unexpected_state",
        step: { id: "login", intent: "Sign in using the app profile" },
        expected: "The authenticated shell",
        observed: login.reason,
        screen: !login.denied,
      });
    }
    const stopped = await runSteps();
    if (!stopped) break;
    const { stop, step } = stopped;
    switch (stop.kind) {
      case "restart":
        log.write("restart", { stepId: step.id, condition: stop.condition });
        outputs = {};
        stepsCompleted = 0;
        continue;
      case "problem":
        return fail(stop.problem);
      case "outcome": {
        const outcome = { code: stop.code, atStep: step.id };
        log.write("run_end", { status: "business_outcome", outcome });
        return { ...common(), status: "business_outcome", outcome };
      }
      default:
        return stop satisfies never;
    }
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
      const reason = inputProblem(value, spec);
      // The value itself is left out: it may be sensitive and this text is logged.
      if (reason) problems.push(`"${name}" ${reason}`);
    }
  }
  for (const name of Object.keys(inputs)) {
    if (!(name in artifact.inputs)) problems.push(`"${name}" is not an input of this capability`);
  }
  return problems.length > 0 ? problems.join("; ") : undefined;
}
