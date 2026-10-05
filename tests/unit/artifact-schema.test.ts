import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ArtifactSchema } from "../../src/artifact/schema.ts";
import { ArtifactError, contentHash, parseArtifact } from "../../src/artifact/store.ts";
import { render, renderDeep } from "../../src/artifact/template.ts";
import { ReplayResultSchema } from "../../src/outcome/result.ts";
import { resolveSecrets } from "../../src/profile/load.ts";
import { coreservProfile, FIXTURE_PATH, lakeside, lookupArtifact } from "../support/fixtures.ts";

// A fresh, mutable copy of the fixture for each rejection case.
const draft = () => JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
const messages = (data: unknown): string =>
  ArtifactSchema.safeParse(data)
    .error?.issues.map((i) => i.message)
    .join("\n") ?? "";

describe("artifact schema", () => {
  it("accepts the hand-written lookup fixture and its content hash", async () => {
    const artifact = await lookupArtifact();
    expect(artifact.id).toBe("coreserv.member.lookup_balance");
    expect(artifact.steps.map((s) => s.id)).toEqual([
      "open_inquiry",
      "fill_member",
      "search",
      "open_member",
      "read_balance",
    ]);
  });

  it("rejects a step that references an unknown target", () => {
    const data = draft();
    data.steps[2].target = "find_button";
    expect(messages(data)).toContain('Unknown target reference "find_button"');
  });

  it("rejects a template that is not a declared input", () => {
    const data = draft();
    data.steps[1].value = "{{inputs.accountId}}";
    expect(messages(data)).toContain("{{inputs.accountId}} is not a declared input");
  });

  it("rejects a secret reference anywhere in an artifact", () => {
    const data = draft();
    data.steps[1].value = "{{secrets.password}}";
    expect(messages(data)).toContain("{{secrets.password}} is not a declared input");
  });

  it("rejects an irreversible step that could be retried", () => {
    const data = draft();
    Object.assign(data.steps[2], { risk: "irreversible", retry: { max: 1 } });
    data.requires.maxRisk = "irreversible";
    const text = messages(data);
    expect(text).toContain("must never be retried");
    expect(text).toContain('onTimeout: "outcome_unknown"');
  });

  it("rejects an output that no extract step produces", () => {
    const data = draft();
    data.outputs.checkingBalance = { ...data.outputs.savingsBalance, fromStep: "search" };
    expect(messages(data)).toContain('Output "checkingBalance" has no extract step');
  });

  it("rejects `requires` that understates what the steps do", () => {
    const data = draft();
    data.requires = { actions: ["click", "extract"], maxRisk: "read", frames: ["workarea"] };
    const text = messages(data);
    expect(text).toContain('undeclared action "fill"');
    expect(text).toContain("exceeds declared maxRisk");
    expect(text).toContain('undeclared frame "nav"');
  });

  it("rejects locator kinds outside the three semantic ones", () => {
    const data = draft();
    data.targets.search_button.strategies = [{ kind: "css", selector: "input[type=submit]" }];
    expect(ArtifactSchema.safeParse(data).success).toBe(false);
  });

  it("detects content edited after the hash was stamped", () => {
    const data = draft();
    data.steps[0].timeoutMs = 1;
    expect(() => parseArtifact(data)).toThrow(ArtifactError);
    expect(() => parseArtifact(data)).toThrow(/does not match its contentHash/);
  });

  it("keeps the hash stable across approval", async () => {
    const artifact = await lookupArtifact();
    expect(contentHash({ ...artifact, status: "approved" })).toBe(artifact.contentHash);
    expect(parseArtifact({ ...artifact, status: "approved" }).status).toBe("approved");
  });
});

describe("templating", () => {
  it("renders declared references and refuses unknown ones", () => {
    expect(render("{{inputs.memberId}}", { inputs: { memberId: "10077" } })).toBe("10077");
    expect(() => render("{{inputs.other}}", { inputs: {} })).toThrow(/Unknown template/);
  });

  it("renders strings nested inside a target", () => {
    const row = { column: "Member No", equals: "{{inputs.memberId}}" };
    expect(renderDeep({ row }, { inputs: { memberId: "10042" } }).row.equals).toBe("10042");
  });
});

describe("profile and tenant binding", () => {
  it("validates the CoreServ profile and the lakeside binding", async () => {
    const profile = await coreservProfile();
    const tenant = await lakeside();
    expect(profile.conditions.map((c) => c.disposition)).toEqual([
      "recover",
      "recover",
      "fail",
      "escalate",
    ]);
    expect(tenant.policy.denyPaths).toContain("/__admin/");
  });

  it("resolves credentials from the environment and never from the file", async () => {
    const tenant = await lakeside();
    expect(JSON.stringify(tenant)).not.toMatch(/password":\s*"(?!env:)/);
    expect(() => resolveSecrets(tenant, {})).toThrow(/CORESERV_OPERATOR_ID is not set/);
    expect(
      resolveSecrets(tenant, { CORESERV_OPERATOR_ID: "t", CORESERV_OPERATOR_PASSWORD: "p" }),
    ).toEqual({ operatorId: "t", password: "p" });
  });
});

describe("replay result contract", () => {
  const common = {
    runId: "r1",
    capability: { id: "a.b", version: "1.0.0", contentHash: "sha256:x" },
    tenant: "lakeside",
    durationMs: 1,
    stepsCompleted: 0,
    recoveries: [],
    interventions: [],
    warnings: [],
    log: "runs/r1/run.jsonl",
  };

  it("accepts each of the three statuses and nothing else", () => {
    const money = { amount: "15902.66", currency: "USD" };
    expect(
      ReplayResultSchema.safeParse({ ...common, status: "success", outputs: { b: money } }).success,
    ).toBe(true);
    expect(
      ReplayResultSchema.safeParse({
        ...common,
        status: "business_outcome",
        outcome: { code: "MEMBER_NOT_FOUND", atStep: "search" },
      }).success,
    ).toBe(true);
    expect(
      ReplayResultSchema.safeParse({ ...common, status: "recovered", outputs: {} }).success,
    ).toBe(false);
  });

  it("requires a failure to say what, where and whether a retry is safe", () => {
    const failure = {
      category: "target_unresolved",
      stepId: "search",
      intent: "Run the search",
      expected: "one element",
      observed: "none",
      sideEffects: "none",
      safeToRetry: true,
    };
    expect(ReplayResultSchema.safeParse({ ...common, status: "failure", failure }).success).toBe(
      true,
    );
    const { safeToRetry: _dropped, ...incomplete } = failure;
    expect(
      ReplayResultSchema.safeParse({ ...common, status: "failure", failure: incomplete }).success,
    ).toBe(false);
    expect(
      ReplayResultSchema.safeParse({
        ...common,
        status: "failure",
        failure: { ...failure, category: "oops" },
      }).success,
    ).toBe(false);
  });
});
