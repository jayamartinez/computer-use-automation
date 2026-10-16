// Target resolution and signature matching over an observation. Pure and surface-agnostic:
// any surface that can report elements with a role, text and bounds gets all three locator
// kinds, which is the argument for desktop and OCR surfaces.

import type { Strategy, Target } from "./target.ts";
import type { Box, MaskRule, Observation, ObservedElement, Signature } from "./types.ts";

export type ElementResolution =
  | { kind: "unique"; element: ObservedElement; strategyIndex: number }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" };

// Sub-pixel layout noise; also the margin under which two candidates count as tied.
const EPSILON = 2;

export const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

const sameScope = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((name, i) => name === b[i]);

const right = (b: Box): number => b.x + b.width;
const bottom = (b: Box): number => b.y + b.height;
const overlapsX = (a: Box, b: Box): boolean => a.x < right(b) - EPSILON && b.x < right(a) - EPSILON;
const overlapsY = (a: Box, b: Box): boolean =>
  a.y < bottom(b) - EPSILON && b.y < bottom(a) - EPSILON;
const contains = (outer: Box, inner: Box): boolean =>
  outer.x <= inner.x + EPSILON &&
  outer.y <= inner.y + EPSILON &&
  right(outer) >= right(inner) - EPSILON &&
  bottom(outer) >= bottom(inner) - EPSILON;

const textElements = (elements: ObservedElement[], text: string): ObservedElement[] =>
  elements.filter((e) => e.role === "text" && normalize(e.text) === normalize(text));

/**
 * Strategies are tried in order. One that matches zero or several elements is skipped; it is
 * never narrowed to "the first". Using any strategy but the first is reported by the caller.
 */
export function resolveTarget(elements: ObservedElement[], target: Target): ElementResolution {
  const inScope = elements.filter((e) => sameScope(e.scope, target.scope));
  let ambiguous = 0;
  for (const [strategyIndex, strategy] of target.strategies.entries()) {
    const matches = candidates(inScope, target.role, strategy);
    const [only] = matches;
    if (matches.length === 1 && only) return { kind: "unique", element: only, strategyIndex };
    if (matches.length > 1 && ambiguous === 0) ambiguous = matches.length;
  }
  return ambiguous > 0 ? { kind: "ambiguous", count: ambiguous } : { kind: "none" };
}

function candidates(
  elements: ObservedElement[],
  role: string,
  strategy: Strategy,
): ObservedElement[] {
  const ofRole = elements.filter((e) => e.role === role);
  switch (strategy.kind) {
    case "role_name":
      return ofRole.filter((e) => normalize(e.name) === normalize(strategy.name));
    case "anchor":
      return byAnchor(elements, ofRole, strategy);
    case "table_cell":
      return byTableCell(elements, ofRole, strategy);
    default:
      return strategy satisfies never;
  }
}

function byAnchor(
  elements: ObservedElement[],
  ofRole: ObservedElement[],
  strategy: Extract<Strategy, { kind: "anchor" }>,
): ObservedElement[] {
  // An anchor text that appears more than once names a control per occurrence; unless they
  // all name the same one, the caller sees several matches and reports ambiguity, not absence.
  const matches = textElements(elements, strategy.text).flatMap((anchor) =>
    fromAnchor(ofRole, anchor.bounds, strategy.relation),
  );
  return matches.filter((e, i) => matches.indexOf(e) === i);
}

function fromAnchor(
  ofRole: ObservedElement[],
  a: Box,
  relation: Extract<Strategy, { kind: "anchor" }>["relation"],
): ObservedElement[] {
  switch (relation) {
    case "same_row":
      return ofRole.filter((e) => overlapsY(e.bounds, a) && !contains(e.bounds, a));
    case "right_of":
      return nearest(
        ofRole.filter((e) => overlapsY(e.bounds, a) && e.bounds.x >= right(a) - EPSILON),
        (e) => e.bounds.x - right(a),
      );
    case "below":
      return nearest(
        ofRole.filter((e) => overlapsX(e.bounds, a) && e.bounds.y >= bottom(a) - EPSILON),
        (e) => e.bounds.y - bottom(a),
      );
    default:
      return relation satisfies never;
  }
}

// "Right of" and "below" mean the adjacent control. Candidates tied for nearest are all
// returned, so a tie is reported as ambiguous instead of being broken arbitrarily.
function nearest(
  found: ObservedElement[],
  distance: (e: ObservedElement) => number,
): ObservedElement[] {
  const closest = Math.min(...found.map(distance));
  return found.filter((e) => distance(e) - closest <= EPSILON);
}

/**
 * The header row is located by its visible text, the row by the key value beneath the key
 * header, and the cell by intersecting the row band with the column band. No DOM table
 * structure is assumed, so layout tables and bold-<td> headers resolve the same way.
 */
