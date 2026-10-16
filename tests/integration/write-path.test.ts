import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Artifact } from "../../src/artifact/schema.ts";
import { ReplayResultSchema } from "../../src/outcome/result.ts";
import { runReplay } from "../../src/replay/run.ts";
import { OPERATOR, startTestApp } from "../support/demo-app.ts";
import {
  coreservProfile,
  lakesideAt,
  lookupArtifact,
  subaccountArtifact,
  tempDir,
} from "../support/fixtures.ts";

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
// Every test starts from the seed data: opening an account changes the member's balances.
beforeEach(async () => {
  await fetch(`${app.url}/__admin/reset`, { method: "POST" });
});

const INPUTS = {
  memberId: "10077",
  accountType: "Money Market",
  nickname: "Vacation Fund",
  openingDeposit: "500.00",
};

type Options = { artifact?: Artifact; approved?: boolean; allow?: boolean };

async function run(inputs: Record<string, string>, options: Options = {}) {
  const artifact = options.artifact ?? (await subaccountArtifact());
  const result = await runReplay({
    artifact: options.approved ? { ...artifact, status: "approved" } : artifact,
    inputs,
    profile: await coreservProfile(),
    tenant: await lakesideAt(app.url),
    secrets: OPERATOR,
    runsDir: tempDir(),
    allowIrreversible: options.allow ?? false,
  });
  ReplayResultSchema.parse(result);
  const log = readFileSync(result.log, "utf8");
  const events = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { result, log, events };
}

const unattended = { approved: true, allow: true };

/** The member's Savings balance, read by the other capability on a fresh session. */
async function savings(memberId: string): Promise<unknown> {
  const result = await runReplay({
    artifact: await lookupArtifact(),
    inputs: { memberId },
    profile: await coreservProfile(),
    tenant: await lakesideAt(app.url),
    secrets: OPERATOR,
    runsDir: tempDir(),
  });
  return result.status === "success" ? result.outputs.savingsBalance : result;
}

