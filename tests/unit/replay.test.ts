import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Artifact } from "../../src/artifact/schema.ts";
import { RunLog } from "../../src/evidence/run-log.ts";
import { ControlState } from "../../src/executor/control.ts";
import { GuardedExecutor } from "../../src/executor/guarded-executor.ts";
import { ReplayResultSchema } from "../../src/outcome/result.ts";
import type { Profile, Tenant } from "../../src/profile/schema.ts";
import { replay } from "../../src/replay/interpreter.ts";
import { fakeCoreServ, fakeElement, type FakeCoreServOptions } from "../support/fake-coreserv.ts";
import {
  coreservProfile,
  lakeside,
  lookupArtifact,
  tempDir,
  withTimeouts,
} from "../support/fixtures.ts";

const BALANCES = { "10042": "$2,480.17", "10077": "$15,902.66" };
const SECRETS = { operatorId: "teller01", password: "fake-pass-31" };

async function run(
  memberId: string,
  options: {
    app?: Partial<FakeCoreServOptions>;
    artifact?: (a: Artifact) => Artifact;
    tenant?: (t: Tenant) => Tenant;
    profile?: (p: Profile) => Profile;
  } = {},
) {
  const artifact = (options.artifact ?? ((a) => a))(withTimeouts(await lookupArtifact(), 150));
  const tenant = (options.tenant ?? ((t) => t))(await lakeside());
  const profile = (options.profile ?? ((p) => p))(await coreservProfile());
  const surface = fakeCoreServ({ balances: BALANCES, ...options.app });
  const lines: string[] = [];
  const log = new RunLog((line) => lines.push(line), [{ value: memberId, replacement: "***" }]);
  const executor = new GuardedExecutor({
    surface,
    policy: tenant.policy,
    control: new ControlState(),
    log,
    masks: [],
    runDir: tempDir(),
  });
  const result = await replay({
    runId: "test-run",
    artifact,
    inputs: { memberId },
    profile,
    tenant,
    secrets: SECRETS,
    executor,
    log,
    logPath: "run.jsonl",
  });
  // Every result, on every path, must satisfy the published contract.
  ReplayResultSchema.parse(result);
  return { result, surface, lines };
}

describe("replay: lookup_balance against the fake surface", () => {
  it("returns the typed balance for whichever member is passed in", async () => {
    const first = await run("10077");
    expect(first.result).toMatchObject({
      status: "success",
      stepsCompleted: 5,
      outputs: { savingsBalance: { amount: "15902.66", currency: "USD" } },
      warnings: [],
    });
    const second = await run("10042");
    expect(second.result).toMatchObject({
      status: "success",
      outputs: { savingsBalance: { amount: "2480.17", currency: "USD" } },
    });
    expect(second.surface.actions.map((a) => a.action)).toEqual([
      { kind: "click" },
      { kind: "fill", value: "10042" },
      { kind: "click" },
      { kind: "click" },
    ]);
  });

  it("keeps the member number and the balance out of the log", async () => {
    const { lines } = await run("10077");
    const text = lines.join("\n");
    expect(text).not.toContain("10077");
    expect(text).not.toContain("15902.66");
    expect(text).toContain("{{inputs.memberId}}");
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      event: "run_end",
      outputs: { savingsBalance: "[financial]" },
    });
  });

  it("rejects invalid input before touching the application", async () => {
    const { result, surface } = await run("77");
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 0,
      failure: {
        category: "invalid_input",
        stepId: "validate_inputs",
        sideEffects: "none",
        safeToRetry: false,
      },
    });
    expect(surface.actions).toHaveLength(0);
  });

  it("is denied at preflight when tenant policy does not cover its requirements", async () => {
    const { result, surface } = await run("10077", {
      tenant: (t) => ({ ...t, policy: { ...t.policy, actions: ["click", "extract"] } }),
    });
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "policy_denied", stepId: "preflight" },
    });
    expect(surface.actions).toHaveLength(0);
  });

  it("fails with target_ambiguous rather than choosing between two matches", async () => {
    const { result } = await run("10077", {
      app: { extra: { inquiry: [fakeElement(["workarea"], "button", "Search", 300, 60)] } },
    });
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 2,
      failure: {
        category: "target_ambiguous",
        stepId: "search",
        intent: "Run the search",
        safeToRetry: false,
      },
    });
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.failure.observed).toContain("2 elements matched");
    expect(existsSync(result.failure.evidence!.screenshot!)).toBe(true);
    expect(
      JSON.parse(readFileSync(result.failure.evidence!.observation, "utf8")).elements.length,
    ).toBeGreaterThan(0);
  });

  it("fails with target_unresolved when a control is gone", async () => {
    const { result } = await run("10077", {
      artifact: (a) => ({
        ...a,
        targets: {
          ...a.targets,
          search_button: {
            ...a.targets.search_button!,
            strategies: [{ kind: "role_name", name: "Find" }],
          },
        },
      }),
    });
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "target_unresolved", stepId: "search" },
    });
  });

  it("continues on a fallback strategy and records a locator_fallback warning", async () => {
    const { result } = await run("10077", {
      artifact: (a) => ({
        ...a,
        targets: {
          ...a.targets,
          search_button: {
            ...a.targets.search_button!,
            strategies: [
              { kind: "role_name", name: "Find" },
              { kind: "role_name", name: "Search" },
            ],
          },
        },
      }),
    });
    expect(result).toMatchObject({
      status: "success",
      warnings: [{ kind: "locator_fallback", stepId: "search" }],
    });
  });

  it("fails with unexpected_state, naming what it checked, when no known state appears", async () => {
    const { result } = await run("99999", { artifact: (a) => ({ ...a, outcomes: [] }) });
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 2,
      failure: { category: "unexpected_state", stepId: "search", safeToRetry: true },
    });
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.failure.observed).toBe(
      "No known state appeared; checked condition system_notice, condition session_expired, " +
        "condition app_error, condition supervisor_override, condition password_expiry_alert, " +
        "expected state; the expected target matches nothing on the screen",
    );
  });

  it("fails with extraction_invalid when the balance does not parse as money", async () => {
    const { result } = await run("10077", { app: { balances: { "10077": "Unavailable" } } });
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "extraction_invalid", stepId: "read_balance" },
    });
  });

  it("fails the checkpoint when the profile shown is not the member asked for", async () => {
    const { result } = await run("10077", { app: { profileShows: "10042" } });
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 5,
      failure: { category: "unexpected_state", stepId: "checkpoint" },
    });
  });
});

