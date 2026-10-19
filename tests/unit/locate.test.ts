import { beforeAll, describe, expect, it } from "vitest";
import { synthesizeCandidates, targetFrom, templateText } from "../../src/discovery/locate.ts";
import { labelLeftOf, renderObservation } from "../../src/discovery/observe.ts";
import { makeObservation } from "../../src/surface/observation.ts";
import type { MaskRule, ObservedElement } from "../../src/surface/types.ts";
import { coreservProfile } from "../support/fixtures.ts";

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
    const candidates = synthesizeCandidates(o.elements, field, { memberId: "10042" }, []);
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
    const candidates = synthesizeCandidates(o.elements, view, { memberId: "10042" }, []);
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
    const candidates = synthesizeCandidates(o.elements, o.elements[0]!, {}, []);
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

// Screens shaped like CoreServ's, with the coordinates of a real open_subaccount run: every
// table cell is reported together with the text node inside it, and layout cells wrap them.
type Spec = Omit<ObservedElement, "ref">;
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const cell = (text: string, x: number, y: number, width: number, height = 23): Spec[] => [
  { scope: W, role: "cell", name: text, text, bounds: box(x, y, width, height) },
  ...(text
    ? [
        {
          scope: W,
          role: "text",
          name: text,
          text,
          bounds: box(x + 4, y + 4, Math.min(width - 8, text.length * 7), 15),
        },
      ]
    : []),
];
const text = (t: string, x: number, y: number, width: number): Spec => ({
  scope: W,
  role: "text",
  name: t,
  text: t,
  bounds: box(x, y, width, 15),
});
const control = (role: string, name: string, x: number, y: number, width: number): Spec => ({
  scope: W,
  role,
  name,
  text: role === "button" ? name : "",
  bounds: box(x, y, width, 21),
  ...(role === "button" ? {} : { value: "" }),
});
/** A table of label and value cells, one pair per row, as Review and Confirmation draw it. */
const details = (rows: [string, string][], x: number, y: number, labelW: number, valueW: number) =>
  rows.flatMap(([label, value], i) => [
    ...cell(label, x, y + 23 * i, labelW),
    ...cell(value, x + labelW, y + 23 * i, valueW),
  ]);
/** The member summary at the top of Profile and the form: label, value, label, value. */
const summary = (x: number, y: number) => [
  ...cell("Member No", x, y, 79),
  ...cell("10042", x + 79, y, 92),
  ...cell("Status", x + 171, y, 53),
  ...cell("Active", x + 224, y, 92),
  ...cell("Name", x, y + 23, 79),
  ...cell("Dana Whitfield", x + 79, y + 23, 92),
  ...cell("Branch", x + 171, y + 23, 53),
  ...cell("Lakeside Main", x + 224, y + 23, 92),
];

const INPUTS = {
  memberId: "10042",
  accountType: "Club Savings",
  nickname: "Vacation Fund",
  openingDeposit: "250.00",
};
let masks: MaskRule[];
beforeAll(async () => {
  masks = (await coreservProfile()).masks;
});

const find = (o: { elements: ObservedElement[] }, role: string, t: string) =>
  o.elements.find((e) => e.role === role && (e.name || e.text) === t)!;
const candidatesFor = (o: { elements: ObservedElement[] }, element: ObservedElement) =>
  synthesizeCandidates(o.elements, element, INPUTS, masks);
const beside = (label: string) => ({
  kind: "anchor",
  text: label,
  relation: "right_of",
  unique: true,
});

