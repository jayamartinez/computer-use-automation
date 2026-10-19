// Trace to artifact. Deterministic: every field of the artifact comes from something the trace
// captured at the moment of acting, or from the request's declared contract. Anything the
// compiler is unsure about is kept and flagged for the reviewer, never guessed away.

import {
  riskRank,
  type Artifact,
  type ArtifactSignature,
  type Risk,
  type Step,
} from "../artifact/schema.ts";
import { contentHash } from "../artifact/store.ts";
import type { Strategy, Target } from "../surface/target.ts";
import type { Trace, TraceEvent } from "../trace/schema.ts";
import { inputValues, type CapabilityRequest } from "../discovery/request.ts";

export const COMPILER_VERSION = "1";

export type CompileFlag = {
  kind:
    | "literal_value"
    | "step_dropped"
    | "duplicate_extract"
    | "human_step_not_compiled"
    | "strategy_rejected"
    | "single_strategy"
    | "weak_expect"
    | "non_interactive_click"
    | "no_identity_readback";
  message: string;
  step?: string;
};

export type CompileReport = {
  traceId: string;
  flags: CompileFlag[];
  steps: { id: string; from: number }[];
  targets: Record<string, { strategies: number }>;
  /** For each irreversible step, which inputs its pre-commit assert checks and which are exempt. */
  readbacks: { step: string; checked: string[]; exempt: string[] }[];
};

export class CompileError extends Error {}

type Acting = Extract<TraceEvent["decision"], { action: "click" | "fill" | "select" | "extract" }>;
type ActingEvent = TraceEvent & { decision: Acting; target: NonNullable<TraceEvent["target"]> };

const TIMEOUTS: Record<Acting["action"], number> = {
  click: 10_000,
  fill: 5_000,
  select: 5_000,
  extract: 5_000,
};
const SUFFIX: Record<string, string> = {
  textbox: "field",
  combobox: "select",
  checkbox: "checkbox",
  radio: "radio",
};

const slug = (text: string): string =>
  text
    .replace(/\{\{inputs\.([^}]+)\}\}/g, "$1")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "item";

