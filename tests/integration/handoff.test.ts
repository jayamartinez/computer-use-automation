// The handoff on the real app. A scripted person works in the same live session the automation
// was using: it acts through the surface directly, outside the guarded executor, as a person in
// the browser window would.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Question } from "../../src/handoff/channel.ts";
import { ReplayResultSchema } from "../../src/outcome/result.ts";
import { runReplay } from "../../src/replay/run.ts";
import type { Target } from "../../src/surface/target.ts";
import type { Surface, SurfaceAction } from "../../src/surface/types.ts";
import { OPERATOR, SUPERVISOR, startTestApp } from "../support/demo-app.ts";
import { coreservProfile, lakesideAt, subaccountArtifact, tempDir } from "../support/fixtures.ts";
import { ScriptedChannel } from "../support/scripted-channel.ts";

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await fetch(`${app.url}/__admin/reset`, { method: "POST" });
});

const INPUTS = {
  memberId: "10077",
  accountType: "Certificate",
  nickname: "Big One",
  openingDeposit: "3000.00",
};

const W = ["workarea"];
const button = (name: string): Target => ({
  scope: W,
  role: "button",
  strategies: [{ kind: "role_name", name }],
  rationale: "test",
});
const field = (label: string): Target => ({
  scope: W,
  role: "textbox",
  strategies: [{ kind: "anchor", text: label, relation: "right_of" }],
  rationale: "test",
});

/** A person at the keyboard: acts on whatever is on screen, without the executor. */
function person(surface: () => Surface) {
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 5_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("The person did not see the screen they expected");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return {
    until,
    sees: (text: string) => until(() => surface().matches({ scope: W, textPresent: text })),
    act: async (target: Target, action: SurfaceAction = { kind: "click" }) => {
      await until(async () => (await surface().resolve(target)).kind === "unique");
      const found = await surface().resolve(target);
      if (found.kind !== "unique") throw new Error("not unique");
      await surface().act(found.handle, action);
    },
  };
}

type Script = (question: Question, you: ReturnType<typeof person>) => Promise<string | undefined>;

async function run(
  script: Script,
  options: { inputs?: Record<string, string>; approved?: boolean; fault?: object } = {},
) {
  let live: Surface | undefined;
  const you = person(() => live!);
  const channel = new ScriptedChannel((question) => script(question, you));
  if (options.fault) {
    await fetch(`${app.url}/__admin/faults`, {
      method: "POST",
      body: JSON.stringify(options.fault),
    });
  }
  const artifact = await subaccountArtifact();
  const approved = options.approved ?? true;
  const result = await runReplay({
    artifact: approved ? { ...artifact, status: "approved" } : artifact,
    inputs: options.inputs ?? INPUTS,
    profile: await coreservProfile(),
    tenant: await lakesideAt(app.url),
    secrets: OPERATOR,
    runsDir: tempDir(),
    headed: false,
    allowIrreversible: approved,
    channel,
    onSurface: (surface) => {
      live = surface;
    },
  });
  ReplayResultSchema.parse(result);
  const log = readFileSync(result.log, "utf8");
  const events = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { result, log, events, channel, runDir: dirname(result.log) };
}

const clicks = (events: Record<string, unknown>[], stepId: string) =>
  events.filter((e) => e.event === "action" && e.stepId === stepId).length;

