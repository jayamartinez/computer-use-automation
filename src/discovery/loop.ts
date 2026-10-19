// The discovery loop: observe, let the model choose one typed action, classify its risk by
// policy, run it through the guarded executor, record a trace event. The model decides what to
// try; everything that makes the trace reusable (provenance, live-tested locators, risk, results)
// is captured here, not asked of the model.

import { relative } from "node:path";
import type { ActionType } from "../artifact/schema.ts";
import type { RunLog } from "../evidence/run-log.ts";
import type { GuardedExecutor } from "../executor/guarded-executor.ts";
import { ensureAuthenticated } from "../executor/login.ts";
import { classifyRisk } from "../executor/risk.ts";
import type { HandoffController } from "../handoff/controller.ts";
import { redact } from "../evidence/redact.ts";
import { parseOutput } from "../outcome/values.ts";
import type { Condition, Profile, Tenant } from "../profile/schema.ts";
import { maskedElements, moneyAmount, normalize } from "../surface/resolve.ts";
import type { HumanAction, MaskRule, Observation, ObservedElement } from "../surface/types.ts";
import type { Trace, TraceEvent } from "../trace/schema.ts";
import {
  parseModelAction,
  toolDefinitions,
  type ModelAction,
  type ValueSource,
} from "./actions.ts";
import type { DecisionProvider, ProviderResponse } from "./llm/provider.ts";
import {
  synthesizeCandidates,
  targetFrom,
  templateCandidates,
  type Candidate,
  templateText,
} from "./locate.ts";
import { renderObservation } from "./observe.ts";
import { inputValues, type CapabilityRequest } from "./request.ts";

const ACTION_TIMEOUT_MS = 5_000;
/** The same action on the same screen this many times is stuck. */
const STUCK_REPEATS = 3;
/** This many answers in a row that cannot be acted on is stuck. */
const STUCK_BAD_ANSWERS = 3;
const HISTORY_LINES = 12;

export type DiscoverOptions = {
  runId: string;
  runDir: string;
  request: CapabilityRequest;
  profile: Profile;
  tenant: Tenant;
  secrets: Record<string, string>;
  executor: GuardedExecutor;
  provider: DecisionProvider;
  log: RunLog;
  /** The route to a person. Without one, stuck and unknown buttons end the run. */
  handoff?: HandoffController;
  /** Save a masked screenshot and element dump per step (default true). */
  evidence?: boolean;
};

const SYSTEM = `You operate a legacy bank back-office web application on behalf of an automation system that will later replay what you do without you. Each turn you see the current screen as a list of elements (with refs) and a screenshot, plus what happened so far. Choose exactly ONE next action by calling exactly one tool.

Rules:
- Work only inside the application. There is no address bar; move by clicking what is on screen.
- When typing a declared input, reference it by name ({input: "name"}). Never retype its value as a literal.
- Read a declared output with extract on the element whose text is exactly that value; extract each output once.
- Call finish only when every declared output has been extracted and the screen proves the goal. Cite the elements that prove it, including one that shows which record was handled.
- If a screen needs a decision or a credential you do not have, or you have tried the same thing twice without progress, call need_human.
- Prefer the shortest path. Do not explore.`;

type End = Trace["end"];
type Outcome = { kind: "continue" } | { kind: "end"; end: End };

