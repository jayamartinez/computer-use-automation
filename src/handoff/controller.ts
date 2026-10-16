// Control transfer between automation and a person on the same live session. One owner at a
// time (ControlState), an epoch that changes on every transfer so nothing planned before a
// handoff can run after it, and a state machine that refuses any transition it does not list.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunLog } from "../evidence/run-log.ts";
import type { ControlState } from "../executor/control.ts";
import { normalize } from "../surface/resolve.ts";
import type { HumanAction, MaskRule, Surface } from "../surface/types.ts";
import type { InterventionChannel } from "./channel.ts";

export type HandoffState =
  "AUTOMATION_ACTIVE" | "PAUSING" | "AWAITING_HUMAN" | "HUMAN_ACTIVE" | "RESYNC" | "FAILED";

// Timeouts and aborts end the run without reading the screen again, so they go straight to
// FAILED rather than through RESYNC. An approval returns to automation without a takeover.
const NEXT: Record<HandoffState, readonly HandoffState[]> = {
  AUTOMATION_ACTIVE: ["PAUSING"],
  PAUSING: ["AWAITING_HUMAN"],
  AWAITING_HUMAN: ["HUMAN_ACTIVE", "AUTOMATION_ACTIVE", "FAILED"],
  HUMAN_ACTIVE: ["RESYNC", "FAILED"],
  RESYNC: ["AUTOMATION_ACTIVE", "FAILED"],
  FAILED: [],
};

export type InterventionKind = "approval" | "takeover" | "unknown_outcome";

export type InterventionRequest = {
  id: string;
  runId: string;
  kind: InterventionKind;
  capability: { id: string; version: string };
  stepId: string;
  intent: string;
  condition?: string;
  reason: string;
  /** Redacted by sensitivity, as in the run log. */
  inputs: Record<string, string>;
  /** Masked; absent while a native dialog blocks the page. */
  screenshot?: string;
  allowedResponses: string[];
  epoch: number;
  createdAt: string;
};

export type HandoffContext = { stepId: string; intent: string; reason: string; condition?: string };

export type TakeoverResult =
  /** Control came back. `answer` is "return", or the verdict for an unknown outcome. */
  | { resolution: "returned"; answer: string; humanCommitted: boolean; actions: HumanAction[] }
  /** Nobody claimed the session in time, or someone said not to continue. */
  | { resolution: "timeout" | "aborted" | "declined" };

export type HandoffOptions = {
  runId: string;
  runDir: string;
  capability: { id: string; version: string };
  inputs: Record<string, string>;
  surface: Surface;
  control: ControlState;
  channel: InterventionChannel;
  log: RunLog;
  masks: MaskRule[];
  /** Profile commit controls: a person clicking one may have committed something. */
  commitControls: string[];
  /** How long the screen may take to stop changing before a request is raised. */
  settleMs: number;
  claimTimeoutMs: number;
  humanTimeoutMs: number;
};

const ANSWERS = {
  approval: { first: ["approve", "deny"], then: [] },
  takeover: { first: ["claim", "abort"], then: ["return", "abort"] },
  unknown_outcome: {
    first: ["claim", "cant_tell"],
    then: ["committed", "not_committed", "cant_tell"],
  },
} as const;

export class HandoffController {
  state: HandoffState = "AUTOMATION_ACTIVE";
  /** The result's `interventions` annotation. */
  readonly interventions: { id: string; kind: string; resolution: string }[] = [];
  private count = 0;

  constructor(private readonly options: HandoffOptions) {}

  /**
   * Asks a person whether a step may run: an irreversible one, or during discovery a control
   * the app profile does not classify. Control never passes to them.
   */
  async approval(context: HandoffContext): Promise<"approve" | "deny" | "timeout"> {
    const { channel, control, claimTimeoutMs } = this.options;
    const request = await this.raise("approval", context);
    const answer = await channel.ask(
      {
        requestId: request.id,
        prompt:
          `Approve the step "${context.intent}" (${context.stepId})? ` +
          `${context.reason}. The screen is in the browser window and in the request file.`,
        answers: ANSWERS.approval.first,
      },
      claimTimeoutMs,
    );
    this.record(request, answer ?? "timeout");
    if (answer === "approve") {
      control.transfer("automation");
      this.to("AUTOMATION_ACTIVE");
      return "approve";
    }
    this.to("FAILED");
    return answer === "deny" ? "deny" : "timeout";
  }

