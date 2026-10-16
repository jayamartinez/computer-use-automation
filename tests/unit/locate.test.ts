import { describe, expect, it } from "vitest";
import { synthesizeCandidates, targetFrom, templateText } from "../../src/discovery/locate.ts";
import { labelLeftOf, renderObservation } from "../../src/discovery/observe.ts";
import { makeObservation } from "../../src/surface/observation.ts";
import type { ObservedElement } from "../../src/surface/types.ts";

const W = ["workarea"];
const el = (
  role: string,
  text: string,
  x: number,
  y: number,
  extra: Partial<ObservedElement> = {},
): Omit<ObservedElement, "ref"> => ({
  scope: W,
  role,
  name: role === "textbox" ? "" : text,
  text,
  bounds: { x, y, width: 90, height: 20 },
  ...extra,
});

const screen = (elements: Omit<ObservedElement, "ref">[]) =>
  makeObservation(elements.map((e, i) => ({ ...e, ref: `e${i + 1}` })));

describe("locator synthesis", () => {
  it("finds an unlabeled field by the label beside it and tests it live", () => {
    const o = screen([
      el("text", "Member Number", 0, 0),
      el("textbox", "", 100, 0, { value: "" }),
      el("text", "Last Name", 0, 30),
      el("textbox", "", 100, 30, { value: "" }),
    ]);
    const field = o.elements[1]!;
    const candidates = synthesizeCandidates(o.elements, field, { memberId: "10042" });
    expect(candidates).toEqual([
      { kind: "anchor", text: "Member Number", relation: "right_of", unique: true },
    ]);
    expect(targetFrom(field, candidates)).toMatchObject({ role: "textbox", scope: W });
    expect(renderObservation(o)).toContain('e2 [workarea] textbox label="Member Number" value=""');
  });

  it("addresses a cell by header and row key, preferring a key that is an input value", () => {
    const o = screen([
      el("text", "Member No", 0, 0),
      el("text", "Name", 100, 0),
      el("text", "Action", 200, 0),
      el("text", "10042", 0, 30),
      el("text", "Avery L", 100, 30),
      el("link", "View", 200, 30),
      el("text", "10077", 0, 60),
      el("text", "Marcus O", 100, 60),
      el("link", "View", 200, 60),
    ]);
    const view = o.elements[5]!;
    const candidates = synthesizeCandidates(o.elements, view, { memberId: "10042" });
    // The name "View" is shared by two rows, so role_name is not unique; the table address is.
    expect(candidates[0]).toEqual({ kind: "role_name", name: "View", unique: false });
    expect(candidates[1]).toEqual({
      kind: "table_cell",
      headers: ["Member No", "Action"],
      row: { column: "Member No", equals: "10042" },
      column: "Action",
      unique: true,
    });
    expect(targetFrom(view, candidates)!.strategies[0]!.kind).toBe("table_cell");
  });

  it("reports when nothing identifies an element uniquely", () => {
    const o = screen([el("button", "Go", 0, 0), el("button", "Go", 100, 0)]);
    const candidates = synthesizeCandidates(o.elements, o.elements[0]!, {});
    expect(candidates.every((c) => !c.unique)).toBe(true);
    expect(targetFrom(o.elements[0]!, candidates)).toBeUndefined();
  });

  it("does not take a label from another scope", () => {
    const o = screen([
      { ...el("text", "Member Number", 0, 0), scope: ["nav"] },
      el("textbox", "", 100, 0, { value: "" }),
    ]);
    expect(labelLeftOf(o.elements, o.elements[1]!)).toBeUndefined();
  });
});

describe("what the model is shown", () => {
  it("lists a cell that only wraps a link, and a text node that fills a cell, once", () => {
    const o = screen([
      el("cell", "View", 200, 30, { bounds: { x: 196, y: 26, width: 48, height: 23 } }),
      el("link", "View", 200, 30, { bounds: { x: 200, y: 30, width: 28, height: 15 } }),
      el("cell", "$2,480.17", 0, 60, { bounds: { x: 0, y: 56, width: 66, height: 23 } }),
      el("text", "$2,480.17", 4, 60, { bounds: { x: 4, y: 60, width: 58, height: 15 } }),
      el("text", "Member Number", 0, 100),
    ]);
    const lines = renderObservation(o).split("\n");
    expect(lines).toEqual([
      'e2 [workarea] link name="View"',
      'e3 [workarea] cell name="$2,480.17"',
      'e5 [workarea] text name="Member Number"',
    ]);
  });

  it("templates whole input values in the model's prose, never a value embedded in another", () => {
    const inputs = { memberId: "10042", openingDeposit: "250.00" };
    expect(
      templateText("member 10042, account 4000-10042-01, $250.00 of 1,250.00 (10042)", inputs),
    ).toBe(
      "member {{inputs.memberId}}, account 4000-10042-01, ${{inputs.openingDeposit}} of 1,250.00 ({{inputs.memberId}})",
    );
  });
});
