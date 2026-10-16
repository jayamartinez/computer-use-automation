// What the model sees: the observation as text, one element per line. The same element list
// the surface resolves targets against, so what the model picks is what replay can find.

import { normalize } from "../surface/resolve.ts";
import type { Box, Observation, ObservedElement } from "../surface/types.ts";

const EPSILON = 2;
const MAX_TEXT = 80;

const right = (b: Box): number => b.x + b.width;
const bottom = (b: Box): number => b.y + b.height;
const overlapsX = (a: Box, b: Box): boolean => a.x < right(b) - EPSILON && b.x < right(a) - EPSILON;
const overlapsY = (a: Box, b: Box): boolean =>
  a.y < bottom(b) - EPSILON && b.y < bottom(a) - EPSILON;

const sameScope = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((name, i) => name === b[i]);

function nearest(
  found: ObservedElement[],
  distance: (e: ObservedElement) => number,
): ObservedElement | undefined {
  let best: ObservedElement | undefined;
  for (const e of found) if (!best || distance(e) < distance(best)) best = e;
  return best;
}

/** The visible text immediately left of an element in its scope, as a form label would be. */
export function labelLeftOf(
  elements: ObservedElement[],
  element: ObservedElement,
): ObservedElement | undefined {
  const b = element.bounds;
  return nearest(
    elements.filter(
      (e) =>
        e.role === "text" &&
        e !== element &&
        sameScope(e.scope, element.scope) &&
        overlapsY(e.bounds, b) &&
        right(e.bounds) <= b.x + EPSILON,
    ),
    (e) => b.x - right(e.bounds),
  );
}

/** The visible text immediately above an element, as a column header would be. */
export function labelAbove(
  elements: ObservedElement[],
  element: ObservedElement,
): ObservedElement | undefined {
  const b = element.bounds;
  return nearest(
    elements.filter(
      (e) =>
        e.role === "text" &&
        e !== element &&
        sameScope(e.scope, element.scope) &&
        overlapsX(e.bounds, b) &&
        bottom(e.bounds) <= b.y + EPSILON,
    ),
    (e) => b.y - bottom(e.bounds),
  );
}

const FIELD_ROLES = new Set(["textbox", "combobox", "checkbox", "radio"]);

/**
 * One line per element. An unlabeled field gets a `label=` hint from the text beside it: the
 * observation carries no accessible name for it (legacy inputs have none), and the spike showed
 * models choosing by position without the hint.
 */
export function renderObservation(observation: Observation): string {
  const { elements } = observation;
  return elements
    .filter((e) => !listedTwice(elements, e))
    .map((e) => {
      const where = e.scope.length ? e.scope.join("/") : "page";
      const parts = [e.ref, `[${where}]`, e.role];
      if (e.name) parts.push(`name="${clip(e.name)}"`);
      else if (FIELD_ROLES.has(e.role)) {
        const label = labelLeftOf(elements, e);
        if (label) parts.push(`label="${clip(label.text)}"`);
      }
      if (e.text && normalize(e.text) !== normalize(e.name)) parts.push(`text="${clip(e.text)}"`);
      if (e.value !== undefined) parts.push(`value="${clip(e.value)}"`);
      return parts.join(" ");
    })
    .join("\n");
}

const CONTROL_ROLES = new Set(["link", "button", ...FIELD_ROLES]);
const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x - EPSILON &&
  inner.y >= outer.y - EPSILON &&
  right(inner) <= right(outer) + EPSILON &&
  bottom(inner) <= bottom(outer) + EPSILON;

/**
 * The same thing listed twice is a coin toss for the model, and the compiled locator then
 * depends on which line it picked: two of four runs clicked the cell around the View link, one
 * extracted the text node inside the balance cell. A cell whose whole content is one control
 * yields to the control; a text node that is a cell's whole content yields to the cell, which
 * the table_cell strategy addresses by header and row.
 */
function listedTwice(elements: ObservedElement[], element: ObservedElement): boolean {
  if (element.role === "cell") {
    return elements.some(
      (e) =>
        CONTROL_ROLES.has(e.role) &&
        sameScope(e.scope, element.scope) &&
        contains(element.bounds, e.bounds) &&
        normalize(e.text || e.name) === normalize(element.text),
    );
  }
  if (element.role === "text") {
    return elements.some(
      (e) =>
        e.role === "cell" &&
        sameScope(e.scope, element.scope) &&
        contains(e.bounds, element.bounds) &&
        normalize(e.text) === normalize(element.text),
    );
  }
  return false;
}

const clip = (text: string): string => {
  const flat = normalize(text);
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
};
