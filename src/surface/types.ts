import type { Target } from "./target.ts";

export type Box = { x: number; y: number; width: number; height: number };

// One perceived element. `role: "text"` is visible text with no interactive role; it is what
// anchors and table headers are matched against. Bounds are local to the element's frame.
export type ObservedElement = {
  ref: string;
  frame: string[];
  role: string;
  name: string;
  text: string;
  value?: string;
  bounds: Box;
};

export type Observation = { id: string; elements: ObservedElement[]; fingerprint: string };

export type Handle = { observationId: string; ref: string };

export type Resolution =
  | { kind: "unique"; handle: Handle; element: ObservedElement; strategyIndex: number }
  | { kind: "ambiguous"; count: number }
  | { kind: "none" };

export type SurfaceAction =
  { kind: "click" } | { kind: "fill"; value: string } | { kind: "select"; value: string };

// A content predicate over the current screen. Never URL-based.
export type Signature =
  | { textPresent: string; frame?: string[] }
  | { resolvable: Target }
  | { textEquals: { target: Target; value: string } }
  | { valueEquals: { target: Target; value: string } }
  | { all: Signature[] }
  | { any: Signature[] };

// The values beneath this visible label (a column header) or beside it (a form label) are
// sensitive.
export type MaskRule = { label: string; where: "below" | "right_of" };

// The only way anything perceives or touches a UI. The recorded flow speaks in targets,
// actions and signatures; how a surface perceives and acts is entirely behind this.
export interface Surface {
  observe(): Promise<Observation>;
  resolve(target: Target): Promise<Resolution>;
  act(handle: Handle, action: SurfaceAction): Promise<void>;
  matches(signature: Signature): Promise<boolean>;
  /**
   * The index of the first signature that holds, all checked against one observation, so a
   * state race has a single, ordered answer for one moment of the screen.
   */
  firstMatch(signatures: Signature[]): Promise<number | undefined>;
  screenshot(opts: { mask: MaskRule[] }): Promise<Buffer>;
}
