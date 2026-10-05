import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Artifact } from "../../src/artifact/schema.ts";
import type { Profile } from "../../src/profile/schema.ts";
import type { Strategy } from "../../src/surface/target.ts";
import { ReplayResultSchema } from "../../src/outcome/result.ts";
import { runReplay } from "../../src/replay/run.ts";
import { OPERATOR, startTestApp } from "../support/demo-app.ts";
import {
  coreservProfile,
  lakesideAt,
  lookupArtifact,
  tempDir,
  withTimeouts,
} from "../support/fixtures.ts";

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

async function run(memberId: string, artifact?: Artifact, profile?: Profile) {
  const result = await runReplay({
    artifact: artifact ?? (await lookupArtifact()),
    inputs: { memberId },
    profile: profile ?? (await coreservProfile()),
    tenant: await lakesideAt(app.url),
    secrets: OPERATOR,
    runsDir: tempDir(),
  });
  ReplayResultSchema.parse(result);
  return { result, log: readFileSync(result.log, "utf8") };
}

/** A test copy of the artifact whose Search button strategies no longer match the app. */
async function withSearchStrategies(...strategies: Strategy[]): Promise<Artifact> {
  const artifact = withTimeouts(await lookupArtifact(), 600);
  const search = artifact.targets.search_button!;
  return {
    ...artifact,
    targets: { ...artifact.targets, search_button: { ...search, strategies } },
  };
}

async function setFaults(faults: Record<string, number | string | null>): Promise<void> {
  const response = await fetch(`${app.url}/__admin/faults`, {
    method: "POST",
    body: JSON.stringify(faults),
  });
  if (!response.ok) throw new Error(await response.text());
}

describe("replay: lookup_balance against the real demo app", () => {
  it("replays one hand-written artifact for two different members", async () => {
    const first = await run("10077");
    expect(first.result).toMatchObject({
      status: "success",
      stepsCompleted: 5,
      warnings: [],
      outputs: { savingsBalance: { amount: "15902.66", currency: "USD" } },
    });
    const second = await run("10042");
    expect(second.result).toMatchObject({
      status: "success",
      outputs: { savingsBalance: { amount: "2480.17", currency: "USD" } },
    });
    expect(second.result.capability.contentHash).toBe(first.result.capability.contentHash);
  });

  it("logs what it did and why without the password, member number or balance", async () => {
    const { result, log } = await run("10077");
    const events = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((e) => e.event === "action").map((e) => e.stepId)).toEqual([
      "login_1",
      "login_2",
      "login_3",
      "open_inquiry",
      "fill_member",
      "search",
      "open_member",
      "read_balance",
    ]);
    expect(events.find((e) => e.stepId === "open_member")).toMatchObject({
      intent: "Open the member's profile",
      strategy: "table_cell",
      policy: "click:read",
    });
    expect(events.at(-2)).toMatchObject({ event: "checkpoint_ok" });
    for (const secret of [OPERATOR.password, "10077", "15902.66", "15,902.66"]) {
      expect(log).not.toContain(secret);
    }
    // The result saved beside the log is masked too; only the caller gets the real output.
    const saved = readFileSync(result.log.replace("run.jsonl", "result.json"), "utf8");
    expect(saved).toContain("[financial]");
    expect(saved).not.toContain("15902.66");
  });

  it("reports step, expected, observed and masked evidence when a target has drifted", async () => {
    const artifact = withTimeouts(await lookupArtifact(), 600);
    const drifted: Artifact = {
      ...artifact,
      targets: {
        ...artifact.targets,
        savings_balance_cell: {
          ...artifact.targets.savings_balance_cell!,
          strategies: [
            {
              kind: "table_cell",
              headers: ["Type", "Balance"],
              row: { column: "Type", equals: "Share Savings" },
              column: "Balance",
            },
          ],
        },
      },
    };
    const { result } = await run("10077", drifted);
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 3,
      failure: {
        category: "unexpected_state",
        stepId: "open_member",
        intent: "Open the member's profile",
        sideEffects: "none",
        safeToRetry: true,
      },
    });
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.failure.expected).toContain("savings_balance_cell");
    expect(readFileSync(result.failure.evidence!.screenshot).subarray(1, 4).toString()).toBe("PNG");
    // The profile screen was captured, with the account numbers masked out of the dump.
    const observation = readFileSync(result.failure.evidence!.observation, "utf8");
    expect(observation).toContain("Member Profile");
    // Account numbers, balances and the member's name are masked; labels and types stay readable.
    for (const sensitive of ["4000-10077", "15,902.66", "4,210.05", "Oyelaran", "Marcus"]) {
      expect(observation).not.toContain(sensitive);
    }
    for (const kept of ["Account No", "Balance", "Savings", "Checking"]) {
      expect(observation).toContain(kept);
    }
  });

  it("refuses invalid input without opening a browser session on the app", async () => {
    const { result, log } = await run("1007");
    expect(result).toMatchObject({ status: "failure", failure: { category: "invalid_input" } });
    expect(log).not.toContain('"event":"action"');
  });
});

