// Discovery on the real demo app with a scripted model, then the same run replayed from its
// recorded answers without any model at all.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RecordedProvider } from "../../src/discovery/llm/recorded.ts";
import { CapabilityRequestSchema } from "../../src/discovery/request.ts";
import { runDiscovery } from "../../src/discovery/run.ts";
import { loadTrace } from "../../src/trace/store.ts";
import { OPERATOR, startTestApp } from "../support/demo-app.ts";
import { coreservProfile, lakesideAt, tempDir } from "../support/fixtures.ts";
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

/** A model that reads the real screens the way the fixture's author did. */
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
const extracted = new Set<string>();

async function run(provider: ScriptedProvider | RecordedProvider) {
  extracted.clear();
  return runDiscovery({
    request: request(),
    profile: await coreservProfile(),
    tenant: await lakesideAt(app.url),
    secrets: OPERATOR,
    provider,
    runsDir: tempDir(),
  });
}

describe("discovery against the demo app", () => {
  it("writes a trace with masked evidence, provenance and live-tested locators", async () => {
    const { trace, runDir, tracePath } = await run(new ScriptedProvider((s) => lookupScript(s)));
    expect(trace.end.kind).toBe("finish");
    expect(trace.events.map((e) => e.decision.action)).toEqual([
      "click",
      "fill",
      "click",
      "click",
      "extract",
      "finish",
    ]);
    expect(trace.outputs_bound).toEqual({ savingsBalance: { step: 5 } });

    // What the fixture says by hand, the trace captured live.
    const [open, filled, search, view, read] = trace.events;
    expect(open!.target!.candidates).toContainEqual({
      kind: "role_name",
      name: "Member Inquiry",
      unique: true,
    });
    expect(filled!.target!.candidates).toContainEqual({
      kind: "anchor",
      text: "Member Number",
      relation: "right_of",
      unique: true,
    });
    expect(search!.target!.candidates).toContainEqual({
      kind: "role_name",
      name: "Search",
      unique: true,
    });
    expect(view!.target!.candidates).toContainEqual({
      kind: "table_cell",
      headers: ["Member No", "Action"],
      row: { column: "Member No", equals: "{{inputs.memberId}}" },
      column: "Action",
      unique: true,
    });
    expect(read!.target!.candidates).toContainEqual({
      kind: "table_cell",
      headers: ["Type", "Balance"],
      row: { column: "Type", equals: "Savings" },
      column: "Balance",
      unique: true,
    });
    expect(trace.end.identity).toContainEqual(expect.objectContaining({ input: "memberId" }));

    // Evidence per step, masked; the trace file never holds the member number or the balance.
    expect(existsSync(join(runDir, open!.observation.screenshot!))).toBe(true);
    expect(existsSync(join(runDir, open!.observation.dump!))).toBe(true);
    const saved = readFileSync(tracePath, "utf8");
    expect(saved).not.toContain("10042");
    expect(saved).not.toContain("2,480.17");
    expect(saved).not.toContain(OPERATOR.password);
    const dump = readFileSync(join(runDir, read!.observation.dump!), "utf8");
    expect(dump).not.toContain("2,480.17");
  });

  it("reproduces the run from the recorded answers with no model", async () => {
    const first = await run(new ScriptedProvider((s) => lookupScript(s)));
    const second = await run(RecordedProvider.fromTrace(await loadTrace(first.tracePath)));
    expect(second.trace.end.kind).toBe("finish");
    expect(second.trace.events.map((e) => e.decision)).toEqual(
      first.trace.events.map((e) => e.decision),
    );
  });
});
