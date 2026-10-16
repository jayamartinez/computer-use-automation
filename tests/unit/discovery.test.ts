import { describe, expect, it } from "vitest";
import { RecordedProvider } from "../../src/discovery/llm/recorded.ts";
import { discover } from "../../src/discovery/loop.ts";
import { CapabilityRequestSchema, type CapabilityRequest } from "../../src/discovery/request.ts";
import { RunLog } from "../../src/evidence/run-log.ts";
import { ControlState } from "../../src/executor/control.ts";
import { GuardedExecutor } from "../../src/executor/guarded-executor.ts";
import { HandoffController } from "../../src/handoff/controller.ts";
import type { InterventionChannel } from "../../src/handoff/channel.ts";
import { TraceSchema } from "../../src/trace/schema.ts";
import type { DecisionProvider } from "../../src/discovery/llm/provider.ts";
import { fakeCoreServ, fakeElement, type FakeCoreServOptions } from "../support/fake-coreserv.ts";
import { coreservProfile, lakeside, tempDir } from "../support/fixtures.ts";
import { answers, ScriptedChannel } from "../support/scripted-channel.ts";
import {
  click,
  extract,
  fill,
  finish,
  needHuman,
  type Screen,
  ScriptedProvider,
} from "../support/scripted-provider.ts";

const BALANCES = { "10042": "$2,480.17", "10077": "$15,902.66" };
const SECRETS = { operatorId: "teller01", password: "fake-pass-31" };

const REQUEST: CapabilityRequest = CapabilityRequestSchema.parse({
  id: "coreserv.member.lookup_balance",
  goal: "Look up the member and read their Savings balance.",
  description: "Read a member's current savings balance.",
  tenant: "lakeside",
  inputs: {
    memberId: { type: "string", sensitivity: "identifier", value: "10042" },
  },
  outputs: { savingsBalance: { type: "money", currency: "USD", sensitivity: "financial" } },
  verifyInputs: { memberId: "10077" },
  budget: { maxSteps: 12, maxMs: 30_000 },
});

/** The lookup flow as a person reads the screen; `turn` lets a test deviate at one point. */
function lookupScript(screen: Screen) {
  const link = screen.named("link", "Member Inquiry");
  const field = screen.fieldLabeled("Member Number");
  if (field && field.value === "") return fill(field.ref, { input: "memberId" });
  if (field) return click(screen.named("button", "Search")!.ref);
  const view = screen.named("link", "View");
  if (view) return click(view.ref);
  const balance = screen.withText("cell", /^\$/);
  const savings = screen.elements.filter((e) => e.role === "cell" && /^\$/.test(e.text)).at(-1);
  if (savings && !screen.has("Member Number")) {
    const member = screen.withText("cell", "10042");
    return screen.observation.elements.length > 0 && member && balance
      ? extractOrFinish(screen, savings.ref, member.ref)
      : undefined;
  }
  return link ? click(link.ref) : undefined;
}

// Extract once on the profile, then finish with the balance cell and the member cell as proof.
const extractedOnce = new Set<string>();
function extractOrFinish(screen: Screen, savingsRef: string, memberRef: string) {
  if (extractedOnce.has(screen.observation.fingerprint)) return finish([savingsRef, memberRef]);
  extractedOnce.add(screen.observation.fingerprint);
  return extract(savingsRef, "savingsBalance");
}

async function run(
  provider: DecisionProvider,
  options: {
    app?: Partial<FakeCoreServOptions>;
    channel?: InterventionChannel;
    request?: CapabilityRequest;
  } = {},
) {
  extractedOnce.clear();
  const tenant = await lakeside();
  const profile = await coreservProfile();
  const surface = fakeCoreServ({ balances: BALANCES, ...options.app });
  const lines: string[] = [];
  const log = new RunLog((line) => lines.push(line), [{ value: "10042", replacement: "***42" }]);
  const control = new ControlState();
  const runDir = tempDir();
  const executor = new GuardedExecutor({
    surface,
    policy: tenant.policy,
    control,
    log,
    masks: [],
    runDir,
  });
  const handoff = options.channel
    ? new HandoffController({
        runId: "disc",
        runDir,
        capability: { id: REQUEST.id, version: "discovery" },
        inputs: { memberId: "***42" },
        surface,
        control,
        channel: options.channel,
        log,
        masks: [],
        commitControls: profile.risk.commitControls,
        settleMs: 50,
        claimTimeoutMs: 1_000,
        humanTimeoutMs: 1_000,
      })
    : undefined;
  const trace = await discover({
    runId: "disc",
    runDir,
    request: options.request ?? REQUEST,
    profile,
    tenant,
    secrets: SECRETS,
    executor,
    provider,
    log,
    evidence: false,
    ...(handoff ? { handoff } : {}),
  });
  // Every trace, on every path, must satisfy the published schema.
  TraceSchema.parse(trace);
  return { trace, surface, lines, handoff };
}

