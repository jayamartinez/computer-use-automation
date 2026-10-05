import { createHash, randomUUID } from "node:crypto";
import type { Observation, ObservedElement } from "./types.ts";

// The fingerprint identifies a screen state by its content. Field values and positions are
// left out so typing into a form or a reflow does not look like a new state.
export function makeObservation(elements: ObservedElement[]): Observation {
  const hash = createHash("sha256");
  for (const e of elements) hash.update(`${e.frame.join("/")}|${e.role}|${e.name}|${e.text}\n`);
  return { id: randomUUID(), elements, fingerprint: hash.digest("hex").slice(0, 16) };
}
