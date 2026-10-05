import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Artifact } from "../../src/artifact/schema.ts";
import { RunLog } from "../../src/evidence/run-log.ts";
import { ControlState } from "../../src/executor/control.ts";
import { GuardedExecutor } from "../../src/executor/guarded-executor.ts";
import { ReplayResultSchema } from "../../src/outcome/result.ts";
import type { Tenant } from "../../src/profile/schema.ts";
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

async function run(
  memberId: string,
  options: {
    app?: Partial<FakeCoreServOptions>;
    artifact?: (a: Artifact) => Artifact;
    tenant?: (t: Tenant) => Tenant;
  } = {},
) {
  const artifact = (options.artifact ?? ((a) => a))(withTimeouts(await lookupArtifact(), 150));
  const tenant = (options.tenant ?? ((t) => t))(await lakeside());
  const profile = await coreservProfile();
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
    secrets: {},
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
        safeToRetry: true,
      },
    });
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.failure.observed).toContain("2 elements matched");
    expect(existsSync(result.failure.evidence!.screenshot)).toBe(true);
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

  it("fails with unexpected_state when a step's expected state never appears", async () => {
    const { result } = await run("99999");
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 2,
      failure: { category: "unexpected_state", stepId: "search" },
    });
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