async function setFaults(faults: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${app.url}/__admin/faults`, {
    method: "POST",
    body: JSON.stringify(faults),
  });
  if (!response.ok) throw new Error(await response.text());
}

describe("replay: open_subaccount against the real demo app", () => {
  it("opens a sub-account for an approved artifact run with --allow-irreversible", async () => {
    const { result, log, events } = await run(INPUTS, unattended);
    expect(result).toMatchObject({ status: "success", stepsCompleted: 13, warnings: [] });
    if (result.status !== "success") throw new Error("unreachable");
    expect(result.outputs.newAccountNumber).toBe("4000-10077-03");
    expect(result.outputs.confirmationRef).toMatch(/^OSA-\d{4}-\d{4}$/);

    // The commit is logged as dispatched before the click, and the click happens once.
    const kinds = events.map((e) => `${e.event}:${e.stepId ?? ""}`);
    const dispatched = kinds.indexOf("dispatch_irreversible:confirm");
    expect(dispatched).toBeGreaterThan(-1);
    expect(kinds.indexOf("action:confirm")).toBeGreaterThan(dispatched);
    expect(kinds.filter((k) => k === "action:confirm")).toHaveLength(1);
    expect(kinds).toContain("step_ok:assert_review");

    // Identifiers, amounts and the new account number never reach the log in full.
    for (const value of ["10077", "500.00", "4000-10077-03", OPERATOR.password]) {
      expect(log).not.toContain(value);
    }
    expect(await savings("10077")).toEqual({ amount: "15402.66", currency: "USD" });
  });

  it("returns INSUFFICIENT_FUNDS for a deposit above Savings, with nothing posted", async () => {
    const { result } = await run({ ...INPUTS, openingDeposit: "20000.00" }, unattended);
    expect(result).toMatchObject({
      status: "business_outcome",
      stepsCompleted: 8,
      outcome: { code: "INSUFFICIENT_FUNDS", atStep: "continue_to_review" },
    });
    expect(await savings("10077")).toEqual({ amount: "15902.66", currency: "USD" });
  });

  it("refuses Confirm for a draft artifact even with --allow-irreversible", async () => {
    const { result, events } = await run(INPUTS, { allow: true });
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 10,
      failure: {
        category: "policy_denied",
        stepId: "confirm",
        sideEffects: "none",
        safeToRetry: false,
        outputsVerified: false,
      },
    });
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.failure.observed).toBe(
      "The capability is a draft; it needs an operator to approve the step",
    );
    expect(events.some((e) => e.event === "dispatch_irreversible")).toBe(false);
    expect(await savings("10077")).toEqual({ amount: "15902.66", currency: "USD" });
  });

  it("refuses Confirm for an approved artifact without the caller's explicit flag", async () => {
    const { result } = await run(INPUTS, { approved: true });
    expect(result).toMatchObject({
      status: "failure",
      failure: { category: "policy_denied", stepId: "confirm", sideEffects: "none" },
    });
  });

  it("never repeats Confirm after commitThen500 and reports outcome_unknown", async () => {
    await setFaults({ commitThen500: true });
    try {
      const { result, events } = await run(INPUTS, unattended);
      expect(result).toMatchObject({
        status: "failure",
        stepsCompleted: 10,
        failure: {
          category: "outcome_unknown",
          stepId: "confirm",
          sideEffects: "possible",
          safeToRetry: false,
          outputsVerified: false,
        },
      });
      if (result.status !== "failure") throw new Error("unreachable");
      expect(result.failure.observed).toContain("app_error");
      expect(events.filter((e) => e.event === "action" && e.stepId === "confirm")).toHaveLength(1);
      expect(events.some((e) => e.event === "restart")).toBe(false);
      const screenshot = readFileSync(result.failure.evidence!.screenshot!);
      expect(screenshot.subarray(1, 4).toString()).toBe("PNG");
      expect(readFileSync(result.failure.evidence!.observation, "utf8")).toContain(
        "Application Error",
      );
    } finally {
      await setFaults({ commitThen500: false });
    }
    // The app did commit: the deposit left Savings even though the run could not see it.
    expect(await savings("10077")).toEqual({ amount: "15402.66", currency: "USD" });
  });

  it("does not sign in again and restart when the session expires on Confirm", async () => {
    await setFaults({ expireSession: "confirm" });
    try {
      const { result, events } = await run(INPUTS, unattended);
      expect(result).toMatchObject({
        status: "failure",
        failure: { category: "outcome_unknown", stepId: "confirm", sideEffects: "possible" },
      });
      expect(events.some((e) => e.event === "restart")).toBe(false);
      expect(events.filter((e) => e.event === "action" && e.stepId === "confirm")).toHaveLength(1);
    } finally {
      await setFaults({ expireSession: null });
    }
  });

  it("stops before Confirm when Review does not show what was asked for", async () => {
    const artifact = await subaccountArtifact();
    const mistyped: Artifact = {
      ...artifact,
      steps: artifact.steps.map((step) =>
        step.id === "fill_nickname" && step.action === "fill"
          ? { ...step, value: "Someone Else", expect: { valueEquals: "Someone Else" } }
          : step.id === "assert_review"
            ? { ...step, timeoutMs: 500 }
            : step,
      ),
    };
    const { result, events } = await run(INPUTS, { ...unattended, artifact: mistyped });
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 9,
      failure: {
        category: "unexpected_state",
        stepId: "assert_review",
        sideEffects: "none",
      },
    });
    expect(events.some((e) => e.event === "dispatch_irreversible")).toBe(false);
    expect(await savings("10077")).toEqual({ amount: "15902.66", currency: "USD" });
  });

  it("escalates a deposit above the teller limit; with no operator the run fails safely", async () => {
    const { result } = await run({ ...INPUTS, openingDeposit: "3000.00" }, unattended);
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 8,
      failure: {
        category: "escalation_timeout",
        stepId: "continue_to_review",
        sideEffects: "none",
      },
    });
  });
});