describe("locator synthesis on CoreServ's screens", () => {
  it("reads a label/value list by the label beside each value, never as a table", () => {
    const o = screen([
      ...cell("Review Sub-Account", 8, 8, 1093),
      { ...cell("Pending Transaction ...", 8, 31, 1093, 312)[0]! },
      text("Verify the details below with the member, then select Confirm.", 12, 35, 472),
      text("Once confirmed, the account is opened and the deposit is posted.", 12, 50, 661),
      text("Pending Transaction", 12, 83, 128),
      ...details(
        [
          ["Member No", "10042"],
          ["Member Name", "Dana Whitfield"],
          ["Transaction", "Open Sub-Account"],
          ["Account Type", "Club Savings"],
          ["Nickname", "Vacation Fund"],
          ["Opening Deposit", "$250.00"],
          ["Funded From", "Savings"],
          ["Supervisor Override", "Not required"],
        ],
        13,
        99,
        196,
        174,
      ),
      control("button", "Confirm", 12, 302, 63),
      control("button", "Back", 79, 302, 46),
    ]);
    // The read-back before Confirm: each value by its own label, with no table address made of
    // the first row's label and value (the member's name, or an input value).
    for (const [label, value] of [
      ["Member No", "10042"],
      ["Account Type", "Club Savings"],
      ["Nickname", "Vacation Fund"],
      ["Opening Deposit", "$250.00"],
    ] as const) {
      expect(candidatesFor(o, find(o, "cell", value)), label).toEqual([beside(label)]);
    }
  });

  it("reads Confirmation's outputs by their labels, not by the row above as a header", () => {
    const o = screen([
      ...cell("Sub-Account Confirmation", 8, 8, 1093),
      text("Sub-account opened.", 12, 35, 132),
      text("The opening deposit has been posted. Give the member the reference.", 12, 50, 520),
      text("Transaction Receipt", 12, 83, 124),
      ...details(
        [
          ["Member No", "10042"],
          ["New Account No", "4000-10042-03"],
          ["Account Type", "Club Savings"],
          ["Nickname", "Vacation Fund"],
          ["Opening Deposit", "$250.00"],
          ["Funded From", "Savings"],
          ["Confirmation Ref", "OSA-1376-3040"],
          ["Posted", "10/15/2026 9:27 PM"],
        ],
        13,
        99,
        176,
        194,
      ),
      control("button", "Return to Member Profile", 12, 302, 165),
    ]);
    // "Funded From | Savings" directly above is two labels by content, but a row, not a header.
    expect(candidatesFor(o, find(o, "cell", "OSA-1376-3040"))).toEqual([
      beside("Confirmation Ref"),
    ]);
    expect(candidatesFor(o, find(o, "cell", "4000-10042-03"))).toEqual([beside("New Account No")]);
    expect(candidatesFor(o, find(o, "cell", "Vacation Fund"))).toEqual([beside("Nickname")]);
  });

  it("finds each form field by its label, not by the member summary above the form", () => {
    const o = screen([
      ...cell("Open Sub-Account", 8, 8, 1093),
      ...summary(13, 36),
      text("Complete the fields below and select Continue.", 12, 101, 686),
      text("Fields marked * are required.", 12, 116, 168),
      ...cell("Account Type *", 12, 149, 146, 25),
      control("combobox", "", 161, 152, 107),
      ...cell("Nickname *", 12, 174, 146, 27),
      control("textbox", "", 161, 177, 205),
      ...cell("(max 20 characters)", 369, 174, 179, 27),
      ...cell("Opening Deposit *", 12, 201, 146, 27),
      control("textbox", "", 161, 204, 121),
      ...cell("USD, no $ sign or commas", 369, 201, 179, 27),
      ...cell("Funded From", 12, 228, 146, 24),
      ...cell("Savings", 158, 228, 211, 24),
      text("Available Balance", 372, 233, 103),
      text("$2,480.17", 487, 233, 58),
      control("button", "Continue", 161, 255, 69),
    ]);
    const fields = o.elements.filter((e) => e.role === "combobox" || e.role === "textbox");
    expect(fields.map((field) => candidatesFor(o, field))).toEqual([
      [beside("Account Type *")],
      [beside("Nickname *")],
      [beside("Opening Deposit *")],
    ]);
  });

  it("keeps the table address for a genuine data table, and names the button below it", () => {
    const accounts = (y: number, [number, type, balance]: [string, string, string]) => [
      ...cell(number, 21, y, 96),
      ...cell(type, 117, y, 62),
      ...cell(balance, 179, y, 66),
      ...cell("03/14/2011", 245, y, 72),
    ];
    const o = screen([
      ...cell("Member Profile", 8, 8, 1093),
      ...summary(21, 44),
      text("Accounts", 20, 99, 59),
      ...cell("Account No", 21, 115, 96),
      ...cell("Type", 117, 115, 62),
      ...cell("Balance", 179, 115, 66),
      ...cell("Opened", 245, 115, 72),
      ...accounts(138, ["4000-10042-02", "Checking", "$1,204.33"]),
      ...accounts(161, ["4000-10042-01", "Savings", "$2,480.17"]),
      { ...cell("Open Sub-Account", 20, 193, 318, 37)[0]! },
      control("button", "Open Sub-Account", 20, 193, 129),
    ]);
    expect(candidatesFor(o, find(o, "cell", "$2,480.17"))).toEqual([
      {
        kind: "table_cell",
        headers: ["Type", "Balance"],
        row: { column: "Type", equals: "Savings" },
        column: "Balance",
        unique: true,
      },
    ]);
    expect(candidatesFor(o, find(o, "cell", "10042"))).toEqual([beside("Member No")]);
    expect(candidatesFor(o, find(o, "button", "Open Sub-Account"))).toEqual([
      { kind: "role_name", name: "Open Sub-Account", unique: true },
    ]);
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