describe("replay: business outcomes", () => {
  it("returns MEMBER_NOT_FOUND as an answer, not a failure", async () => {
    const { result, surface } = await run("99999");
    expect(result).toMatchObject({
      status: "business_outcome",
      stepsCompleted: 2,
      outcome: { code: "MEMBER_NOT_FOUND", atStep: "search" },
    });
    // Nothing after the outcome is attempted.
    expect(surface.actions).toHaveLength(3);
  });

  it("returns PERMISSION_DENIED for a restricted member", async () => {
    const { result } = await run("10200", { app: { restricted: ["10200"] } });
    expect(result).toMatchObject({
      status: "business_outcome",
      stepsCompleted: 3,
      outcome: { code: "PERMISSION_DENIED", atStep: "open_member" },
    });
  });
});

describe("replay: profile conditions", () => {
  const clicks = (surface: Awaited<ReturnType<typeof run>>["surface"]) =>
    surface.actions.filter((a) => a.action.kind === "click").map((a) => a.element.name);

  it("acknowledges a system notice and continues without repeating the step", async () => {
    const { result, surface } = await run("10077", { app: { interrupts: { 2: "notice" } } });
    expect(result).toMatchObject({
      status: "success",
      stepsCompleted: 5,
      outputs: { savingsBalance: { amount: "15902.66", currency: "USD" } },
      recoveries: [{ condition: "system_notice", atStep: "search", attempts: 1 }],
    });
    expect(clicks(surface)).toEqual(["Member Inquiry", "Search", "Acknowledge", "View"]);
  });

  it("stops with recovery_exhausted when a condition keeps returning", async () => {
    const { result } = await run("10077", {
      app: { interrupts: { 2: "notice", 3: "notice", 4: "notice" } },
      // An identical notice follows each one, so the engine waits this long before recounting.
      profile: (p) => ({ ...p, timeouts: { slowLoadMs: 50 } }),
    });
    expect(result).toMatchObject({
      status: "failure",
      recoveries: [{ condition: "system_notice", atStep: "search", attempts: 2 }],
      failure: {
        category: "recovery_exhausted",
        stepId: "search",
        sideEffects: "none",
        safeToRetry: true,
      },
    });
  });

  it("signs in again after session expiry and restarts from the first step", async () => {
    const { result, surface, lines } = await run("10077", {
      app: { interrupts: { 2: "expired" } },
    });
    expect(result).toMatchObject({
      status: "success",
      stepsCompleted: 5,
      outputs: { savingsBalance: { amount: "15902.66", currency: "USD" } },
      recoveries: [{ condition: "session_expired", atStep: "search", attempts: 1 }],
    });
    expect(clicks(surface)).toEqual([
      "Member Inquiry",
      "Search",
      "Sign in again",
      "Sign In",
      "Member Inquiry",
      "Search",
      "View",
    ]);
    const events = lines.map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({ event: "restart", stepId: "search", condition: "session_expired" }),
    );
    expect(lines.join("\n")).not.toContain(SECRETS.password);
  });

  it("does not restart a second time past the profile's bound", async () => {
    const { result } = await run("10077", { app: { interrupts: { 2: "expired", 4: "expired" } } });
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "recovery_exhausted", stepId: "search" },
    });
  });

  it("fails with app_error and masked evidence on the application's error page", async () => {
    const { result } = await run("10077", { app: { interrupts: { 3: "error" } } });
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 3,
      failure: {
        category: "app_error",
        stepId: "open_member",
        observed: "Condition app_error matched",
        sideEffects: "none",
        safeToRetry: true,
      },
    });
    if (result.status !== "failure") throw new Error("unreachable");
    expect(existsSync(result.failure.evidence!.screenshot!)).toBe(true);
  });

  it("explains a missing control by the condition on screen rather than as drift", async () => {
    const { result } = await run("10077", {
      app: { initial: "error" },
      artifact: (a) => ({ ...a, steps: a.steps.slice(1) }),
    });
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "app_error", stepId: "fill_member" },
    });
  });

  it("does not proceed past a condition that needs a human when no operator is available", async () => {
    const { result, surface } = await run("10077", { app: { interrupts: { 2: "override" } } });
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "escalation_timeout", stepId: "search", safeToRetry: true },
    });
    expect(clicks(surface)).toEqual(["Member Inquiry", "Search"]);
  });

  it("succeeds through slow loads and reports them", async () => {
    const { result } = await run("10077", {
      app: { loadMs: 80 },
      profile: (p) => ({ ...p, timeouts: { slowLoadMs: 30 } }),
    });
    expect(result).toMatchObject({ status: "success" });
    expect(result.warnings).toEqual([
      { kind: "slow_load", stepId: "open_inquiry" },
      { kind: "slow_load", stepId: "search" },
      { kind: "slow_load", stepId: "open_member" },
    ]);
  });
});
