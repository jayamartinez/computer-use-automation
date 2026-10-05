import { describe, expect, it } from "vitest";
import { maskObservation, matchesSignature, resolveTarget } from "../../src/surface/resolve.ts";
import type { Strategy, Target } from "../../src/surface/target.ts";
import type { ObservedElement } from "../../src/surface/types.ts";

const F = ["workarea"];
let n = 0;
const el = (role: string, text: string, x: number, y: number, w = 90, h = 20): ObservedElement => ({
  ref: `e${++n}`,
  frame: F,
  role,
  name: text,
  text,
  bounds: { x, y, width: w, height: h },
});
const target = (role: string, ...strategies: Strategy[]): Target => ({
  frame: F,
  role,
  strategies,
  rationale: "test",
});

describe("role_name", () => {
  const screen = [
    el("button", "Search", 0, 0),
    el("button", "Clear", 100, 0),
    el("link", "View", 0, 40),
    el("link", "View", 0, 70),
  ];

  it("resolves a unique name", () => {
    const found = resolveTarget(screen, target("button", { kind: "role_name", name: "Search" }));
    expect(found).toMatchObject({ kind: "unique", strategyIndex: 0, element: { text: "Search" } });
  });

  it("reports several matches as ambiguous instead of taking the first", () => {
    expect(resolveTarget(screen, target("link", { kind: "role_name", name: "View" }))).toEqual({
      kind: "ambiguous",
      count: 2,
    });
  });

  it("reports no match, and ignores a match in another frame", () => {
    expect(resolveTarget(screen, target("button", { kind: "role_name", name: "Delete" }))).toEqual({
      kind: "none",
    });
    const elsewhere = {
      ...target("button", { kind: "role_name", name: "Search" }),
      frame: ["nav"],
    };
    expect(resolveTarget(screen, elsewhere)).toEqual({ kind: "none" });
  });

  it("falls back to a later strategy and says which one was used", () => {
    const found = resolveTarget(
      screen,
      target("button", { kind: "role_name", name: "Find" }, { kind: "role_name", name: "Search" }),
    );
    expect(found).toMatchObject({ kind: "unique", strategyIndex: 1 });
  });
});