export async function discover(options: DiscoverOptions): Promise<Trace> {
  const { request, profile, tenant, executor, provider, log, handoff } = options;
  const inputs = inputValues(request);
  const tools = toolDefinitions();
  const started = Date.now();
  const events: TraceEvent[] = [];
  const history: string[] = [];
  const outputsBound: Trace["outputs_bound"] = {};
  const recoveryAttempts = new Map<string, number>();
  const repeats = new Map<string, number>();
  /** Irreversible actions already dispatched, by target: none is ever dispatched again. */
  const committed = new Map<string, string>();
  let seq = 0;
  let decisions = 0;
  let badAnswers = 0;
  let cost = 0;

  const trace = (end: End): Trace => ({
    schemaVersion: 1,
    traceId: options.runId,
    capability: request.id,
    goal: request.goal,
    tenant: tenant.tenant,
    app: { product: profile.product, version: tenant.deployedVersion },
    provider: provider.name,
    inputs: Object.fromEntries(
      Object.entries(request.inputs).map(([n, s]) => [
        n,
        { type: s.type, sensitivity: s.sensitivity },
      ]),
    ),
    outputs: Object.fromEntries(
      Object.entries(request.outputs).map(([n, s]) => [
        n,
        { type: s.type, sensitivity: s.sensitivity },
      ]),
    ),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    events,
    end,
    outputs_bound: outputsBound,
    ...(cost > 0 ? { cost } : {}),
  });

  const stop = (end: End): Outcome => {
    log.write("discovery_end", { kind: end.kind, reason: end.reason });
    return { kind: "end", end };
  };

  const rel = (path: string | undefined): string | undefined =>
    path === undefined ? undefined : relative(options.runDir, path).replaceAll("\\", "/");

  /** Masked evidence for the trace, taken before the model is asked. */
  const observe = async (): Promise<{
    observation: Observation;
    files: TraceEvent["observation"];
  }> => {
    const observation = await executor.observe();
    // Whatever the masks hide on this screen is also scrubbed from every free text written
    // from now on: the model sees the real screen and may repeat what it saw.
    for (const hidden of maskedElements(observation.elements, profile.masks)) {
      for (const text of [hidden.text, hidden.value ?? ""]) {
        log.addScrub({ value: text.trim(), replacement: "[masked]" });
      }
    }
    const files: TraceEvent["observation"] = {
      id: observation.id,
      fingerprint: observation.fingerprint,
    };
    if (options.evidence !== false) {
      const saved = await executor.captureEvidence(`d${seq + 1}`);
      const screenshot = rel(saved.screenshot);
      if (screenshot) files.screenshot = screenshot;
      files.dump = rel(saved.observation)!;
    }
    return { observation, files };
  };

  const record = (event: Omit<TraceEvent, "seq">): TraceEvent => {
    const full = { seq: ++seq, ...event };
    events.push(full);
    log.write("trace_event", {
      seq: full.seq,
      actor: full.actor,
      decision: full.decision.action,
      result: full.result.status,
      ...(full.result.message ? { message: full.result.message } : {}),
    });
    return full;
  };

  const note = (line: string): void => {
    history.push(line);
  };

  /** Waits for the screen to change after a click and then to hold still. */
  const settle = async (
    before: string,
  ): Promise<{ changed: boolean; fingerprint: string; ms: number }> => {
    const start = Date.now();
    const limit = profile.timeouts.slowLoadMs;
    let current = before;
    while (current === before && Date.now() - start < limit) {
      await sleep(100);
      current = (await executor.observe()).fingerprint;
    }
    if (current === before) return { changed: false, fingerprint: current, ms: Date.now() - start };
    let last = current;
    for (;;) {
      await sleep(150);
      const next = (await executor.observe()).fingerprint;
      if (next === last || Date.now() - start > limit * 2) {
        return { changed: true, fingerprint: next, ms: Date.now() - start };
      }
      last = next;
    }
  };

  /** Hands the session to a person, or ends the run when there is nobody to hand it to. */
  const escalate = async (
    kind: "need_human" | "stuck",
    reason: string,
    files: TraceEvent["observation"],
  ): Promise<Outcome> => {
    if (!handoff) return stop({ kind, reason });
    const taken = await handoff.takeover("takeover", {
      stepId: `d${seq}`,
      intent: kind === "stuck" ? "Discovery is stuck" : "The model asked for a person",
      reason,
    });
    if (taken.resolution !== "returned") {
      return stop({ kind: "aborted", reason: `Takeover ended as ${taken.resolution}: ${reason}` });
    }
    recordHuman(taken.actions, files);
    // The person may have left the session anywhere. Automation takes it back only once the
    // screen is re-read and is not still on a condition that needs a person or fails the run;
    // until then the handoff stays in RESYNC and no approval or takeover could be raised.
    const blocking = profile.conditions.filter((c) => c.disposition !== "recover");
    const still = await executor.race(
      blocking.map((c) => c.signature),
      0,
    );
    handoff.resynced(still === undefined);
    if (still) {
      return stop({
        kind: "failed",
        reason: `Control came back but the screen still shows ${blocking[still.index]!.id}`,
      });
    }
    note(
      `A person took over and did: ${taken.actions.map((a) => `${a.kind} ${a.role} "${a.name}"`).join(", ") || "nothing recorded"}; then returned control.`,
    );
    repeats.clear();
    badAnswers = 0;
    return { kind: "continue" };
  };

  const recordHuman = (actions: HumanAction[], files: TraceEvent["observation"]): void => {
    const commitControls = new Set(profile.risk.commitControls.map(normalize));
    for (const action of actions) {
      // A commit a person made counts as dispatched: the model must not make it again.
      if (action.kind === "click" && commitControls.has(normalize(action.name))) {
        committed.set(targetKey(action), "a person's takeover");
      }
      record({
        actor: "human",
        observation: files,
        decision: {
          action: "human",
          kind: action.kind,
          role: action.role,
          name: action.name,
          scope: action.scope,
        },
        result: { status: "ok" },
      });
    }
  };

  /**
   * An irreversible action was dispatched and its result cannot be established. As in replay,
   * it is never repeated: a person, when there is one, checks the live session and says
   * whether it committed. Either way discovery ends here, because what follows the commit was
   * never observed and must not be compiled as if it were.
   */
  const unknownOutcome = async (
    stepId: string,
    intent: string,
    observed: string,
    files: TraceEvent["observation"],
  ): Promise<Outcome> => {
    if (!handoff) {
      return stop({ kind: "outcome_unknown", reason: `${observed}; no operator to check it` });
    }
    const taken = await handoff.takeover("unknown_outcome", { stepId, intent, reason: observed });
    if (taken.resolution !== "returned") {
      return stop({
        kind: "outcome_unknown",
        reason: `${observed}; the check ended as ${taken.resolution}`,
      });
    }
    recordHuman(taken.actions, files);
    // Nothing more is automated in this run, so automation never takes the session back.
    handoff.resynced(false);
    return stop({
      kind: "outcome_unknown",
      reason: `${observed}; the operator's verdict: ${taken.answer}`,
    });
  };

  const condition = async (
    found: Condition,
    files: TraceEvent["observation"],
  ): Promise<Outcome> => {
    record({
      actor: "automation",
      observation: files,
      decision: { action: "condition", condition: found.id, disposition: found.disposition },
      result: { status: "ok" },
    });
    log.write("condition", {
      stepId: `d${seq}`,
      condition: found.id,
      disposition: found.disposition,
    });
    switch (found.disposition) {
      case "fail":
        return stop({ kind: "failed", reason: `Condition ${found.id} matched` });
      case "escalate":
        return escalate("need_human", `Condition ${found.id} needs a person`, files);
      case "recover": {
        const attempt = (recoveryAttempts.get(found.id) ?? 0) + 1;
        recoveryAttempts.set(found.id, attempt);
        if (attempt > found.maxAttempts) {
          return stop({
            kind: "failed",
            reason: `Condition ${found.id} recurred after ${found.maxAttempts} recoveries`,
          });
        }
        if (found.handler) {
          const result = await executor.perform({
            epoch: executor.epoch,
            stepId: `d${seq}`,
            intent: `Recover from ${found.id} (app profile)`,
            action: "click",
            targetName: `${found.id}.handler`,
            target: found.handler.click,
            risk: "read",
            timeoutMs: ACTION_TIMEOUT_MS,
          });
          if (result.status !== "done") {
            return stop({
              kind: "failed",
              reason: `The ${found.id} handler could not be run (${result.status})`,
            });
          }
          await executor.waitForAbsence(found.signature, profile.timeouts.slowLoadMs);
        }
        if (found.resume === "restart_if_no_side_effects") {
          // As in replay: starting over is only safe when nothing can have been committed.
          if (committed.size > 0) {
            return stop({
              kind: "outcome_unknown",
              reason: `Condition ${found.id} requires a restart, but an irreversible action was already dispatched`,
            });
          }
          const login = await ensureAuthenticated(executor, profile, options.secrets);
          if (!login.ok) return stop({ kind: "failed", reason: login.reason });
        }
        note(`The application showed "${found.id}"; it was handled automatically.`);
        return { kind: "continue" };
      }
      default:
        return found satisfies never;
    }
  };

  const prompt = (observation: Observation): string => {
    const inputLines = Object.entries(request.inputs).map(
      ([name, spec]) =>
        `- ${name} (${spec.type}${spec.values ? `: one of ${spec.values.join(", ")}` : ""}): "${spec.value}"`,
    );
    const outputLines = Object.entries(request.outputs).map(
      ([name, spec]) =>
        `- ${name} (${spec.type}${spec.currency ? ` ${spec.currency}` : ""})${spec.description ? `: ${spec.description}` : ""} — ${name in outputsBound ? `extracted at #${outputsBound[name]!.step}` : "NOT YET EXTRACTED"}`,
    );
    const recent = history.slice(-HISTORY_LINES);
    return [
      `Goal: ${request.goal}`,
      "",
      "Declared inputs (reference by name):",
      ...inputLines,
      "",
      "Declared outputs (extract each exactly once):",
      ...outputLines,
      "",
      recent.length
        ? `What happened so far (most recent last):\n${recent.map((l, i) => `${i + 1}. ${l}`).join("\n")}`
        : "Nothing has been done yet.",
      "",
      `Current screen (${observation.elements.length} elements):`,
      renderObservation(observation),
    ].join("\n");
  };

  /** Resolves a value source to what the surface types and what the trace records. */
  const resolveValue = (
    source: ValueSource,
  ): { actual: string; logged: string; literal: boolean } | { problem: string } => {
    if ("input" in source) {
      const value = inputs[source.input];
      if (value === undefined) return { problem: `"${source.input}" is not a declared input` };
      return { actual: value, logged: `{{inputs.${source.input}}}`, literal: false };
    }
    const typed = Object.entries(inputs).find(([, v]) => v === source.literal);
    if (typed) {
      return {
        problem: `The literal equals input "${typed[0]}"; reference it as {input: "${typed[0]}"} instead`,
      };
    }
    return { actual: source.literal, logged: source.literal, literal: true };
  };

  const describe = (e: ObservedElement): string =>
    `${e.ref} ${e.role}${e.name ? ` "${e.name}"` : e.text ? ` "${e.text.slice(0, 40)}"` : ""}`;

  const evidenceTargets = (observation: Observation, refs: string[]) =>
    refs.flatMap((ref) => {
      const element = observation.elements.find((e) => e.ref === ref);
      if (!element) return [];
      return [
        {
          ref,
          role: element.role,
          scope: element.scope,
          candidates: templateCandidates(
            synthesizeCandidates(observation.elements, element, inputs, profile.masks),
            inputs,
          ),
        },
      ];
    });

  /**
   * Texts on a screen equal to an input value: the identity read-back for the checkpoint, and
   * before an irreversible action the read-back of what will be committed. Money is compared as
   * an amount, the way replay's `cellEquals` with `as: "money"` will check it.
   */
  const readbackTargets = (observation: Observation) =>
    Object.entries(inputs).flatMap(([input, value]) =>
      observation.elements
        .filter((e) => {
          if (e.role === "text") return false;
          if (request.inputs[input]?.type !== "money") return e.text.trim() === value;
          const shown = moneyAmount(e.text);
          return shown !== undefined && shown === moneyAmount(value);
        })
        .map((element) => ({
          input,
          ref: element.ref,
          role: element.role,
          scope: element.scope,
          candidates: templateCandidates(
            synthesizeCandidates(observation.elements, element, inputs, profile.masks),
            inputs,
          ),
        }))
        .filter((t) => t.candidates.some((c) => c.unique)),
    );

  const act = async (
    action: Extract<ModelAction, { action: "click" | "fill" | "select" | "extract" }>,
    observation: Observation,
    files: TraceEvent["observation"],
    raw: ProviderResponse,
  ): Promise<Outcome> => {
    const element = observation.elements.find((e) => e.ref === action.ref);
    const invalid = (problem: string): Outcome => {
      record({
        actor: "automation",
        observation: files,
        decision: action,
        raw,
        result: { status: "invalid", message: problem },
      });
      note(`#${seq} ${action.action} ${action.ref}: rejected (${problem})`);
      badAnswers += 1;
      return { kind: "continue" };
    };
    if (!element) return invalid(`there is no element ${action.ref} on this screen`);

    let value: { actual: string; logged: string; literal: boolean } | undefined;
    if (action.action === "fill" || action.action === "select") {
      const resolved = resolveValue(action.action === "fill" ? action.value : action.option);
      if ("problem" in resolved) return invalid(resolved.problem);
      value = resolved;
    }
    if (action.action === "extract" && !(action.output in request.outputs)) {
      return invalid(`"${action.output}" is not a declared output`);
    }

    const candidates: Candidate[] = synthesizeCandidates(
      observation.elements,
      element,
      inputs,
      profile.masks,
    );
    const target = targetFrom(element, candidates);
    // The trace never holds an input value: a locator keyed on one is recorded as its template.
    const targetInfo = {
      role: element.role,
      scope: element.scope,
      candidates: templateCandidates(candidates, inputs),
    };
    if (!target) {
      record({
        actor: "automation",
        observation: files,
        decision: action,
        raw,
        target: targetInfo,
        result: { status: "unlocatable" },
      });
      note(
        `#${seq} ${action.action} on ${describe(element)}: no stable way to identify that element; choose another or need_human`,
      );
      badAnswers += 1;
      return { kind: "continue" };
    }

    const risk = classifyRisk(profile.risk, action.action as ActionType, element);
    const dispatchedAt =
      risk.risk === "irreversible" ? committed.get(targetKey(element)) : undefined;
    if (dispatchedAt !== undefined) {
      // Checked before any approval is asked for: a person must never be invited to approve
      // a second commit of something that may already have been committed.
      record({
        actor: "automation",
        observation: files,
        decision: action,
        raw,
        policy: { risk: risk.risk, rule: "irreversible_once", decision: "deny" },
        target: targetInfo,
        result: {
          status: "denied",
          message: `already dispatched at ${dispatchedAt}; an irreversible action is never repeated`,
        },
      });
      note(
        `#${seq} ${action.action} ${describe(element)}: refused, it was already done at ${dispatchedAt} and is never repeated; continue from the screen as it is`,
      );
      badAnswers += 1;
      return { kind: "continue" };
    }
    let approved = false;
    if (risk.needsApproval) {
      if (!handoff) {
        record({
          actor: "automation",
          observation: files,
          decision: action,
          raw,
          policy: { risk: risk.risk, rule: risk.rule, decision: "deny" },
          target: targetInfo,
          result: {
            status: "denied",
            message: "needs a person's approval and this run has no operator",
          },
        });
        note(
          `#${seq} ${action.action} ${describe(element)}: not allowed without an operator's approval (${risk.rule})`,
        );
        badAnswers += 1;
        return { kind: "continue" };
      }
      const answer = await handoff.approval({
        stepId: `d${seq + 1}`,
        intent: action.rationale,
        reason:
          risk.rule === "commit_control"
            ? `"${element.name}" is a commit control (irreversible)`
            : `"${element.name}" is a ${element.role} the app profile does not classify`,
      });
      if (answer !== "approve") {
        record({
          actor: "automation",
          observation: files,
          decision: action,
          raw,
          policy: { risk: risk.risk, rule: risk.rule, decision: "denied_by_human" },
          target: targetInfo,
          result: {
            status: "denied",
            message: answer === "deny" ? "the operator denied it" : "no operator answered",
          },
        });
        if (answer === "timeout")
          return stop({ kind: "aborted", reason: "No operator answered the approval request" });
        note(
          `#${seq} ${action.action} ${describe(element)}: the operator denied it; do something else`,
        );
        badAnswers += 1;
        return { kind: "continue" };
      }
      approved = true;
    }

    // The same action on the same screen, over and over, is the loop's definition of stuck.
    const key = `${observation.fingerprint}|${action.action}|${element.role}|${element.name}|${value?.logged ?? ""}`;
    const times = (repeats.get(key) ?? 0) + 1;
    repeats.set(key, times);
    if (times >= STUCK_REPEATS) {
      record({
        actor: "automation",
        observation: files,
        decision: action,
        raw,
        target: targetInfo,
        result: { status: "stopped", message: "repeated" },
      });
      return escalate(
        "stuck",
        `${action.action} on ${describe(element)} was chosen ${times} times on an unchanged screen`,
        files,
      );
    }

    const stepId = `d${seq + 1}`;
    const result = await executor.perform({
      epoch: executor.epoch,
      stepId,
      intent: action.rationale,
      action: action.action,
      targetName: `${stepId}_${element.role}`,
      target,
      risk: risk.risk,
      ...(value ? { value: { actual: value.actual, logged: value.logged } } : {}),
      ...(approved ? { approved } : {}),
      timeoutMs: ACTION_TIMEOUT_MS,
    });
    // The executor counts an irreversible action as dispatched once it resolved the target, so
    // from then on it may have committed whatever the result says.
    const dispatched =
      risk.risk === "irreversible" &&
      (result.status === "done" || result.status === "dispatch_error");
    if (dispatched) committed.set(targetKey(element), stepId);
    const policy = {
      risk: risk.risk,
      rule: risk.rule,
      decision: approved ? ("approved" as const) : ("allow" as const),
    };
    const base = {
      actor: "automation" as const,
      observation: files,
      decision: action,
      raw,
      policy,
      target: targetInfo,
      // What the screen showed when the commit was approved: the compiler turns it into the
      // pre-commit assert that must pass before this step on every replay.
      ...(risk.risk === "irreversible" ? { readback: readbackTargets(observation) } : {}),
    };

    switch (result.status) {
      case "denied":
        record({
          ...base,
          policy: { ...policy, decision: "deny" },
          result: { status: "denied", message: result.reason },
        });
        note(`#${seq} ${action.action} ${describe(element)}: denied by policy (${result.rule})`);
        badAnswers += 1;
        return { kind: "continue" };
      case "unresolved":
        record({
          ...base,
          result: { status: "unresolved", message: `${result.kind} on re-resolution` },
        });
        note(`#${seq} ${action.action} ${describe(element)}: the element could not be found again`);
        badAnswers += 1;
        return { kind: "continue" };
      case "dispatch_error":
        record({ ...base, result: { status: "error", message: result.message } });
        if (dispatched) {
          // An error while acting cannot prove nothing was committed; the model is not told
          // "it failed", because it would try again.
          return unknownOutcome(
            stepId,
            action.rationale,
            `${action.action} on ${describe(element)} was dispatched and then failed (${result.message})`,
            files,
          );
        }
        note(
          `#${seq} ${action.action} ${describe(element)}: the action failed (${result.message})`,
        );
        badAnswers += 1;
        return { kind: "continue" };
      case "done":
        break;
      default:
        return result satisfies never;
    }

    badAnswers = 0;
    if (action.action === "extract") {
      const spec = request.outputs[action.output]!;
      const parsed = parseOutput(result.element.text, { ...spec, fromStep: stepId }) !== undefined;
      record({ ...base, result: { status: "ok", extracted: { output: action.output, parsed } } });
      if (parsed) {
        outputsBound[action.output] = { step: seq };
        log.addScrub({
          value: result.element.text.trim(),
          replacement: redact(result.element.text, spec.sensitivity),
        });
        note(`#${seq} extract ${action.output} from ${describe(element)}: ok`);
      } else {
        note(
          `#${seq} extract ${action.output} from ${describe(element)}: the text does not look like a ${spec.type}; pick the element whose text is exactly the value`,
        );
      }
      return { kind: "continue" };
    }
    if (action.action === "fill" || action.action === "select") {
      record({
        ...base,
        result: { status: "ok", postFingerprint: observation.fingerprint, settleMs: 0 },
      });
      note(
        `#${seq} ${action.action} ${describe(element)} with ${value!.literal ? `literal "${value!.actual}"` : value!.logged}: ok`,
      );
      return { kind: "continue" };
    }
    const after = await settle(observation.fingerprint);
    record({
      ...base,
      result: { status: "ok", postFingerprint: after.fingerprint, settleMs: after.ms },
    });
    note(
      `#${seq} click ${describe(element)}: ok (${after.changed ? "screen changed" : "screen did not change"})`,
    );
    return { kind: "continue" };
  };

  const finish = (
    action: Extract<ModelAction, { action: "finish" }>,
    observation: Observation,
    files: TraceEvent["observation"],
    raw: ProviderResponse,
  ): Outcome => {
    const missing = Object.keys(request.outputs).filter((name) => !(name in outputsBound));
    if (missing.length) {
      record({
        actor: "automation",
        observation: files,
        decision: action,
        raw,
        result: { status: "invalid", message: `outputs not extracted: ${missing.join(", ")}` },
      });
      note(`#${seq} finish: rejected, outputs not yet extracted: ${missing.join(", ")}`);
      badAnswers += 1;
      return { kind: "continue" };
    }
    record({
      actor: "automation",
      observation: files,
      decision: action,
      raw,
      result: { status: "finished" },
    });
    return stop({
      kind: "finish",
      summary: action.summary,
      evidence: evidenceTargets(observation, action.evidenceRefs),
      identity: readbackTargets(observation),
    });
  };

  log.write("discovery_start", {
    capability: request.id,
    goal: request.goal,
    provider: provider.name,
  });
  const login = await ensureAuthenticated(executor, profile, options.secrets);
  if (!login.ok) return trace({ kind: "failed", reason: login.reason });

  for (;;) {
    if (decisions >= request.budget.maxSteps) {
      return trace({ kind: "budget", reason: `${request.budget.maxSteps} decisions used` });
    }
    if (Date.now() - started > request.budget.maxMs) {
      return trace({ kind: "budget", reason: `${request.budget.maxMs} ms elapsed` });
    }
    const { observation, files } = await observe();

    const hit = await executor.race(
      profile.conditions.map((c) => c.signature),
      0,
    );
    if (hit) {
      const outcome = await condition(profile.conditions[hit.index]!, files);
      if (outcome.kind === "end") return trace(outcome.end);
      continue;
    }
    if (badAnswers >= STUCK_BAD_ANSWERS) {
      const outcome = await escalate(
        "stuck",
        `${badAnswers} answers in a row could not be acted on`,
        files,
      );
      if (outcome.kind === "end") return trace(outcome.end);
      continue;
    }

    const view = withoutSecrets(observation, Object.values(options.secrets));
    const screenshot = await executor.screenshot(view.masks);
    const raw = await provider.decide({
      system: SYSTEM,
      user: prompt(view.observation),
      ...(screenshot ? { screenshot } : {}),
      tools,
      observation: view.observation,
    });
    decisions += 1;
    cost += raw.usage?.cost ?? 0;
    log.write("model_decision", {
      provider: provider.name,
      tool: raw.toolName,
      usage: raw.usage,
    });

    const parsed = raw.toolName
      ? parseModelAction(raw.toolName, raw.arguments)
      : {
          ok: false as const,
          problem: `no tool call${raw.text ? `; the model wrote: ${raw.text.slice(0, 120)}` : ""}`,
        };
    if (!parsed.ok) {
      record({
        actor: "automation",
        observation: files,
        decision: { action: "invalid", problem: parsed.problem },
        raw,
        result: { status: "invalid", message: parsed.problem },
      });
      note(
        `#${seq} your answer was not a valid tool call (${parsed.problem}); call exactly one tool`,
      );
      badAnswers += 1;
      continue;
    }
    // The model may retype an input value in its prose; the trace names the input instead.
    const action = templateProse(parsed.action, inputs);
    let outcome: Outcome;
    switch (action.action) {
      case "need_human":
        record({
          actor: "automation",
          observation: files,
          decision: action,
          raw,
          result: { status: "stopped" },
        });
        outcome = await escalate("need_human", action.reason, files);
        break;
      case "give_up":
        record({
          actor: "automation",
          observation: files,
          decision: action,
          raw,
          result: { status: "stopped" },
        });
        outcome = stop({ kind: "give_up", reason: action.reason });
        break;
      case "finish":
        outcome = finish(action, observation, files, raw);
        break;
      default:
        outcome = await act(action, observation, files, raw);
    }
    if (outcome.kind === "end") return trace(outcome.end);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type { HumanAction };

/** A control by what it is, not by ref or screen: the same button on any later screen. */
function targetKey(e: { role: string; name: string; scope: string[] }): string {
  return `${e.scope.join("/")}|${e.role}|${normalize(e.name)}`;
}

/**
 * The screen as the model may see it. It sees member data (it has to read the screen, and what
 * it says is scrubbed afterwards), but never a credential: the banner shows the operator ID on
 * every screen. Texts holding a secret are hidden in the screenshot and replaced in the list.
 */
function withoutSecrets(
  observation: Observation,
  secrets: string[],
): { observation: Observation; masks: MaskRule[] } {
  const values = secrets.filter((value) => value.length > 0);
  const hide = (text: string) => values.reduce((t, value) => t.replaceAll(value, "[secret]"), text);
  const holds = (e: ObservedElement) =>
    [e.text, e.name, e.value ?? ""].some((text) => values.some((value) => text.includes(value)));
  return {
    masks: observation.elements
      .filter((e) => e.role === "text" && holds(e))
      .map((e) => ({ label: e.text, where: "self" })),
    observation: {
      ...observation,
      elements: observation.elements.map((e) =>
        holds(e)
          ? {
              ...e,
              text: hide(e.text),
              name: hide(e.name),
              ...(e.value === undefined ? {} : { value: hide(e.value) }),
            }
          : e,
      ),
    },
  };
}

/** Free text the model wrote, with input values written as their templates. */
function templateProse(action: ModelAction, inputs: Record<string, string>): ModelAction {
  const t = (text: string) => templateText(text, inputs);
  switch (action.action) {
    case "finish":
      return { ...action, rationale: t(action.rationale), summary: t(action.summary) };
    case "need_human":
    case "give_up":
      return { ...action, reason: t(action.reason) };
    default:
      return { ...action, rationale: t(action.rationale) };
  }
}