  /**
   * Hands the live session to a person and takes it back. For an unknown outcome the person
   * looks and gives a verdict instead of simply returning control.
   */
  async takeover(
    kind: "takeover" | "unknown_outcome",
    context: HandoffContext,
  ): Promise<TakeoverResult> {
    const { channel, control, surface, log, claimTimeoutMs, humanTimeoutMs } = this.options;
    const request = await this.raise(kind, context);
    const claim = await channel.ask(
      {
        requestId: request.id,
        prompt:
          kind === "takeover"
            ? `Automation paused at ${context.stepId}: ${context.reason}. ` +
              "Claim the session to work in the browser window yourself."
            : `The outcome of "${context.intent}" is unknown: ${context.reason}. ` +
              "Claim the session to check it in the browser window. Do not repeat the action.",
        answers: ANSWERS[kind].first,
      },
      claimTimeoutMs,
    );
    if (claim !== "claim") {
      this.record(request, claim ?? "timeout");
      this.to("FAILED");
      return {
        resolution: claim === undefined ? "timeout" : claim === "abort" ? "aborted" : "declined",
      };
    }

    control.transfer("human");
    this.to("HUMAN_ACTIVE");
    const actions: HumanAction[] = [];
    let humanCommitted = false;
    const commit = new Set(this.options.commitControls.map(normalize));
    const stop = await surface.watchHuman((action) => {
      if (action.kind === "dialog") {
        channel.notify(
          `A browser dialog is open: "${action.message}". It is held until you return control.`,
        );
        log.write("human_action", {
          intervention: request.id,
          epoch: control.epoch,
          kind: action.kind,
          role: action.role,
          name: action.name,
        });
        actions.push({ ...action, message: "" });
        return;
      }
      if (action.kind === "click" && commit.has(normalize(action.name))) humanCommitted = true;
      log.write("human_action", { intervention: request.id, epoch: control.epoch, ...action });
      actions.push(action);
    });
    let answer: string | undefined;
    try {
      answer = await channel.ask(
        {
          requestId: request.id,
          prompt:
            kind === "takeover"
              ? "You are in control of the browser window. Return control when you are done."
              : "Did the action commit? Answer from what the application shows.",
          answers: ANSWERS[kind].then,
        },
        humanTimeoutMs,
      );
    } finally {
      await stop();
      await this.save(`${this.count}.actions.json`, actions);
    }
    this.record(request, answer === "return" ? "returned" : (answer ?? "timeout"));
    if (answer === undefined || answer === "abort") {
      control.transfer("none");
      this.to("FAILED");
      return { resolution: answer === undefined ? "timeout" : "aborted" };
    }
    control.transfer("automation");
    this.to("RESYNC");
    return { resolution: "returned", answer, humanCommitted, actions };
  }

  /** Called once automation has matched the screen after a takeover, or failed to. */
  resynced(ok: boolean): void {
    if (this.state === "RESYNC") this.to(ok ? "AUTOMATION_ACTIVE" : "FAILED");
  }

  /** Pauses automation, waits for the screen to settle and writes the request. */
  private async raise(
    kind: InterventionKind,
    context: HandoffContext,
  ): Promise<InterventionRequest> {
    const { control, surface, masks, log, runId, capability, inputs } = this.options;
    control.transfer("none");
    this.to("PAUSING");
    await this.settle();

    const n = ++this.count;
    const dir = join(this.options.runDir, "interventions");
    await mkdir(dir, { recursive: true });
    const image = await surface.screenshot({ mask: masks });
    const screenshot = image ? join(dir, `${n}.png`) : undefined;
    if (screenshot) await writeFile(screenshot, image!);
    const request: InterventionRequest = {
      id: `${runId}-i${n}`,
      runId,
      kind,
      capability,
      stepId: context.stepId,
      intent: context.intent,
      ...(context.condition ? { condition: context.condition } : {}),
      reason: context.reason,
      inputs,
      ...(screenshot ? { screenshot } : {}),
      allowedResponses: [...new Set<string>([...ANSWERS[kind].first, ...ANSWERS[kind].then])],
      epoch: control.epoch,
      createdAt: new Date().toISOString(),
    };
    await this.save(`${n}.json`, request);
    log.write("intervention_request", {
      id: request.id,
      kind,
      stepId: context.stepId,
      condition: context.condition,
      reason: context.reason,
      epoch: control.epoch,
    });
    this.to("AWAITING_HUMAN");
    return request;
  }

  /** Two observations in a row with the same content, or as settled as it gets in time. */
  private async settle(): Promise<void> {
    const deadline = Date.now() + this.options.settleMs;
    let last = (await this.options.surface.observe()).fingerprint;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const next = (await this.options.surface.observe()).fingerprint;
      if (next === last) return;
      last = next;
    }
  }

  private record(request: InterventionRequest, resolution: string): void {
    this.interventions.push({ id: request.id, kind: request.kind, resolution });
    this.options.log.write("intervention_resolved", { id: request.id, resolution });
  }

  private to(next: HandoffState): void {
    if (!NEXT[this.state].includes(next)) {
      throw new Error(`Handoff cannot move from ${this.state} to ${next}`);
    }
    const { control, log } = this.options;
    log.write("handoff_state", {
      from: this.state,
      to: next,
      controller: control.controller,
      epoch: control.epoch,
    });
    this.state = next;
  }

  private async save(name: string, data: unknown): Promise<void> {
    const dir = join(this.options.runDir, "interventions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, name),
      `${this.options.log.scrubText(JSON.stringify(data, null, 2))}\n`,
    );
  }
}