describe("replay: exceptional states against the real demo app", () => {
  it("returns MEMBER_NOT_FOUND for a member that does not exist", async () => {
    const { result } = await run("99999");
    expect(result).toMatchObject({
      status: "business_outcome",
      stepsCompleted: 2,
      outcome: { code: "MEMBER_NOT_FOUND", atStep: "search" },
    });
  });

  it("returns PERMISSION_DENIED for an employee account", async () => {
    const { result } = await run("10200");
    expect(result).toMatchObject({
      status: "business_outcome",
      stepsCompleted: 3,
      outcome: { code: "PERMISSION_DENIED", atStep: "open_member" },
    });
  });

  it("fails with target_unresolved when a relabeled control has no other strategy", async () => {
    const { result } = await run(
      "10077",
      await withSearchStrategies({ kind: "role_name", name: "Find" }),
    );
    expect(result).toMatchObject({
      status: "failure",
      stepsCompleted: 2,
      failure: {
        category: "target_unresolved",
        stepId: "search",
        sideEffects: "none",
        safeToRetry: false,
      },
    });
  });

  it("succeeds on a second strategy and records a locator_fallback warning", async () => {
    const artifact = await withSearchStrategies(
      { kind: "role_name", name: "Find" },
      { kind: "role_name", name: "Search" },
    );
    const { result } = await run("10077", artifact);
    expect(result).toMatchObject({
      status: "success",
      outputs: { savingsBalance: { amount: "15902.66", currency: "USD" } },
      warnings: [{ kind: "locator_fallback", stepId: "search" }],
    });
  });

  it("resolves every target through injected latency and reports slow loads", async () => {
    const profile = await coreservProfile();
    await setFaults({ latencyMs: 300 });
    try {
      const { result } = await run("10077", undefined, {
        ...profile,
        timeouts: { slowLoadMs: 200 },
      });
      expect(result).toMatchObject({
        status: "success",
        outputs: { savingsBalance: { amount: "15902.66", currency: "USD" } },
      });
      expect(result.warnings.map((w) => w.stepId)).toEqual([
        "open_inquiry",
        "search",
        "open_member",
      ]);
      expect(result.warnings.every((w) => w.kind === "slow_load")).toBe(true);
    } finally {
      await setFaults({ latencyMs: 0 });
    }
  });
});

describe("replay: profile conditions against the real demo app", () => {
  const clearFaults = () =>
    setFaults({ latencyMs: 0, notice: null, expireSession: null, error500: null });

  it("acknowledges a system notice and reports one recovery", async () => {
    await setFaults({ notice: "search" });
    try {
      const { result, log } = await run("10077");
      expect(result).toMatchObject({
        status: "success",
        stepsCompleted: 5,
        outputs: { savingsBalance: { amount: "15902.66", currency: "USD" } },
        recoveries: [{ condition: "system_notice", atStep: "search", attempts: 1 }],
      });
      // The Search click was dispatched once; Acknowledge carried it through.
      const actions = log.split("\n").filter((line) => line.includes('"event":"action"'));
      expect(actions.filter((line) => line.includes('"stepId":"search"'))).toHaveLength(2);
      expect(actions.some((line) => line.includes("system_notice.handler"))).toBe(true);
    } finally {
      await clearFaults();
    }
  });

  it("signs in again after session expiry, restarts and succeeds", async () => {
    await setFaults({ expireSession: "profile" });
    try {
      const { result, log } = await run("10077");
      expect(result).toMatchObject({
        status: "success",
        stepsCompleted: 5,
        outputs: { savingsBalance: { amount: "15902.66", currency: "USD" } },
        recoveries: [{ condition: "session_expired", atStep: "open_member", attempts: 1 }],
      });
      expect(log).toContain('"event":"restart"');
      expect(log).not.toContain(OPERATOR.password);
    } finally {
      await clearFaults();
    }
  });

  it("fails with app_error, step, expected, observed and a masked screenshot", async () => {
    await setFaults({ error500: "profile" });
    try {
      const { result } = await run("10077");
      expect(result).toMatchObject({
        status: "failure",
        stepsCompleted: 3,
        failure: {
          category: "app_error",
          stepId: "open_member",
          intent: "Open the member's profile",
          expected: "The application to process the request",
          observed: "Condition app_error matched",
          sideEffects: "none",
          safeToRetry: true,
        },
      });
      if (result.status !== "failure") throw new Error("unreachable");
      expect(readFileSync(result.failure.evidence!.screenshot).subarray(1, 4).toString()).toBe(
        "PNG",
      );
      expect(readFileSync(result.failure.evidence!.observation, "utf8")).toContain(
        "Application Error",
      );
    } finally {
      await clearFaults();
    }
  });
});
