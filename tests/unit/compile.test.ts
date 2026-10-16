import { describe, expect, it } from "vitest";
import { ArtifactSchema } from "../../src/artifact/schema.ts";
import { CompileError, compileTrace } from "../../src/compiler/compile.ts";
import { CapabilityRequestSchema } from "../../src/discovery/request.ts";
import type { Trace, TraceEvent } from "../../src/trace/schema.ts";

const request = CapabilityRequestSchema.parse({
  id: "coreserv.member.lookup_balance",
  goal: "Look up the member and read their Savings balance.",
  description: "Read a member's current savings balance.",
  tenant: "lakeside",
  inputs: { memberId: { type: "string", sensitivity: "identifier", value: "10042" } },
  outputs: { savingsBalance: { type: "money", currency: "USD", sensitivity: "financial" } },
  verifyInputs: { memberId: "10077" },
});

const W = ["workarea"];
const obs = (n: number) => ({ id: `obs-${n}`, fingerprint: `fp${n}` });
let seq = 0;
const event = (
  partial: Omit<TraceEvent, "seq" | "actor" | "observation"> & { fp?: number },
): TraceEvent => ({
  seq: ++seq,
  actor: "automation",
  observation: obs(partial.fp ?? seq),
  ...partial,
});

/** The lookup as discovery records it, with one detour and one literal. */
function lookupTrace(tweak: (events: TraceEvent[]) => TraceEvent[] = (e) => e): Trace {
  seq = 0;
  const events = tweak([
    event({
      decision: { action: "click", ref: "e7", rationale: "Open member inquiry" },
      policy: { risk: "read", rule: "safe_control", decision: "allow" },
      target: {
        role: "link",
        scope: ["nav"],
        candidates: [{ kind: "role_name", name: "Member Inquiry", unique: true }],
      },
      result: { status: "ok", postFingerprint: "fp2", settleMs: 100 },
    }),
    event({
      decision: {
        action: "fill",
        ref: "e16",
        value: { input: "memberId" },
        rationale: "Enter the member number",
      },
      policy: { risk: "reversible", rule: "fill:reversible", decision: "allow" },
      target: {
        role: "textbox",
        scope: W,
        candidates: [{ kind: "anchor", text: "Member Number", relation: "right_of", unique: true }],
      },
      result: { status: "ok", postFingerprint: "fp2", settleMs: 0 },
    }),
    event({
      decision: { action: "click", ref: "e14", rationale: "Run the search" },
      policy: { risk: "read", rule: "safe_control", decision: "allow" },
      target: {
        role: "button",
        scope: W,
        candidates: [{ kind: "role_name", name: "Search", unique: true }],
      },
      result: { status: "ok", postFingerprint: "fp4", settleMs: 120 },
    }),
    event({
      decision: { action: "click", ref: "e24", rationale: "Open the member's profile" },
      policy: { risk: "read", rule: "safe_control", decision: "allow" },
      target: {
        role: "link",
        scope: W,
        candidates: [
          { kind: "role_name", name: "View", unique: true },
          {
            kind: "table_cell",
            headers: ["Member No", "Action"],
            row: { column: "Member No", equals: "10042" },
            column: "Action",
            unique: true,
          },
          { kind: "anchor", text: "Dana Whitfield 10042", relation: "same_row", unique: true },
        ],
      },
      result: { status: "ok", postFingerprint: "fp5", settleMs: 130 },
    }),
    event({
      decision: {
        action: "extract",
        ref: "e37",
        output: "savingsBalance",
        rationale: "Read the Savings balance",
      },
      policy: { risk: "read", rule: "extract:read", decision: "allow" },
      target: {
        role: "cell",
        scope: W,
        candidates: [
          {
            kind: "table_cell",
            headers: ["Type", "Balance"],
            row: { column: "Type", equals: "Savings" },
            column: "Balance",
            unique: true,
          },
        ],
      },
      result: { status: "ok", extracted: { output: "savingsBalance", parsed: true } },
    }),
    event({
      decision: {
        action: "finish",
        summary: "done",
        evidenceRefs: ["e37", "e30"],
        rationale: "goal met",
      },
      result: { status: "finished" },
    }),
  ]);
  return {
    schemaVersion: 1,
    traceId: "t1",
    capability: request.id,
    goal: request.goal,
    tenant: "lakeside",
    app: { product: "coreserv", version: "7.2" },
    provider: "scripted",
    inputs: { memberId: { type: "string", sensitivity: "identifier" } },
    outputs: { savingsBalance: { type: "money", sensitivity: "financial" } },
    startedAt: "2026-10-15T00:00:00.000Z",
    finishedAt: "2026-10-15T00:01:00.000Z",
    events,
    end: {
      kind: "finish",
      summary: "done",
      evidence: [
        {
          ref: "e37",
          role: "cell",
          scope: W,
          candidates: [
            {
              kind: "table_cell",
              headers: ["Type", "Balance"],
              row: { column: "Type", equals: "Savings" },
              column: "Balance",
              unique: true,
            },
          ],
        },
      ],
      identity: [
        {
          input: "memberId",
          ref: "e30",
          role: "cell",
          scope: W,
          candidates: [{ kind: "anchor", text: "Member No", relation: "right_of", unique: true }],
        },
      ],
    },
    outputs_bound: { savingsBalance: { step: 5 } },
  };
}