export function compileTrace(
  trace: Trace,
  request: CapabilityRequest,
): { artifact: Artifact; report: CompileReport } {
  const flags: CompileFlag[] = [];
  if (trace.end.kind !== "finish") {
    throw new CompileError(
      `The trace did not finish (${trace.end.kind}${trace.end.reason ? `: ${trace.end.reason}` : ""})`,
    );
  }
  if (trace.capability !== request.id) {
    throw new CompileError(`The trace is for ${trace.capability}, the request for ${request.id}`);
  }
  const missing = Object.keys(request.outputs).filter((name) => !(name in trace.outputs_bound));
  if (missing.length) throw new CompileError(`Outputs never extracted: ${missing.join(", ")}`);

  const inputs = inputValues(request);
  const valueToInput = new Map(Object.entries(inputs).map(([name, value]) => [value, name]));

  // 1. Keep the actions that happened; everything else is an interlude or a dead end.
  const kept: ActingEvent[] = [];
  const seenOutputs = new Set<string>();
  for (const event of trace.events) {
    const { decision, result } = event;
    if (event.actor === "human") {
      flags.push({
        kind: "human_step_not_compiled",
        message: `A person did ${decision.action === "human" ? `${decision.kind} ${decision.role} "${decision.name}"` : "something"} at #${event.seq}; it is not in the flow and must be reviewed`,
      });
      continue;
    }
    if (!isActing(decision)) continue;
    if (result.status !== "ok" || !event.target) {
      flags.push({
        kind: "step_dropped",
        message: `#${event.seq} ${decision.action} ended as ${result.status}${result.message ? ` (${result.message})` : ""}`,
      });
      continue;
    }
    if (decision.action === "extract") {
      if (!result.extracted?.parsed) {
        flags.push({
          kind: "step_dropped",
          message: `#${event.seq} extract of ${decision.output} did not parse`,
        });
        continue;
      }
      if (seenOutputs.has(decision.output)) {
        flags.push({
          kind: "duplicate_extract",
          message: `#${event.seq} extracted ${decision.output} again; the first is kept`,
        });
        continue;
      }
      seenOutputs.add(decision.output);
    }
    kept.push(event as ActingEvent);
  }
  if (kept.length === 0) throw new CompileError("No successful action in the trace");

  // 2. Targets: unique-at-capture strategies only, input values templated, data rejected.
  const targets: Record<string, Target> = {};
  const targetNames = new Map<ActingEvent, string>();
  const templateText = (text: string, where: string): string | undefined => {
    // Text the run log scrubbed was data (a masked value, a redacted identifier): a locator
    // built on it would never match anything.
    if (
      text.includes("[masked]") ||
      text.includes("***") ||
      /\[(secret|financial|pii)\]/.test(text)
    ) {
      flags.push({
        kind: "strategy_rejected",
        message: `${where}: text was scrubbed as sensitive data`,
      });
      return undefined;
    }
    const whole = valueToInput.get(text.trim());
    if (whole) return `{{inputs.${whole}}}`;
    const inside = [...valueToInput.entries()].find(
      ([value]) => value.length >= 3 && text.includes(value),
    );
    if (inside) {
      flags.push({
        kind: "strategy_rejected",
        message: `${where}: text contains the value of input "${inside[1]}" and cannot be templated`,
      });
      return undefined;
    }
    return text;
  };
  const templateStrategy = (strategy: Strategy, where: string): Strategy | undefined => {
    switch (strategy.kind) {
      case "role_name": {
        const name = templateText(strategy.name, where);
        return name === undefined ? undefined : { ...strategy, name };
      }
      case "anchor": {
        const text = templateText(strategy.text, where);
        return text === undefined ? undefined : { ...strategy, text };
      }
      case "table_cell": {
        const equals = templateText(strategy.row.equals, where);
        if (equals === undefined) return undefined;
        for (const header of [...strategy.headers, strategy.column]) {
          if (templateText(header, where) !== header) return undefined;
        }
        return { ...strategy, row: { ...strategy.row, equals } };
      }
      default:
        return strategy satisfies never;
    }
  };
  const addTarget = (
    info: { role: string; scope: string[]; candidates: (Strategy & { unique: boolean })[] },
    where: string,
    rationale: string,
  ): string | undefined => {
    const strategies = info.candidates
      .filter((c) => c.unique)
      .map((candidate) => templateStrategy(withoutUnique(candidate), where))
      .filter((s): s is Strategy => s !== undefined);
    const [first] = strategies;
    if (!first) return undefined;
    if (strategies.length === 1) {
      flags.push({
        kind: "single_strategy",
        message: `${where}: only one locator strategy was unique`,
      });
    }
    const target: Target = { scope: info.scope, role: info.role, strategies, rationale };
    // The same control reached twice is one target; the first rationale stands.
    const same = (t: Target) =>
      t.role === target.role &&
      JSON.stringify(t.scope) === JSON.stringify(target.scope) &&
      JSON.stringify(t.strategies) === JSON.stringify(target.strategies);
    const existing = Object.entries(targets).find(([, t]) => same(t));
    if (existing) return existing[0];
    const base = `${slug(nameFor(first))}_${SUFFIX[info.role] ?? info.role}`;
    let name = base;
    for (let n = 2; name in targets; n++) name = `${base}_${n}`;
    targets[name] = target;
    return name;
  };
  for (const event of kept) {
    const where = `#${event.seq} ${event.decision.action}`;
    const name = addTarget(
      event.target,
      where,
      rationaleFor(event.target.role, event.target.candidates.find((c) => c.unique)?.kind),
    );
    if (!name) throw new CompileError(`${where}: no locator strategy survives templating`);
    targetNames.set(event, name);
  }

  // A screen text equal to an input value becomes a check that it still equals that input on
  // replay; money is compared as an amount, since the screen formats it.
  const readbackChecks = (
    found: NonNullable<Trace["end"]["identity"]>,
    where: string,
    rationale: string,
  ): { input: string; check: ArtifactSignature }[] =>
    found.flatMap((readback) => {
      const name = addTarget(readback, `${where} ${readback.input}`, rationale);
      if (!name) return [];
      const money = request.inputs[readback.input]?.type === "money";
      return [
        {
          input: readback.input,
          check: {
            cellEquals: {
              target: name,
              value: `{{inputs.${readback.input}}}`,
              ...(money ? { as: "money" as const } : {}),
            },
          },
        },
      ];
    });

  // 3. Steps, in order, each with what the screen must show afterwards.
  const steps: Step[] = [];
  const stepIds = new Set<string>();
  const fromSeq = new Map<string, number>();
  const stepOf = new Map<ActingEvent, string>();
  const uniqueId = (base: string): string => {
    let id = base;
    for (let n = 2; stepIds.has(id); n++) id = `${base}_${n}`;
    stepIds.add(id);
    return id;
  };
  // An irreversible step runs only after the screen is checked to show what will be committed:
  // every declared input, unless the request exempts it because the commit screen does not show
  // it. One matching value is not enough: a commit that checks the member but not the amount
  // can still move the wrong money.
  const exempt = new Set(request.readbackExempt ?? []);
  const readbackCoverage: CompileReport["readbacks"] = [];
  const preCommitAssert = (event: ActingEvent, stepId: string): Step => {
    const found = readbackChecks(
      event.readback ?? [],
      `#${event.seq} read-back`,
      "Read back before the irreversible step: the screen shows what will be committed.",
    );
    const checked = new Set(found.map((f) => f.input));
    const unchecked = Object.keys(request.inputs).filter(
      (name) => !exempt.has(name) && !checked.has(name),
    );
    if (unchecked.length > 0) {
      throw new CompileError(
        `#${event.seq} is irreversible but the screen before it was not read back for: ${unchecked.join(", ")} (show them on the commit screen, or list them in the request's readbackExempt)`,
      );
    }
    if (found.length === 0) {
      throw new CompileError(
        `#${event.seq} is irreversible but the screen before it showed no input value to read back`,
      );
    }
    const id = uniqueId(`assert_before_${stepId}`);
    fromSeq.set(id, event.seq);
    readbackCoverage.push({
      step: stepId,
      checked: [...checked],
      exempt: Object.keys(request.inputs).filter((name) => exempt.has(name)),
    });
    return {
      id,
      intent: "Check that the screen shows exactly what was asked for before committing",
      action: "assert",
      check: { all: found.map((f) => f.check) },
      risk: "read",
      timeoutMs: 3_000,
      retry: { max: 0 },
    };
  };
  kept.forEach((event, index) => {
    const { decision, policy } = event;
    const targetName = targetNames.get(event)!;
    const id = uniqueId(
      `${decision.action}_${slug(targetName.replace(/_(field|select|link|button|cell|checkbox|radio)$/, ""))}`,
    );
    stepOf.set(event, id);
    fromSeq.set(id, event.seq);
    const risk: Risk = policy?.risk ?? "read";
    const common = {
      id,
      intent: decision.rationale,
      target: targetName,
      risk,
      timeoutMs: TIMEOUTS[decision.action],
    };
    switch (decision.action) {
      case "extract":
        steps.push({ ...common, action: "extract", output: decision.output, retry: { max: 1 } });
        return;
      case "fill":
      case "select": {
        const source = decision.action === "fill" ? decision.value : decision.option;
        let value: string;
        if ("input" in source) value = `{{inputs.${source.input}}}`;
        else {
          value = source.literal;
          flags.push({
            kind: "literal_value",
            step: id,
            message: `${id} types the literal "${source.literal}"; confirm it is not data`,
          });
        }
        steps.push({
          ...common,
          action: decision.action,
          value,
          expect: { valueEquals: value },
          retry: { max: 1 },
        });
        return;
      }
      case "click": {
        // What the click leads to is wherever the next action happens: the control the flow
        // touches next proves the screen arrived.
        const next = kept[index + 1];
        const nextTarget = next ? targetNames.get(next)! : undefined;
        const evidenceName = nextTarget ?? evidenceTarget();
        if (!evidenceName)
          throw new CompileError(`${id}: nothing identifies the screen after the click`);
        if (!CLICKABLE_ROLES.has(event.target.role)) {
          // A click that landed on a cell or text worked only because of what happened to sit
          // inside it; the control a reviewer would expect is the link or button within.
          flags.push({
            kind: "non_interactive_click",
            step: id,
            message: `${id} clicks a ${event.target.role}; retarget it to the control inside, if there is one`,
          });
        }
        if (event.result.postFingerprint === event.observation.fingerprint) {
          flags.push({
            kind: "weak_expect",
            step: id,
            message: `${id}: the screen did not change after the click, so its expected state may already hold before it`,
          });
        }
        if (risk === "irreversible") steps.push(preCommitAssert(event, id));
        steps.push({
          ...common,
          action: "click",
          expect: { resolvable: evidenceName },
          retry: { max: 0 },
          ...(risk === "irreversible" ? { onTimeout: "outcome_unknown" as const } : {}),
        });
        return;
      }
      default:
        return decision satisfies never;
    }
  });

  // 4. The checkpoint: identity read-back for each input the final screen shows, and every
  // output parsed. What the model cited as proof is not added: it describes the discovery
  // record (a Checking row, say), and a contract that requires it fails for every member
  // without one. Cited evidence only stands in for a final click's expected state.
  const checkpoint: Artifact["checkpoint"]["all"] = [];
  const readbacks = readbackChecks(
    trace.end.identity ?? [],
    "identity",
    "Identity read-back: the screen shows which record was handled.",
  );
  if (readbacks.length === 0) {
    flags.push({
      kind: "no_identity_readback",
      message:
        "The final screen shows no input value; the checkpoint cannot confirm which record was handled",
    });
  }
  checkpoint.push(...readbacks.map((r) => r.check));
  function evidenceTarget(): string | undefined {
    for (const cited of trace.end.evidence ?? []) {
      const name = addTarget(
        cited,
        `evidence ${cited.ref}`,
        "Cited by discovery as proof the goal was met.",
      );
      if (name) return name;
    }
    return undefined;
  }
  for (const output of Object.keys(request.outputs)) checkpoint.push({ outputParsed: output });

  const outputs = Object.fromEntries(
    Object.entries(request.outputs).map(([name, spec]) => [
      name,
      {
        ...spec,
        fromStep: stepOf.get(
          kept.find((e) => e.decision.action === "extract" && e.decision.output === name)!,
        )!,
      },
    ]),
  );
  const artifactInputs = Object.fromEntries(
    Object.entries(request.inputs).map(([name, input]) => [name, withoutValue(input)]),
  );
  const used = new Set(Object.values(targets).flatMap((t) => t.scope));
  const artifact: Artifact = {
    schemaVersion: 1,
    id: request.id,
    version: "1.0.0",
    status: "draft",
    contentHash: "sha256:" + "0".repeat(64),
    description: request.description,
    app: {
      product: trace.app.product,
      recordedVersion: trace.app.version ?? "unknown",
      surface: "web",
    },
    inputs: artifactInputs,
    outputs,
    targets,
    steps,
    outcomes: [],
    conditions: "profile",
    checkpoint: { all: checkpoint },
    requires: {
      actions: [...new Set(steps.map((s) => s.action))],
      maxRisk: steps.reduce<Risk>(
        (max, s) => (riskRank(s.risk) > riskRank(max) ? s.risk : max),
        "read",
      ),
      scopes: [...used],
    },
    provenance: {
      traceId: trace.traceId,
      model: trace.provider,
      discoveredAt: trace.startedAt,
      compilerVersion: COMPILER_VERSION,
    },
  };
  artifact.contentHash = contentHash(artifact);
  return {
    artifact,
    report: {
      traceId: trace.traceId,
      flags,
      steps: steps.map((s) => ({ id: s.id, from: fromSeq.get(s.id)! })),
      targets: Object.fromEntries(
        Object.entries(targets).map(([n, t]) => [n, { strategies: t.strategies.length }]),
      ),
      readbacks: readbackCoverage,
    },
  };
}