describe("anchor", () => {
  // Two label/input rows, as in the inquiry form. The inputs have no names.
  const form = [
    el("text", "Member Number", 0, 0),
    { ...el("textbox", "", 120, 0), name: "" },
    el("text", "Last Name", 0, 30),
    { ...el("textbox", "", 120, 30), name: "" },
    el("button", "Search", 120, 60),
    el("button", "Clear", 220, 60),
  ];

  it("picks the control beside the label, not the one on the next row", () => {
    const found = resolveTarget(
      form,
      target("textbox", { kind: "anchor", text: "Last Name", relation: "right_of" }),
    );
    expect(found).toMatchObject({ kind: "unique", element: { bounds: { y: 30 } } });
  });

  it("takes the adjacent control when several follow on the same row", () => {
    const row = [
      el("text", "From", 0, 0),
      el("textbox", "a", 100, 0),
      el("text", "To", 200, 0),
      el("textbox", "b", 300, 0),
    ];
    const found = resolveTarget(
      row,
      target("textbox", { kind: "anchor", text: "From", relation: "right_of" }),
    );
    expect(found).toMatchObject({ kind: "unique", element: { text: "a" } });
  });

  it("is ambiguous when two controls are equally near", () => {
    const stacked = [
      el("text", "Amount", 0, 0, 90, 40),
      el("textbox", "a", 100, 0),
      el("textbox", "b", 100, 20),
    ];
    expect(
      resolveTarget(
        stacked,
        target("textbox", { kind: "anchor", text: "Amount", relation: "right_of" }),
      ),
    ).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("refuses an anchor text that appears twice", () => {
    const twice = [...form, el("text", "Member Number", 0, 200)];
    expect(
      resolveTarget(
        twice,
        target("textbox", { kind: "anchor", text: "Member Number", relation: "right_of" }),
      ),
    ).toEqual({ kind: "none" });
  });

  it("resolves below and same_row", () => {
    expect(
      resolveTarget(
        form,
        target("textbox", { kind: "anchor", text: "Member Number", relation: "below" }),
      ),
    ).toEqual({ kind: "none" });
    const below = [
      el("text", "Notes", 0, 0),
      el("textbox", "n", 0, 25),
      el("textbox", "far", 0, 80),
    ];
    expect(
      resolveTarget(below, target("textbox", { kind: "anchor", text: "Notes", relation: "below" })),
    ).toMatchObject({ kind: "unique", element: { text: "n" } });
    expect(
      resolveTarget(
        form,
        target("button", { kind: "anchor", text: "Last Name", relation: "same_row" }),
      ),
    ).toEqual({ kind: "none" });
    expect(
      resolveTarget(
        form,
        target("textbox", { kind: "anchor", text: "Last Name", relation: "same_row" }),
      ),
    ).toMatchObject({ kind: "unique" });
  });
});

describe("table_cell", () => {
  // Headers are plain text, as when a legacy app uses bold <td>s. Savings is the second row.
  const table = [
    el("cell", "", 0, 0, 500, 200), // a layout cell wrapping the whole table
    el("text", "Account No", 0, 0),
    el("text", "Type", 100, 0),
    el("text", "Balance", 200, 0),
    el("text", "4000-1", 0, 30),
    el("text", "Checking", 100, 30),
    el("cell", "$913.40", 200, 30),
    el("text", "4000-2", 0, 60),
    el("text", "Savings", 100, 60),
    el("cell", "$2,480.17", 200, 60),
  ];
  const balanceOf = (type: string): Strategy => ({
    kind: "table_cell",
    headers: ["Type", "Balance"],
    row: { column: "Type", equals: type },
    column: "Balance",
  });

  it("addresses the cell by header and row key, not by position", () => {
    expect(resolveTarget(table, target("cell", balanceOf("Savings")))).toMatchObject({
      kind: "unique",
      element: { text: "$2,480.17" },
    });
    expect(resolveTarget(table, target("cell", balanceOf("Checking")))).toMatchObject({
      kind: "unique",
      element: { text: "$913.40" },
    });
  });

  it("finds nothing for a row key that is absent or a header that is missing", () => {
    expect(resolveTarget(table, target("cell", balanceOf("Money Market")))).toEqual({
      kind: "none",
    });
    const noHeader = { ...balanceOf("Savings"), column: "Available" } as Strategy;
    expect(resolveTarget(table, target("cell", noHeader))).toEqual({ kind: "none" });
  });

  it("is ambiguous when the row key appears twice", () => {
    const duplicated = [...table, el("text", "Savings", 100, 90), el("cell", "$5.00", 200, 90)];
    expect(resolveTarget(duplicated, target("cell", balanceOf("Savings")))).toEqual({
      kind: "ambiguous",
      count: 2,
    });
  });
});

describe("signatures and masking", () => {
  const screen = [
    el("text", "No members match the search criteria.", 0, 0, 300),
    el("text", "Account No", 0, 40),
    el("text", "4000-10077-01", 0, 70),
    el("cell", "4000-10077-01", 0, 70),
    el("text", "Type", 100, 40),
    el("text", "Savings", 100, 70),
  ];

  it("matches text within a frame and combines predicates", () => {
    const observation = { id: "o", fingerprint: "f", elements: screen };
    const text = { frame: F, textPresent: "No members match" };
    expect(matchesSignature(observation, text)).toBe(true);
    expect(matchesSignature(observation, { ...text, frame: ["nav"] })).toBe(false);
    expect(matchesSignature(observation, { all: [text, { textPresent: "absent" }] })).toBe(false);
    expect(matchesSignature(observation, { any: [text, { textPresent: "absent" }] })).toBe(true);
  });

  it("masks values under a sensitive label and leaves the rest readable", () => {
    const masked = maskObservation({ id: "o", fingerprint: "f", elements: screen }, [
      { label: "Account No", where: "below" },
    ]);
    const dump = JSON.stringify(masked);
    expect(dump).not.toContain("4000-10077-01");
    expect(dump).toContain("Savings");
    expect(dump).toContain("Account No");
  });
});
