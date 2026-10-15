import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunLog } from "../../src/evidence/run-log.ts";
import { ControlState } from "../../src/executor/control.ts";
import { GuardedExecutor } from "../../src/executor/guarded-executor.ts";
import type { InterventionChannel } from "../../src/handoff/channel.ts";
import { HandoffController } from "../../src/handoff/controller.ts";
import { FakeSurface } from "../../src/surface/fake/fake-surface.ts";
import type { Target } from "../../src/surface/target.ts";
import { fakeElement } from "../support/fake-coreserv.ts";
import { answers, ScriptedChannel } from "../support/scripted-channel.ts";
import { tempDir } from "../support/fixtures.ts";

const W = ["workarea"];
const named = (role: string, name: string): Target => ({
  scope: W,
  role,
  strategies: [{ kind: "role_name", name }],
  rationale: "test",
});
const beside = (text: string): Target => ({
  scope: W,
  role: "textbox",
  strategies: [{ kind: "anchor", text, relation: "right_of" }],
  rationale: "test",
});

/** A screen with an override form, enough for a scripted person to work on. */
function setup(channel: InterventionChannel) {
  const lines: string[] = [];
  const log = new RunLog(
    (line) => lines.push(line),
    [{ value: "secret-code-9", replacement: "[secret]" }],
  );
  const surface = new FakeSurface<{ authorized: boolean; typed: string }>({
    initial: { authorized: false, typed: "" },
    render: (s) =>
      s.authorized
        ? [
            fakeElement(W, "text", "Review Sub-Account", 0, 0),
            fakeElement(W, "button", "Confirm", 0, 40),
          ]
        : [
            fakeElement(W, "text", "Supervisor Override Required", 0, 0),
            fakeElement(W, "text", "Override Code", 0, 40),
            fakeElement(W, "textbox", "", 100, 40, s.typed),
            fakeElement(W, "button", "Authorize", 100, 80),
          ],
    reduce: (s, element, action) =>
      action.kind === "fill"
        ? { ...s, typed: action.value }
        : element.name === "Authorize"
          ? { ...s, authorized: true }
          : s,
  });
  const control = new ControlState();
  const runDir = tempDir();
  const handoff = new HandoffController({
    runId: "run1",
    runDir,
    capability: { id: "coreserv.member.open_subaccount", version: "1.0.0" },
    inputs: { memberId: "***77", openingDeposit: "[financial]" },
    surface,
    control,
    channel,
    log,
    masks: [],
    commitControls: ["Confirm"],
    settleMs: 300,
    claimTimeoutMs: 1000,
    humanTimeoutMs: 1000,
  });
  const executor = new GuardedExecutor({
    surface,
    policy: {
      origins: ["http://x"],
      paths: ["/"],
      scopes: W,
      actions: ["click", "fill"],
      maxRisk: "irreversible",
    },
    control,
    log,
    masks: [],
    runDir,
  });
  const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const states = () =>
    events()
      .filter((e) => e.event === "handoff_state")
      .map((e) => e.to);
  return { surface, control, handoff, executor, runDir, lines, events, states };
}

const context = {
  stepId: "continue_to_review",
  intent: "Submit the form for review",
  reason: "Condition supervisor_override needs a person",
  condition: "supervisor_override",
};