describe("handoff on the real demo app: supervisor override", () => {
  it("pauses, lets a person authorize in the same session, then resumes and completes", async () => {
    const { result, log, events, runDir } = await run(async (question, you) => {
      if (question.answers.includes("claim")) return "claim";
      await you.sees("Teller limit exceeded");
      await you.act(field("Supervisor ID"), { kind: "fill", value: SUPERVISOR.id });
      await you.act(field("Override Code"), { kind: "fill", value: SUPERVISOR.code });
      await you.act(button("Authorize"));
      await you.sees("Pending Transaction");
      return "return";
    });

    expect(result).toMatchObject({
      status: "success",
      stepsCompleted: 13,
      outputs: { newAccountNumber: "4000-10077-03" },
      interventions: [{ kind: "takeover", resolution: "returned" }],
    });

    // The request carries capability, step, reason and a masked screenshot.
    const request = JSON.parse(readFileSync(join(runDir, "interventions", "1.json"), "utf8"));
    expect(request).toMatchObject({
      kind: "takeover",
      capability: { id: "coreserv.member.open_subaccount" },
      stepId: "continue_to_review",
      condition: "supervisor_override",
      reason: "Condition supervisor_override needs a person",
      inputs: { memberId: "***77", openingDeposit: "[financial]", nickname: "Big One" },
    });
    expect(readFileSync(request.screenshot).subarray(1, 4).toString()).toBe("PNG");

    // Ownership moved out and back on the same session, and Continue was clicked only once.
    expect(events.filter((e) => e.event === "handoff_state").map((e) => e.to)).toEqual([
      "PAUSING",
      "AWAITING_HUMAN",
      "HUMAN_ACTIVE",
      "RESYNC",
      "AUTOMATION_ACTIVE",
    ]);
    expect(clicks(events, "continue_to_review")).toBe(1);

    // What the person did is recorded by control, never by value.
    const human = events.filter((e) => e.event === "human_action");
    expect(human.map((e) => `${e.kind}:${e.role}:${e.name}`)).toEqual(
      expect.arrayContaining([
        "change:textbox:Supervisor ID",
        "change:textbox:Override Code",
        "click:button:Authorize",
      ]),
    );
    // Automation's own clicks, before and after the takeover, are never attributed to the person.
    for (const automated of ["Search", "Continue", "Confirm", "Open Sub-Account"]) {
      expect(human.some((e) => e.name === automated)).toBe(false);
    }
    expect(human.every((e) => e.intervention === request.id)).toBe(true);
    expect(existsSync(join(runDir, "interventions", "1.actions.json"))).toBe(true);
    for (const value of [SUPERVISOR.code, SUPERVISOR.id, "10077", OPERATOR.password]) {
      expect(log).not.toContain(value);
    }
  });

  it("does not run Continue again when the person cancels the override and returns", async () => {
    const { result, events } = await run(async (question, you) => {
      if (question.answers.includes("claim")) return "claim";
      await you.sees("Teller limit exceeded");
      await you.act(button("Cancel"));
      await you.sees("Complete the fields below");
      return "return";
    });
    expect(result).toMatchObject({
      status: "failure",
      failure: {
        category: "unexpected_state",
        stepId: "continue_to_review",
        sideEffects: "none",
        outputsVerified: false,
      },
      interventions: [{ kind: "takeover", resolution: "returned" }],
    });
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.failure.observed).toContain("not run again");
    expect(clicks(events, "continue_to_review")).toBe(1);
    expect(events.filter((e) => e.event === "handoff_state").at(-1)?.to).toBe("FAILED");
  });

  it("stops with aborted_by_human when the person aborts", async () => {
    const { result } = await run(async (question) =>
      question.answers.includes("claim") ? "claim" : "abort",
    );
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "aborted_by_human", sideEffects: "none", safeToRetry: false },
      interventions: [{ kind: "takeover", resolution: "abort" }],
    });
  });

  it("fails with escalation_timeout when nobody claims the session", async () => {
    const { result } = await run(async () => undefined);
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "escalation_timeout", stepId: "continue_to_review" },
      interventions: [{ kind: "takeover", resolution: "timeout" }],
    });
  });
});

describe("handoff on the real demo app: approval and unknown outcome", () => {
  const small = { ...INPUTS, openingDeposit: "500.00" };

  it("asks before Confirm for a draft artifact and runs it once approved", async () => {
    const { result, events, channel } = await run(async () => "approve", {
      inputs: small,
      approved: false,
    });
    expect(result).toMatchObject({
      status: "success",
      interventions: [{ kind: "approval", resolution: "approve" }],
    });
    expect(channel.asked[0]?.prompt).toContain("draft");
    // Control changed hands for the approval, so the pre-commit read-back ran again first.
    const order = events.map((e) => `${e.event}:${e.stepId ?? ""}`);
    expect(order.indexOf("reassert:confirm")).toBeLessThan(
      order.indexOf("dispatch_irreversible:confirm"),
    );
  });

  it("dispatches nothing when the approver denies", async () => {
    const { result, events } = await run(async () => "deny", { inputs: small, approved: false });
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "aborted_by_human", stepId: "confirm", sideEffects: "none" },
    });
    expect(events.some((e) => e.event === "dispatch_irreversible")).toBe(false);
  });

  it("records a committed verdict as a failure with committed side effects", async () => {
    const { result, events } = await run(
      async (question, you) => {
        if (question.answers.includes("claim")) return "claim";
        // The person checks the member's accounts in the same session.
        await you.act({
          scope: ["nav"],
          role: "link",
          strategies: [{ kind: "role_name", name: "Member Inquiry" }],
          rationale: "test",
        });
        await you.act(field("Member Number"), { kind: "fill", value: "10077" });
        await you.act(button("Search"));
        await you.act({
          scope: W,
          role: "link",
          strategies: [{ kind: "role_name", name: "View" }],
          rationale: "test",
        });
        await you.sees("4000-10077-03");
        return "committed";
      },
      { inputs: small, fault: { commitThen500: true } },
    );
    expect(result).toMatchObject({
      status: "failure",
      failure: {
        category: "app_error",
        stepId: "confirm",
        sideEffects: "committed",
        safeToRetry: false,
        outputsVerified: false,
      },
      interventions: [{ kind: "unknown_outcome", resolution: "committed" }],
    });
    expect(clicks(events, "confirm")).toBe(1);
  });

  it("keeps outcome_unknown when the person cannot tell", async () => {
    const { result } = await run(async () => "cant_tell", {
      inputs: small,
      fault: { commitThen500: true },
    });
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "outcome_unknown", sideEffects: "possible", safeToRetry: false },
      interventions: [{ kind: "unknown_outcome", resolution: "cant_tell" }],
    });
  });

  it("records a not-committed verdict without side effects", async () => {
    const { result } = await run(
      async (question) => (question.answers.includes("claim") ? "claim" : "not_committed"),
      { inputs: small, fault: { commitThen500: true } },
    );
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "app_error", sideEffects: "none", safeToRetry: true },
    });
  });
});