describe("discovery on the fake surface", () => {
  it("records a complete lookup with provenance and live-tested locators", async () => {
    const provider = new ScriptedProvider((screen) => lookupScript(screen));
    const { trace } = await run(provider);
    expect(trace.end.kind).toBe("finish");
    const decisions = trace.events.map((e) => e.decision.action);
    expect(decisions).toEqual(["click", "fill", "click", "click", "extract", "finish"]);

    // The typed value is an input reference, and the log never saw the value.
    const filled = trace.events.find((e) => e.decision.action === "fill")!;
    expect(filled.decision).toMatchObject({ value: { input: "memberId" } });
    expect(filled.policy).toMatchObject({ risk: "reversible", decision: "allow" });

    // Every acted-on element has at least one strategy that was unique when it was used.
    for (const event of trace.events.filter((e) => e.target)) {
      expect(event.target!.candidates.some((c) => c.unique)).toBe(true);
    }
    // The field with no name is found by its label; the results row by the member's number.
    expect(filled.target!.candidates).toContainEqual({
      kind: "anchor",
      text: "Member Number",
      relation: "right_of",
      unique: true,
    });
    const view = trace.events[3]!;
    expect(view.target!.candidates).toContainEqual({
      headers: ["Member No", "Action"],
      kind: "table_cell",
      row: { column: "Member No", equals: "{{inputs.memberId}}" },
      column: "Action",
      unique: true,
    });
    expect(trace.outputs_bound).toEqual({ savingsBalance: { step: 5 } });
    expect(trace.end.identity).toEqual([
      expect.objectContaining({ input: "memberId", role: "cell" }),
    ]);
    expect(trace.end.evidence).toHaveLength(2);
  });

  it("refuses a literal that equals an input and asks for the reference instead", async () => {
    let turn = 0;
    const provider = new ScriptedProvider((screen) => {
      const field = screen.fieldLabeled("Member Number");
      if (field && field.value === "" && turn++ === 0) return fill(field.ref, { literal: "10042" });
      return lookupScript(screen);
    });
    const { trace } = await run(provider);
    const rejected = trace.events.find((e) => e.result.status === "invalid")!;
    expect(rejected.result.message).toContain('reference it as {input: "memberId"}');
    expect(trace.end.kind).toBe("finish");
  });

  it("replays a recorded trace to the same decisions without a model", async () => {
    const first = await run(new ScriptedProvider((screen) => lookupScript(screen)));
    const second = await run(RecordedProvider.fromTrace(first.trace));
    expect(second.trace.events.map((e) => e.decision)).toEqual(
      first.trace.events.map((e) => e.decision),
    );
    expect(second.trace.end.kind).toBe("finish");
    expect(second.trace.provider).toBe("recorded:disc");
  });

  it("detects the same action on an unchanged screen and ends as stuck without an operator", async () => {
    const provider = new ScriptedProvider((screen) =>
      click(screen.named("link", "Member Inquiry")!.ref),
    );
    const { trace } = await run(provider);
    expect(trace.end).toMatchObject({ kind: "stuck" });
    expect(trace.end.reason).toMatch(/chosen 3 times on an unchanged screen/);
  });

  it("hands a stuck run to a person and carries on after they return", async () => {
    const channel = new ScriptedChannel((q) => (q.answers.includes("claim") ? "claim" : "return"));
    let afterHandoff = false;
    const provider = new ScriptedProvider((screen, _turn, request) => {
      if (request.user.includes("A person took over")) afterHandoff = true;
      if (!afterHandoff) return click(screen.named("link", "Member Inquiry")!.ref);
      return lookupScript(screen);
    });
    const { trace, handoff } = await run(provider, { channel });
    expect(handoff!.interventions).toEqual([
      { id: "disc-i1", kind: "takeover", resolution: "returned" },
    ]);
    expect(channel.asked[0]!.prompt).toContain("chosen 3 times on an unchanged screen");
    expect(trace.end.kind).toBe("finish");
  });

  it("passes the model's own request for a person to the operator", async () => {
    const { trace } = await run(
      new ScriptedProvider(() => needHuman("The screen asks for a supervisor")),
    );
    expect(trace.end).toEqual({ kind: "need_human", reason: "The screen asks for a supervisor" });
  });

  it("does not click a button the profile does not classify without an approval", async () => {
    const app = { extra: { inquiry: [fakeElement(["workarea"], "button", "Reset", 200, 60)] } };
    const provider = new ScriptedProvider((screen) => {
      const reset = screen.named("button", "Reset");
      if (reset && !screen.fieldLabeled("Member Number")?.value) return click(reset.ref);
      return lookupScript(screen);
    });
    const alone = await run(provider, { app });
    const denied = alone.trace.events.find((e) => e.result.status === "denied")!;
    expect(denied.policy).toMatchObject({ rule: "button:unknown", decision: "deny" });
    expect(alone.surface.actions.some((a) => a.element.name === "Reset")).toBe(false);

    let approvedOnce = false;
    const approved = await run(
      new ScriptedProvider((screen) => {
        const reset = screen.named("button", "Reset");
        if (reset && !screen.fieldLabeled("Member Number")?.value && !approvedOnce) {
          approvedOnce = true;
          return click(reset.ref);
        }
        return lookupScript(screen);
      }),
      { app, channel: answers("approve") },
    );
    const clicked = approved.trace.events.find((e) => e.policy?.decision === "approved")!;
    expect(clicked.policy).toMatchObject({ rule: "button:unknown", risk: "reversible" });
    expect(approved.surface.actions.some((a) => a.element.name === "Reset")).toBe(true);
  });

  it("handles a profile condition itself and tells the model what happened", async () => {
    const provider = new ScriptedProvider((screen) => lookupScript(screen));
    const { trace } = await run(provider, { app: { interrupts: { 2: "notice" } } });
    const handled = trace.events.find((e) => e.decision.action === "condition")!;
    expect(handled.decision).toMatchObject({ condition: "system_notice", disposition: "recover" });
    expect(provider.requests.some((r) => r.user.includes('showed "system_notice"'))).toBe(true);
    expect(trace.end.kind).toBe("finish");
  });

  it("stops when the step budget is spent", async () => {
    const request = { ...REQUEST, budget: { maxSteps: 2, maxMs: 30_000 } };
    const { trace } = await run(new ScriptedProvider((screen) => lookupScript(screen)), {
      request,
    });
    expect(trace.end).toEqual({ kind: "budget", reason: "2 decisions used" });
    expect(trace.events).toHaveLength(2);
  });
});