describe("handoff controller with a scripted person", () => {
  it("pauses, hands the same session to a person, takes it back and resyncs", async () => {
    const channel = new ScriptedChannel(async (question) => {
      if (question.answers.includes("claim")) {
        expect(t.control.controller).toBe("none");
        return "claim";
      }
      // The person works in the same session while it is theirs.
      expect(t.control.controller).toBe("human");
      await t.surface.actAsHuman(beside("Override Code"), { kind: "fill", value: "secret-code-9" });
      await t.surface.actAsHuman(named("button", "Authorize"), { kind: "click" });
      return "return";
    });
    const t: ReturnType<typeof setup> = setup(channel);
    const startEpoch = t.control.epoch;

    const result = await t.handoff.takeover("takeover", context);
    expect(result).toEqual({ resolution: "returned", answer: "return", humanCommitted: false });
    expect(t.handoff.state).toBe("RESYNC");
    expect(t.control.controller).toBe("automation");
    // none, human, automation: three transfers.
    expect(t.control.epoch).toBe(startEpoch + 3);
    t.handoff.resynced(true);
    expect(t.states()).toEqual([
      "PAUSING",
      "AWAITING_HUMAN",
      "HUMAN_ACTIVE",
      "RESYNC",
      "AUTOMATION_ACTIVE",
    ]);
    expect(await t.surface.matches({ textPresent: "Review Sub-Account" })).toBe(true);
    expect(t.handoff.interventions).toEqual([
      { id: "run1-i1", kind: "takeover", resolution: "returned" },
    ]);
  });

  it("writes a request with capability, step, reason, redacted inputs and a screenshot", async () => {
    const t = setup(answers("claim", "return"));
    await t.handoff.takeover("takeover", context);
    const request = JSON.parse(readFileSync(join(t.runDir, "interventions", "1.json"), "utf8"));
    expect(request).toMatchObject({
      id: "run1-i1",
      runId: "run1",
      kind: "takeover",
      capability: { id: "coreserv.member.open_subaccount", version: "1.0.0" },
      stepId: "continue_to_review",
      condition: "supervisor_override",
      reason: "Condition supervisor_override needs a person",
      inputs: { memberId: "***77", openingDeposit: "[financial]" },
      allowedResponses: ["claim", "abort", "return"],
    });
    expect(readFileSync(request.screenshot, "utf8")).toBe("fake-surface");
  });

  it("records what the person did by role and name, never the value typed", async () => {
    const t: ReturnType<typeof setup> = setup(
      new ScriptedChannel(async (q) => {
        if (q.answers.includes("claim")) return "claim";
        await t.surface.actAsHuman(beside("Override Code"), {
          kind: "fill",
          value: "secret-code-9",
        });
        await t.surface.actAsHuman(named("button", "Authorize"), { kind: "click" });
        return "return";
      }),
    );
    await t.handoff.takeover("takeover", context);
    const human = t.events().filter((e) => e.event === "human_action");
    expect(human).toEqual([
      expect.objectContaining({ kind: "change", role: "textbox", intervention: "run1-i1" }),
      expect.objectContaining({ kind: "click", role: "button", name: "Authorize" }),
    ]);
    const saved = readFileSync(join(t.runDir, "interventions", "1.actions.json"), "utf8");
    expect(JSON.parse(saved)).toHaveLength(2);
    expect(saved + t.lines.join("\n")).not.toContain("secret-code-9");
  });

  it("notices when the person clicks a commit control", async () => {
    const t: ReturnType<typeof setup> = setup(
      new ScriptedChannel(async (q) => {
        if (q.answers.includes("claim")) return "claim";
        await t.surface.actAsHuman(named("button", "Authorize"), { kind: "click" });
        await t.surface.actAsHuman(named("button", "Confirm"), { kind: "click" });
        return "return";
      }),
    );
    expect(await t.handoff.takeover("takeover", context)).toMatchObject({ humanCommitted: true });
  });

  it("fails when nobody claims the session in time, leaving nobody in control", async () => {
    const t = setup(answers(undefined));
    expect(await t.handoff.takeover("takeover", context)).toEqual({ resolution: "timeout" });
    expect(t.handoff.state).toBe("FAILED");
    expect(t.control.controller).toBe("none");
    expect(t.states()).toEqual(["PAUSING", "AWAITING_HUMAN", "FAILED"]);
    expect(t.handoff.interventions[0]).toMatchObject({ resolution: "timeout" });
  });

  it("fails on abort, before claiming or while in control", async () => {
    const before = setup(answers("abort"));
    expect(await before.handoff.takeover("takeover", context)).toEqual({ resolution: "aborted" });
    expect(before.handoff.state).toBe("FAILED");

    const during = setup(answers("claim", "abort"));
    expect(await during.handoff.takeover("takeover", context)).toEqual({ resolution: "aborted" });
    expect(during.handoff.state).toBe("FAILED");
    expect(during.control.controller).toBe("none");
    expect(during.states()).toEqual(["PAUSING", "AWAITING_HUMAN", "HUMAN_ACTIVE", "FAILED"]);
  });

  it("times out a person who never returns control", async () => {
    const t = setup(answers("claim", undefined));
    expect(await t.handoff.takeover("takeover", context)).toEqual({ resolution: "timeout" });
    expect(t.handoff.state).toBe("FAILED");
  });

  it("approves without ever giving the session to a person", async () => {
    const t = setup(answers("approve"));
    const startEpoch = t.control.epoch;
    expect(await t.handoff.approval({ ...context, stepId: "confirm" })).toBe("approve");
    expect(t.states()).toEqual(["PAUSING", "AWAITING_HUMAN", "AUTOMATION_ACTIVE"]);
    expect(t.control.controller).toBe("automation");
    expect(t.control.epoch).toBe(startEpoch + 2);

    const denied = setup(answers("deny"));
    expect(await denied.handoff.approval({ ...context, stepId: "confirm" })).toBe("deny");
    expect(denied.handoff.state).toBe("FAILED");
  });

  it("passes an unknown-outcome verdict back with control", async () => {
    const t = setup(answers("claim", "committed"));
    expect(await t.handoff.takeover("unknown_outcome", context)).toEqual({
      resolution: "returned",
      answer: "committed",
      humanCommitted: false,
    });
    const declined = setup(answers("cant_tell"));
    expect(await declined.handoff.takeover("unknown_outcome", context)).toEqual({
      resolution: "declined",
    });
  });

  it("refuses an action planned before a handoff, after control comes back", async () => {
    const t = setup(answers("claim", "return"));
    const planned = {
      epoch: t.executor.epoch,
      stepId: "s",
      intent: "test",
      action: "click" as const,
      targetName: "authorize",
      target: named("button", "Authorize"),
      risk: "read" as const,
      timeoutMs: 0,
    };
    await t.handoff.takeover("takeover", context);
    expect(await t.executor.perform(planned)).toMatchObject({ status: "denied", rule: "control" });
    expect(t.surface.actions).toHaveLength(0);
    expect(await t.executor.perform({ ...planned, epoch: t.executor.epoch })).toMatchObject({
      status: "done",
    });
  });

  it("refuses actions while the person is in control", async () => {
    let refused: unknown;
    const t: ReturnType<typeof setup> = setup(
      new ScriptedChannel(async (q) => {
        if (q.answers.includes("claim")) return "claim";
        refused = await t.executor.perform({
          epoch: t.executor.epoch,
          stepId: "s",
          intent: "automation trying to act during a takeover",
          action: "click",
          targetName: "authorize",
          target: named("button", "Authorize"),
          risk: "read",
          timeoutMs: 0,
        });
        return "return";
      }),
    );
    await t.handoff.takeover("takeover", context);
    expect(refused).toMatchObject({ status: "denied", rule: "control" });
  });

  it("does not start a new handoff from FAILED", async () => {
    const t = setup(answers(undefined));
    await t.handoff.takeover("takeover", context);
    await expect(t.handoff.takeover("takeover", context)).rejects.toThrow(
      "Handoff cannot move from FAILED to PAUSING",
    );
  });
});
