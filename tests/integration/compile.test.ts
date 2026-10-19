// Trace to artifact on the real demo app: a scripted discovery is compiled, verified with a
// different member, saved, and replayed from the saved file. A locator that depends on the
// discovery member's data must fail verification and never be saved.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contentHash, loadArtifact } from "../../src/artifact/store.ts";
import { compileTrace } from "../../src/compiler/compile.ts";
import { compileAndVerify, verifyArtifact } from "../../src/compiler/verify.ts";
import { CapabilityRequestSchema } from "../../src/discovery/request.ts";
import { runDiscovery } from "../../src/discovery/run.ts";
import { runReplay } from "../../src/replay/run.ts";
import type { Trace } from "../../src/trace/schema.ts";
import { OPERATOR, startTestApp } from "../support/demo-app.ts";
import {
  coreservProfile,
  lakesideAt,
  lookupArtifact,
  subaccountArtifact,
  tempDir,
} from "../support/fixtures.ts";
import { ScriptedChannel } from "../support/scripted-channel.ts";
import {
  click,
  extract,
  fill,
  finish,
  type Screen,
  type ScriptedCall,
  ScriptedProvider,
} from "../support/scripted-provider.ts";

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await fetch(`${app.url}/__admin/reset`, { method: "POST" });
});

const request = () =>
  CapabilityRequestSchema.parse(
    JSON.parse(readFileSync("capabilities/requests/coreserv.member.lookup_balance.json", "utf8")),
  );

const extracted = new Set<string>();
function lookupScript(screen: Screen) {
  const field = screen.fieldLabeled("Member Number");
  if (field && field.value === "") return fill(field.ref, { input: "memberId" });
  if (field) return click(screen.named("button", "Search")!.ref);
  const view = screen.named("link", "View");
  if (view) return click(view.ref);
  if (screen.has("Member Profile")) {
    const savings = screen.withText("cell", "$2,480.17")!;
    const member = screen.withText("cell", "10042")!;
    if (!extracted.has(screen.observation.fingerprint)) {
      extracted.add(screen.observation.fingerprint);
      return extract(savings.ref, "savingsBalance");
    }
    return finish([savings.ref, member.ref]);
  }
  return click(screen.named("link", "Member Inquiry")!.ref);
}

const subaccountRequest = () =>
  CapabilityRequestSchema.parse(
    JSON.parse(readFileSync("capabilities/requests/coreserv.member.open_subaccount.json", "utf8")),
  );

/** A model that opens the sub-account the way the fixture's author did. */
function subaccountScript() {
  const done = new Set<string>();
  const once = (step: string, call: ScriptedCall): ScriptedCall | undefined => {
    if (done.has(step)) return undefined;
    done.add(step);
    return call;
  };
  return (screen: Screen): ScriptedCall | undefined => {
    if (screen.has("Sub-account opened")) {
      const value = (label: string) => screen.fieldLabeled(label, "cell")!.ref;
      return (
        once("account", extract(value("New Account No"), "newAccountNumber")) ??
        once("ref", extract(value("Confirmation Ref"), "confirmationRef")) ??
        finish([value("Member No"), value("New Account No"), value("Confirmation Ref")])
      );
    }
    const confirm = screen.named("button", "Confirm");
    if (confirm) return click(confirm.ref, "commit what Review shows");
    const type = screen.fieldLabeled("Account Type *", "combobox");
    if (type) {
      return (
        once("type", {
          toolName: "select",
          arguments: { ref: type.ref, option: { input: "accountType" }, rationale: "type" },
        }) ??
        once("nickname", fill(screen.fieldLabeled("Nickname *")!.ref, { input: "nickname" })) ??
        once(
          "deposit",
          fill(screen.fieldLabeled("Opening Deposit *")!.ref, { input: "openingDeposit" }),
        ) ??
        click(screen.named("button", "Continue")!.ref)
      );
    }
    const open = screen.named("button", "Open Sub-Account");
    if (open) return click(open.ref);
    const field = screen.fieldLabeled("Member Number");
    if (field && field.value === "") return fill(field.ref, { input: "memberId" });
    if (field) return click(screen.named("button", "Search")!.ref);
    const view = screen.named("link", "View");
    if (view) return click(view.ref);
    return click(screen.named("link", "Member Inquiry")!.ref);
  };
}

