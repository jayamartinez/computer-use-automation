import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Artifact } from "../../src/artifact/schema.ts";
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

async function run(memberId: string, artifact?: Artifact) {
  const result = await runReplay({
    artifact: artifact ?? (await lookupArtifact()),
    inputs: { memberId },
    profile: await coreservProfile(),
    tenant: await lakesideAt(app.url),
    secrets: OPERATOR,
    runsDir: tempDir(),
  });
  ReplayResultSchema.parse(result);
  return { result, log: readFileSync(result.log, "utf8") };
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
    expect(observation).not.toMatch(/4000-10077/);
  });

  it("refuses invalid input without opening a browser session on the app", async () => {
    const { result, log } = await run("1007");
    expect(result).toMatchObject({ status: "failure", failure: { category: "invalid_input" } });
    expect(log).not.toContain('"event":"action"');
  });
});