describe("compiler", () => {
  it("produces a valid draft with templated locators and derived expects", () => {
    const { artifact, report } = compileTrace(lookupTrace(), request);
    ArtifactSchema.parse(artifact);
    expect(artifact.steps.map((s) => s.id)).toEqual([
      "click_member_inquiry",
      "fill_member_number",
      "click_search",
      "click_view",
      "extract_savings_balance",
    ]);
    const view = artifact.targets[(artifact.steps[3] as { target: string }).target]!;
    // The member number became a template; the anchor that merely contained it was rejected.
    expect(view.strategies).toEqual([
      { kind: "role_name", name: "View" },
      {
        kind: "table_cell",
        headers: ["Member No", "Action"],
        row: { column: "Member No", equals: "{{inputs.memberId}}" },
        column: "Action",
      },
    ]);
    expect(report.flags).toContainEqual(expect.objectContaining({ kind: "strategy_rejected" }));
    expect(artifact.steps[2]).toMatchObject({ expect: { resolvable: "view_link" } });
    expect(artifact.steps[3]).toMatchObject({ expect: { resolvable: "savings_balance_cell" } });
    expect(artifact.checkpoint.all).toEqual([
      { cellEquals: { target: "member_no_cell", value: "{{inputs.memberId}}" } },
      { outputParsed: "savingsBalance" },
    ]);
    expect(artifact.provenance).toMatchObject({
      traceId: "t1",
      model: "scripted",
      compilerVersion: "1",
    });
    expect(artifact.contentHash).toMatch(/^sha256:/);
  });

  it("keeps cited evidence out of the checkpoint: it describes the discovery record", () => {
    const trace = lookupTrace();
    // The model cites the Checking row as proof; a member with no Checking account must pass.
    trace.end = {
      ...trace.end,
      evidence: [
        ...(trace.end.evidence ?? []),
        {
          ref: "e32",
          role: "cell",
          scope: W,
          candidates: [
            {
              kind: "table_cell",
              headers: ["Type", "Balance"],
              row: { column: "Type", equals: "Checking" },
              column: "Type",
              unique: true,
            },
          ],
        },
      ],
    };
    const { artifact } = compileTrace(trace, request);
    expect(artifact.checkpoint.all).toEqual([
      { cellEquals: { target: "member_no_cell", value: "{{inputs.memberId}}" } },
      { outputParsed: "savingsBalance" },
    ]);
    expect(Object.keys(artifact.targets)).not.toContain("checking_cell");
  });

  it("flags a click that landed on a cell rather than the control inside it", () => {
    const trace = lookupTrace((events) =>
      events.map((e, i) =>
        i === 3 && e.target
          ? {
              ...e,
              target: {
                ...e.target,
                role: "cell",
                candidates: e.target.candidates.filter((c) => c.kind === "table_cell"),
              },
            }
          : e,
      ),
    );
    const { report } = compileTrace(trace, request);
    expect(report.flags).toContainEqual(
      expect.objectContaining({
        kind: "non_interactive_click",
        step: "click_member_id_row_action",
      }),
    );
  });

  it("drops failed and duplicate actions and flags literals and human steps", () => {
    const trace = lookupTrace((events) => [
      events[0]!,
      {
        ...events[1]!,
        seq: 2,
        decision: { action: "fill", ref: "e16", value: { literal: "1004" }, rationale: "typo" },
        result: { status: "invalid", message: "rejected" },
      },
      { ...events[1]!, seq: 3 },
      {
        seq: 4,
        actor: "human",
        observation: obs(4),
        decision: { action: "human", kind: "click", role: "button", name: "Clear", scope: W },
        result: { status: "ok" },
      },
      ...events.slice(2).map((e, i) => ({ ...e, seq: 5 + i })),
      {
        ...events[4]!,
        seq: 8,
        result: { status: "ok", extracted: { output: "savingsBalance", parsed: true } },
      },
      { ...events[5]!, seq: 9 },
    ]);
    const { artifact, report } = compileTrace(trace, request);
    expect(artifact.steps).toHaveLength(5);
    expect(report.flags.map((f) => f.kind)).toEqual(
      expect.arrayContaining(["step_dropped", "human_step_not_compiled", "duplicate_extract"]),
    );
  });

  it("keeps a literal the model typed and flags it", () => {
    const trace = lookupTrace((events) =>
      events.map((e) =>
        e.decision.action === "fill"
          ? { ...e, decision: { ...e.decision, value: { literal: "Holiday" } } }
          : e,
      ),
    );
    const { artifact, report } = compileTrace(trace, request);
    expect(artifact.steps[1]).toMatchObject({ value: "Holiday" });
    expect(report.flags).toContainEqual(expect.objectContaining({ kind: "literal_value" }));
  });

  it("refuses a trace that did not finish or did not bind every output", () => {
    const unfinished = { ...lookupTrace(), end: { kind: "stuck" as const, reason: "looping" } };
    expect(() => compileTrace(unfinished, request)).toThrow(CompileError);
    const unbound = { ...lookupTrace(), outputs_bound: {} };
    expect(() => compileTrace(unbound, request)).toThrow(/never extracted/);
  });
});
