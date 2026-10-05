import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionType, Risk } from "../artifact/schema.ts";
import type { RunLog } from "../evidence/run-log.ts";
import type { Policy } from "../profile/schema.ts";
import { maskObservation } from "../surface/resolve.ts";
import type { Target } from "../surface/target.ts";
import type { MaskRule, ObservedElement, Signature, Surface } from "../surface/types.ts";
import type { ControlState } from "./control.ts";
import { checkAction } from "./policy.ts";

const POLL_MS = 100;

export type ActionRequest = {
  /** The control epoch this action was planned under. */
  epoch: number;
  stepId: string;
  intent: string;
  action: Exclude<ActionType, "assert">;
  targetName: string;
  target: Target;
  risk: Risk;
  /** `actual` goes to the surface; only `logged` (a template or a redacted form) is recorded. */
  value?: { actual: string; logged: string };
  approved?: boolean;
  timeoutMs: number;
};

export type ActionResult =
  | { status: "done"; element: ObservedElement; strategyIndex: number }
  | { status: "denied"; rule: string; reason: string }
  | { status: "unresolved"; kind: "none" | "ambiguous"; count: number };

export type ExecutorOptions = {
  surface: Surface;
  policy: Policy;
  control: ControlState;
  log: RunLog;
  masks: MaskRule[];
  runDir: string;
};

/**
 * The only path to the surface. Checks run in a fixed order before anything is resolved or
 * dispatched: control ownership and epoch, action type, scope, risk.
 */
export class GuardedExecutor {
  constructor(private readonly options: ExecutorOptions) {}

  get epoch(): number {
    return this.options.control.epoch;
  }

  async perform(request: ActionRequest): Promise<ActionResult> {
    const { surface, control, policy, log } = this.options;
    const started = Date.now();
    const base = {
      stepId: request.stepId,
      intent: request.intent,
      action: request.action,
      target: request.targetName,
      risk: request.risk,
      ...(request.value ? { value: request.value.logged } : {}),
    };

    if (control.controller !== "automation" || request.epoch !== control.epoch) {
      const reason = `Controller is "${control.controller}" at epoch ${control.epoch}; action was planned at epoch ${request.epoch}`;
      log.write("action_denied", { ...base, rule: "control", reason });
      return { status: "denied", rule: "control", reason };
    }
    const decision = checkAction(policy, {
      action: request.action,
      scope: request.target.scope,
      risk: request.risk,
      approved: request.approved ?? false,
    });
    if (decision.decision === "deny") {
      log.write("action_denied", { ...base, rule: decision.rule, reason: decision.reason });
      return { status: "denied", rule: decision.rule, reason: decision.reason };
    }

    const deadline = started + request.timeoutMs;
    let resolution = await surface.resolve(request.target);
    while (resolution.kind !== "unique" && Date.now() < deadline) {
      await sleep(POLL_MS);
      resolution = await surface.resolve(request.target);
    }
    if (resolution.kind !== "unique") {
      const count = resolution.kind === "ambiguous" ? resolution.count : 0;
      log.write("target_unresolved", { ...base, resolution: resolution.kind, count });
      return { status: "unresolved", kind: resolution.kind, count };
    }

    switch (request.action) {
      case "click":
        await surface.act(resolution.handle, { kind: "click" });
        break;
      case "fill":
      case "select":
        await surface.act(resolution.handle, {
          kind: request.action,
          value: request.value?.actual ?? "",
        });
        break;
      case "extract":
        // Reading is the resolution itself; the caller takes the text from the element.
        break;
      default:
        request.action satisfies never;
    }
    log.write("action", {
      ...base,
      policy: decision.rule,
      strategy: request.target.strategies[resolution.strategyIndex]?.kind,
      strategyIndex: resolution.strategyIndex,
      ms: Date.now() - started,
    });
    return { status: "done", element: resolution.element, strategyIndex: resolution.strategyIndex };
  }

  /**
   * Waits for the first of several screen states, in the order given. Observing is not an
   * action and needs no policy decision. A zero timeout checks the current screen once.
   */
  async race(
    signatures: Signature[],
    timeoutMs: number,
  ): Promise<{ index: number; ms: number } | undefined> {
    const started = Date.now();
    for (;;) {
      const index = await this.options.surface.firstMatch(signatures);
      if (index !== undefined) return { index, ms: Date.now() - started };
      if (Date.now() - started >= timeoutMs) return undefined;
      await sleep(POLL_MS);
    }
  }

  async waitFor(signature: Signature, timeoutMs: number): Promise<boolean> {
    return (await this.race([signature], timeoutMs)) !== undefined;
  }

  /** Saves a masked screenshot and a masked element dump for a failure report. */
  async captureEvidence(name: string): Promise<{ screenshot: string; observation: string }> {
    const { surface, masks, runDir } = this.options;
    const screenshot = join(runDir, "screenshots", `${name}.png`);
    const observation = join(runDir, "observations", `${name}.json`);
    await mkdir(join(runDir, "screenshots"), { recursive: true });
    await mkdir(join(runDir, "observations"), { recursive: true });
    await writeFile(screenshot, await surface.screenshot({ mask: masks }));
    const masked = maskObservation(await surface.observe(), masks);
    await writeFile(observation, `${JSON.stringify(masked, null, 2)}\n`);
    return { screenshot, observation };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