function byTableCell(
  elements: ObservedElement[],
  ofRole: ObservedElement[],
  strategy: Extract<Strategy, { kind: "table_cell" }>,
): ObservedElement[] {
  const labels = [...new Set([...strategy.headers, strategy.row.column, strategy.column])];
  const [firstLabel, ...otherLabels] = labels;
  if (!firstLabel) return [];

  const headerRows: Map<string, ObservedElement>[] = [];
  for (const first of textElements(elements, firstLabel)) {
    const row = new Map([[firstLabel, first]]);
    for (const label of otherLabels) {
      const inRow = textElements(elements, label).filter((e) => overlapsY(e.bounds, first.bounds));
      const [only] = inRow;
      if (inRow.length === 1 && only) row.set(label, only);
    }
    if (row.size === labels.length) headerRows.push(row);
  }
  const [headerRow] = headerRows;
  if (headerRows.length !== 1 || !headerRow) return [];

  const keyHeader = headerRow.get(strategy.row.column)!.bounds;
  const columnHeader = headerRow.get(strategy.column)!.bounds;
  const keys = textElements(elements, strategy.row.equals).filter(
    (e) => overlapsX(e.bounds, keyHeader) && e.bounds.y >= bottom(keyHeader) - EPSILON,
  );
  // Two rows with the same key: every matching cell is a candidate, so the result is ambiguous.
  return keys.flatMap((key) =>
    ofRole.filter(
      (e) =>
        overlapsX(e.bounds, columnHeader) &&
        overlapsY(e.bounds, key.bounds) &&
        // A layout cell wrapping the whole table also intersects both bands.
        !contains(e.bounds, columnHeader),
    ),
  );
}

/** "$1,234.50", "1234.5" and "1234.50" all read as "1234.50"; anything else is not money. */
function moneyAmount(text: string): string | undefined {
  const match = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(normalize(text));
  if (!match) return undefined;
  return `${match[1]!.replaceAll(",", "")}.${(match[2] ?? "").padEnd(2, "0")}`;
}

export function firstMatching(
  observation: Observation,
  signatures: Signature[],
): number | undefined {
  const index = signatures.findIndex((signature) => matchesSignature(observation, signature));
  return index < 0 ? undefined : index;
}

export function matchesSignature(observation: Observation, signature: Signature): boolean {
  const { elements } = observation;
  if ("all" in signature) return signature.all.every((s) => matchesSignature(observation, s));
  if ("any" in signature) return signature.any.some((s) => matchesSignature(observation, s));
  if ("textPresent" in signature) {
    const { scope } = signature;
    const wanted = normalize(signature.textPresent);
    return elements.some(
      (e) =>
        e.role === "text" &&
        (!scope || sameScope(e.scope, scope)) &&
        normalize(e.text).includes(wanted),
    );
  }
  if ("resolvable" in signature) {
    return resolveTarget(elements, signature.resolvable).kind === "unique";
  }
  if ("textEquals" in signature) {
    const { target, value, as } = signature.textEquals;
    const found = resolveTarget(elements, target);
    if (found.kind !== "unique") return false;
    if (as === "money") {
      const shown = moneyAmount(found.element.text);
      return shown !== undefined && shown === moneyAmount(value);
    }
    return normalize(found.element.text) === normalize(value);
  }
  const found = resolveTarget(elements, signature.valueEquals.target);
  return found.kind === "unique" && found.element.value === signature.valueEquals.value;
}

/**
 * Elements holding a sensitive value: everything in the column beneath a mask label, the
 * element immediately to its right, or (`self`) any text that begins with the label because the
 * value shares its element. Used for screenshots and, via maskObservation, for dumps.
 */
export function maskedElements(elements: ObservedElement[], rules: MaskRule[]): ObservedElement[] {
  const masked = new Set<ObservedElement>();
  const screen: Observation = { id: "", fingerprint: "", elements };
  for (const rule of rules) {
    if (rule.when && !matchesSignature(screen, rule.when)) continue;
    if (rule.where === "self") {
      const label = normalize(rule.label);
      for (const e of elements) {
        if (e.role === "text" && normalize(e.text).startsWith(label)) masked.add(e);
      }
      continue;
    }
    for (const label of textElements(elements, rule.label)) {
      const l = label.bounds;
      const peers = elements.filter(
        (e) => e !== label && sameScope(e.scope, label.scope) && !contains(e.bounds, l),
      );
      const found =
        rule.where === "below"
          ? peers.filter((e) => overlapsX(e.bounds, l) && e.bounds.y >= bottom(l) - EPSILON)
          : nearest(
              peers.filter((e) => overlapsY(e.bounds, l) && e.bounds.x >= right(l) - EPSILON),
              (e) => e.bounds.x - right(l),
            );
      for (const e of found) masked.add(e);
    }
  }
  return [...masked];
}

const MASK = "[masked]";

export function maskObservation(observation: Observation, rules: MaskRule[]): Observation {
  const masked = maskedElements(observation.elements, rules);
  // The value is also the text of whatever sits inside a masked element, and part of the text
  // of any element that wraps one, so both are hidden.
  const hides = (e: ObservedElement): boolean =>
    masked.some(
      (m) =>
        m === e ||
        (sameScope(m.scope, e.scope) &&
          (contains(m.bounds, e.bounds) || contains(e.bounds, m.bounds))),
    );
  return {
    ...observation,
    elements: observation.elements.map((e) =>
      hides(e)
        ? { ...e, name: MASK, text: MASK, ...(e.value === undefined ? {} : { value: MASK }) }
        : e,
    ),
  };
}