function isActing(decision: TraceEvent["decision"]): decision is Acting {
  return ["click", "fill", "select", "extract"].includes(decision.action);
}

function nameFor(strategy: Strategy): string {
  switch (strategy.kind) {
    case "role_name":
      return strategy.name;
    case "anchor":
      return strategy.text;
    case "table_cell":
      return strategy.row.equals.startsWith("{{")
        ? `${strategy.row.equals}_row_${strategy.column}`
        : `${strategy.row.equals}_${strategy.column}`;
    default:
      return strategy satisfies never;
  }
}

const CLICKABLE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "menuitem",
  "tab",
  "option",
]);

function rationaleFor(role: string, kind: Strategy["kind"] | undefined): string {
  switch (kind) {
    case "role_name":
      return `A named ${role}; the name is what an operator looks for.`;
    case "anchor":
      return `The ${role} has no accessible name; the visible label beside it is the stable handle.`;
    case "table_cell":
      return "Addressed by header and row key, never by position.";
    default:
      return "Recorded by discovery.";
  }
}

function withoutUnique(candidate: Strategy & { unique: boolean }): Strategy {
  const { unique: _unique, ...strategy } = candidate;
  return strategy;
}

function withoutValue(input: CapabilityRequest["inputs"][string]): Artifact["inputs"][string] {
  const { value: _value, ...spec } = input;
  return spec;
}