async function discoveredTrace(): Promise<Trace> {
  extracted.clear();
  const { trace } = await runDiscovery({
    request: request(),
    profile: await coreservProfile(),
    tenant: await lakesideAt(app.url),
    secrets: OPERATOR,
    provider: new ScriptedProvider((s) => lookupScript(s)),
    runsDir: tempDir(),
  });
  return trace;
}

const env = async () => ({
  profile: await coreservProfile(),
  tenant: await lakesideAt(app.url),
  secrets: OPERATOR,
  runsDir: tempDir(),
});

describe("compiling a discovered trace", () => {
  it("matches the hand-written fixture structurally", async () => {
    const { artifact, report } = compileTrace(await discoveredTrace(), request());
    const fixture = await lookupArtifact();

    expect(artifact.steps.map((s) => s.action)).toEqual(fixture.steps.map((s) => s.action));
    // Each compiled target offers at least the fixture's first strategy kind, and the row
    // key that was the member number is templated, never the discovery value.
    artifact.steps.forEach((step, i) => {
      const expectedStep = fixture.steps[i]!;
      if (!("target" in step) || !("target" in expectedStep)) return;
      const compiled = artifact.targets[step.target]!;
      const expected = fixture.targets[expectedStep.target]!;
      expect(compiled.role).toBe(expected.role);
      expect(compiled.scope).toEqual(expected.scope);
      expect(compiled.strategies.map((s) => s.kind)).toContain(expected.strategies[0]!.kind);
    });
    expect(JSON.stringify(artifact.targets)).toContain('"equals":"{{inputs.memberId}}"');
    // The discovery value appears nowhere in the flow (the declared example is the request's).
    const { targets, steps, checkpoint } = artifact;
    expect(JSON.stringify({ targets, steps, checkpoint })).not.toContain("10042");
    expect(JSON.stringify(targets)).not.toContain("Whitfield");
    expect(artifact.steps[1]).toMatchObject({
      action: "fill",
      value: "{{inputs.memberId}}",
      expect: { valueEquals: "{{inputs.memberId}}" },
    });
    const fillStep = artifact.steps[1]!;
    expect(artifact.steps[0]).toMatchObject({
      expect: { resolvable: "target" in fillStep ? fillStep.target : "" },
    });
    expect(artifact.checkpoint.all).toContainEqual({ outputParsed: "savingsBalance" });
    expect(artifact.checkpoint.all).toContainEqual(
      expect.objectContaining({
        cellEquals: expect.objectContaining({ value: "{{inputs.memberId}}" }),
      }),
    );
    expect(artifact.outputs.savingsBalance!.fromStep).toBe(artifact.steps[4]!.id);
    expect(artifact.requires).toEqual({
      actions: ["click", "fill", "extract"],
      maxRisk: "reversible",
      scopes: ["nav", "workarea"],
    });
    expect(artifact.status).toBe("draft");
    expect(report.flags.map((f) => f.kind)).not.toContain("literal_value");
  });

  it("verifies with a different member, saves, and the saved artifact replays for a third", async () => {
    const outDir = tempDir();
    const outcome = await compileAndVerify(await discoveredTrace(), request(), {
      ...(await env()),
      outDir,
    });
    expect(outcome.verification.status).toBe("success");
    expect(outcome.saved).toBeDefined();
    expect(outcome.artifact.provenance.verifiedWith).toBeDefined();
    expect(existsSync(outcome.saved!.report)).toBe(true);

    const saved = await loadArtifact(outcome.saved!.artifact);
    const result = await runReplay({
      artifact: saved,
      inputs: { memberId: "10042" },
      ...(await env()),
    });
    expect(result).toMatchObject({
      status: "success",
      outputs: { savingsBalance: { amount: "2480.17", currency: "USD" } },
    });
    const notFound = await runReplay({
      artifact: saved,
      inputs: { memberId: "99999" },
      ...(await env()),
    });
    // Outcomes are not discovered yet; an unknown member is a failure until probing adds them.
    expect(notFound.status).toBe("failure");
  });

  it("compiles and verifies open_subaccount with the fixture's locators", async () => {
    const request = subaccountRequest();
    const approver = () => new ScriptedChannel(() => "approve");
    const { trace } = await runDiscovery({
      request,
      profile: await coreservProfile(),
      tenant: await lakesideAt(app.url),
      secrets: OPERATOR,
      provider: new ScriptedProvider(subaccountScript()),
      runsDir: tempDir(),
      channel: approver(),
      headed: false,
    });
    expect(trace.end.kind).toBe("finish");
    // No locator in the trace was erased by the masks, and the only table address is the
    // Results table's: none is keyed on a label/value row.
    const recorded = JSON.stringify(trace.events.map((e) => [e.target, e.readback]));
    expect(recorded).not.toContain("[masked]");
    expect(recorded.match(/"table_cell"/g)).toHaveLength(1);

    const outcome = await compileAndVerify(trace, request, {
      ...(await env()),
      outDir: tempDir(),
      channel: approver(),
      headed: false,
    });
    const { artifact } = outcome;
    const fixture = await subaccountArtifact();
    expect(artifact.steps.map((s) => s.action)).toEqual(fixture.steps.map((s) => s.action));
    // Each compiled target leads with the fixture's strategy. The View link is the exception the
    // lookup test allows too: its role name comes first while one row is shown, and its table
    // address may name a different second header than the hand-written one.
    artifact.steps.forEach((step, i) => {
      const expectedStep = fixture.steps[i]!;
      if (!("target" in step) || !("target" in expectedStep)) return;
      const compiled = artifact.targets[step.target]!;
      const expected = fixture.targets[expectedStep.target]!;
      expect(compiled.role).toBe(expected.role);
      expect(compiled.scope).toEqual(expected.scope);
      if (expected.strategies[0]!.kind === "table_cell") {
        expect(compiled.strategies.map((s) => s.kind)).toContain("table_cell");
      } else {
        expect(compiled.strategies[0], step.id).toEqual(expected.strategies[0]);
      }
    });
    // The read-back before Confirm checks all four inputs, the deposit as an amount, each cell
    // found by the label beside it.
    const assertStep = artifact.steps.find((s) => s.action === "assert")!;
    const check = "check" in assertStep ? assertStep.check : undefined;
    const checks = check && "all" in check ? check.all : [];
    const read = checks.map((c) => {
      if (!("cellEquals" in c)) return undefined;
      const { target, value, as } = c.cellEquals;
      return { strategy: artifact.targets[target]!.strategies[0], value, as };
    });
    expect(read).toEqual(
      [
        ["Member No", "memberId"],
        ["Account Type", "accountType"],
        ["Nickname", "nickname"],
        ["Opening Deposit", "openingDeposit"],
      ].map(([label, input]) => ({
        strategy: { kind: "anchor", text: label, relation: "right_of" },
        value: `{{inputs.${input}}}`,
        as: input === "openingDeposit" ? "money" : undefined,
      })),
    );

    expect(outcome.verification).toMatchObject({
      status: "success",
      outputs: { confirmationRef: expect.stringMatching(/^OSA-\d{4}-\d{4}$/) },
    });
    expect(outcome.saved).toBeDefined();
  });

  it("refuses to save a flow whose locator depends on the discovery member's data", async () => {
    const { artifact } = compileTrace(await discoveredTrace(), request());
    const viewStep = artifact.steps[3]!;
    const viewTarget = "target" in viewStep ? viewStep.target : "";
    // A locator anchored on the discovery member's name resolves for 10042 only.
    const poisoned = {
      ...artifact,
      targets: {
        ...artifact.targets,
        [viewTarget]: {
          ...artifact.targets[viewTarget]!,
          strategies: [
            { kind: "anchor" as const, text: "Dana Whitfield", relation: "same_row" as const },
          ],
        },
      },
    };
    const outDir = tempDir();
    const result = await verifyArtifact(
      { ...poisoned, contentHash: contentHash(poisoned) },
      request(),
      await env(),
    );
    expect(result.status).toBe("failure");
    expect(existsSync(join(outDir, `${request().id}.json`))).toBe(false);
  });
});
