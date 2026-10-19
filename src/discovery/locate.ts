// Locator synthesis at the moment of acting. For the element the model chose, every semantic
// strategy that could describe it is built from what is on screen and tested for uniqueness
// against that same screen. The compiler keeps only what was unique here; it never guesses
// from a stale snapshot.

import { maskedElements, normalize, resolveTarget } from "../surface/resolve.ts";
import type { Strategy, Target } from "../surface/target.ts";
import type { MaskRule, ObservedElement } from "../surface/types.ts";
import { labelAbove, labelLeftOf } from "./observe.ts";

export type Candidate = Strategy & { unique: boolean };

// Roles whose accessible name is a label an operator reads, not the content of a data cell.
const NAMED_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "heading",
  "columnheader",
  "rowheader",
]);

const sameScope = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((name, i) => name === b[i]);

function unique(
  elements: ObservedElement[],
  element: ObservedElement,
  strategy: Strategy,
): boolean {
  const found = resolveTarget(elements, {
    scope: element.scope,
    role: element.role,
    strategies: [strategy],
    rationale: "candidate",
  });
  return found.kind === "unique" && found.element.ref === element.ref;
}

/** What counts as data on this screen rather than a label. */
type Reading = {
  /** Money, numbers, dates, account numbers, and whatever the profile's masks hide. */
  isData: (text: string) => boolean;
  /** Text that is, or contains, a discovery input value. */
  hasInput: (text: string) => boolean;
  isInput: (text: string) => boolean;
};

/**
 * Candidate strategies for an element, in the order replay should try them. Cells and the
 * links inside genuine data tables prefer a table address over an anchor: the text beside a
 * cell there is usually another cell's data, which an anchor would then depend on. `masks` are
 * the profile's mask rules: what they hide is a record's data, never a label to locate by.
 */
export function synthesizeCandidates(
  elements: ObservedElement[],
  element: ObservedElement,
  inputValues: Record<string, string>,
  masks: MaskRule[],
): Candidate[] {
  const inScope = elements.filter((e) => sameScope(e.scope, element.scope));
  const sensitive = new Set(
    maskedElements(elements, masks)
      .map((e) => normalize(e.text))
      .filter(Boolean),
  );
  const values = new Set(Object.values(inputValues).map(normalize).filter(Boolean));
  const reading: Reading = {
    isData: (text) => looksLikeValue(text) || sensitive.has(normalize(text)),
    hasInput: (text) => templateText(text, inputValues) !== text,
    isInput: (text) => values.has(normalize(text)),
  };
  const strategies: Strategy[] = [];
  // A cell's name is its content, and a name that is a value is data: neither names a control.
  if (NAMED_ROLES.has(element.role) && element.name.trim() && !reading.isData(element.name)) {
    strategies.push({ kind: "role_name", name: element.name.trim() });
  }

  const anchors: Strategy[] = [];
  const left = labelLeftOf(inScope, element);
  const label = left && !reading.isData(left.text) ? left : undefined;
  if (label) anchors.push({ kind: "anchor", text: label.text, relation: "right_of" });
  // With a label beside the element, the text above it belongs to the row above (the previous
  // field, or the previous value in a label/value list), so it is no handle for this element.
  const above = label ? undefined : labelAbove(inScope, element);
  if (above && !reading.isData(above.text)) {
    anchors.push({ kind: "anchor", text: above.text, relation: "below" });
  }

  const tableCells = tableAddresses(inScope, element, reading, (strategy) =>
    unique(elements, element, strategy),
  );
  // Inside a table the address is the locator; the texts beside a cell are other cells' data,
  // so an anchor there would depend on them. Elsewhere anchors come before any table address.
  const inTable = tableCells.length > 0 && (element.role === "cell" || element.role === "link");
  strategies.push(...(inTable ? tableCells : [...anchors, ...tableCells]));

  return strategies.map((strategy) => ({
    ...strategy,
    unique: unique(elements, element, strategy),
  }));
}

/**
 * Table addresses. Header candidates are the texts above the element and above a key cell in
 * its row, nearest first, that can be column headers; a pair that shares a header row is tried
 * as (row header, column header) and the first unique one per key is kept. A key equal to an
 * input value comes first, because the compiler can template it.
 */
