import type { Target } from "./target.ts";

export type Box = { x: number; y: number; width: number; height: number };

// One perceived element. `role: "text"` is visible text with no interactive role; it is what
// anchors and table headers are matched against. Bounds are local to the element's scope.
export type ObservedElement = {
  ref: string;
  scope: string[];
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
  | { textPresent: string; scope?: string[] }
  | { resolvable: Target }
  | { textEquals: { target: Target; value: string; as?: "money" } }
  | { valueEquals: { target: Target; value: string } }
  | { all: Signature[] }
  | { any: Signature[] };

// The values beneath this visible label (a column header), beside it (a form label) or in the
// same text element (`self`, as in "Operator: teller01") are sensitive.
export type MaskRule = {
  label: string;
  where: "below" | "right_of" | "self";
  /** Applies only while this holds, so a label can be masked on the screen it was meant for. */
  when?: Signature;
};

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
  /** A masked image of the screen, or undefined while a native dialog blocks capturing it. */
  screenshot(opts: { mask: MaskRule[] }): Promise<Buffer | undefined>;
  /**
   * Reports what a person does on the surface until the returned function is called. Only the
   * control is reported, never a value typed into it.
   */
  watchHuman(listener: (action: HumanAction) => void): Promise<() => Promise<void>>;
}

/**
 * One thing a person did during a takeover: which control, by role, name and scope. A dialog
 * opening is reported too, with its message for the operator; the message is never logged.
 */
export type HumanAction =
  | { kind: "click" | "change" | "submit"; role: string; name: string; scope: string[] }
  | { kind: "dialog"; role: "dialog"; name: string; scope: string[]; message: string };

/**
 * The container a native dialog (alert, confirm, prompt) is reported in. While one is open the
 * surface reports only the dialog: its message as text and its buttons ("OK", and "Cancel" when
 * it has one). Clicking "OK" accepts it and "Cancel" dismisses it. A surface never answers one by
 * itself.
 */
export const DIALOG_SCOPE = "dialog";
