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
import { coreservProfile, lakesideAt, lookupArtifact, tempDir } from "../support/fixtures.ts";
import {
  click,
  extract,
  fill,
  finish,
  type Screen,
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