function tableAddresses(
  inScope: ObservedElement[],
  element: ObservedElement,
  reading: Reading,
  isUnique: (strategy: Strategy) => boolean,
): Strategy[] {
  // A header is a label: never data, and never the value of an input, which would make the
  // header row differ for every record.
  const isHeader = (text: string) => !reading.isData(text) && !reading.hasInput(text);
  // A header row names at least three columns and holds nothing but headers. A label/value list
  // (Review, Confirmation, a form) has a label and a value per row; with two columns it cannot
  // be told from a keyed table by geometry, and the anchor beside the cell then depends on the
  // same row text with fewer assumptions.
  const isHeaderRow = (header: ObservedElement) => {
    const row = inScope.filter((e) => e.role === "text" && overlapsY(e.bounds, header.bounds));
    return row.length >= 3 && row.every((e) => isHeader(e.text));
  };
  const columns = textsAbove(inScope, element).filter((c) => isHeader(c.text));
  if (columns.length === 0) return [];
  const b = element.bounds;
  const keys = inScope
    .filter(
      (e) =>
        e.role === "text" &&
        e !== element &&
        right(e.bounds) <= b.x + EPSILON &&
        overlapsY(e.bounds, b) &&
        // A key is an input value (templated later) or a category word; other data would tie
        // the flow to this record.
        (reading.isInput(e.text) || !reading.isData(e.text)),
    )
    .sort(
      (a, c) =>
        Number(reading.isInput(c.text)) - Number(reading.isInput(a.text)) ||
        a.bounds.x - c.bounds.x,
    );
  const found: Strategy[] = [];
  let fallback: Strategy | undefined;
  for (const key of keys) {
    const tried: Strategy[] = [];
    const keyHeaders = textsAbove(inScope, key).filter((h) => isHeader(h.text) && isHeaderRow(h));
    for (const keyHeader of keyHeaders) {
      for (const column of columns) {
        if (column === keyHeader || column.text === keyHeader.text) continue;
        if (!overlapsY(column.bounds, keyHeader.bounds)) continue;
        tried.push({
          kind: "table_cell",
          headers: [keyHeader.text, column.text],
          row: { column: keyHeader.text, equals: key.text },
          column: column.text,
        });
      }
    }
    const unique = tried.find(isUnique);
    if (unique) found.push(unique);
    else fallback ??= tried[0];
    // One address is enough; a second keyed on other data would make the flow depend on it.
    if (found.length === 1) break;
  }
  // With nothing unique, one tried address is still recorded so the trace shows what failed.
  return found.length > 0 ? found : fallback ? [fallback] : [];
}

/** Money, numbers, dates and account numbers are data, never headers. */
const looksLikeValue = (text: string): boolean => /^[\d$.,\-/: ]+$/.test(text.trim());

const EPSILON = 2;
const right = (b: ObservedElement["bounds"]): number => b.x + b.width;
const bottom = (b: ObservedElement["bounds"]): number => b.y + b.height;
const overlapsX = (a: ObservedElement["bounds"], b: ObservedElement["bounds"]): boolean =>
  a.x < right(b) - EPSILON && b.x < right(a) - EPSILON;
const overlapsY = (a: ObservedElement["bounds"], b: ObservedElement["bounds"]): boolean =>
  a.y < bottom(b) - EPSILON && b.y < bottom(a) - EPSILON;

/**
 * Texts above an element in its column band, nearest first: the header row of the element's
 * own table comes before anything further up the screen.
 */
function textsAbove(inScope: ObservedElement[], element: ObservedElement): ObservedElement[] {
  const b = element.bounds;
  return inScope
    .filter(
      (e) =>
        e.role === "text" &&
        e !== element &&
        overlapsX(e.bounds, b) &&
        bottom(e.bounds) <= b.y + EPSILON,
    )
    .sort((a, c) => c.bounds.y - a.bounds.y);
}

const RATIONALE: Record<Strategy["kind"], (role: string) => string> = {
  role_name: (role) => `A named ${role}; the name is what an operator looks for.`,
  anchor: (role) =>
    `The ${role} has no accessible name; the visible label beside it is the stable handle.`,
  table_cell: () => "Addressed by header and row key, never by position.",
};

/** A target from the candidates that were unique, ordered as synthesized. */
export function targetFrom(element: ObservedElement, candidates: Candidate[]): Target | undefined {
  const strategies = candidates.filter((c) => c.unique).map(stripUnique);
  const [first] = strategies;
  if (!first) return undefined;
  return {
    scope: element.scope,
    role: element.role,
    strategies,
    rationale: RATIONALE[first.kind](element.role),
  };
}

function stripUnique(candidate: Candidate): Strategy {
  const { unique: _unique, ...strategy } = candidate;
  return strategy;
}

/**
 * Input values inside the model's free text (rationales, summaries), written as the input's
 * template so the trace and artifact name the parameter instead of carrying the discovery value.
 * Longest values first, so one input that contains another is replaced whole.
 */
export function templateText(text: string, inputValues: Record<string, string>): string {
  return Object.entries(inputValues)
    .filter(([, value]) => value.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
    .reduce((result, [name, value]) => {
      // Whole values only: an account number that embeds the member number, or a larger amount
      // that ends in the deposit, is not the input. Punctuation that ends a clause is fine.
      const bounded = new RegExp(
        `(?<![\\w-]|\\d[.,])${escapeRegExp(value)}(?![\\w-]|[.,]\\d)`,
        "g",
      );
      return result.replace(bounded, `{{inputs.${name}}}`);
    }, text);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Strategy texts equal to an input value, written as that input's template. */
export function templateCandidates(
  candidates: Candidate[],
  inputValues: Record<string, string>,
): Candidate[] {
  const byValue = new Map(Object.entries(inputValues).map(([name, value]) => [value, name]));
  const template = (text: string): string => {
    const input = byValue.get(text.trim());
    return input ? `{{inputs.${input}}}` : text;
  };
  return candidates.map((candidate) => {
    switch (candidate.kind) {
      case "role_name":
        return { ...candidate, name: template(candidate.name) };
      case "anchor":
        return { ...candidate, text: template(candidate.text) };
      case "table_cell":
        return { ...candidate, row: { ...candidate.row, equals: template(candidate.row.equals) } };
      default:
        return candidate satisfies never;
    }
  });
}
