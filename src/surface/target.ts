// How a control is identified. Three semantic locator kinds and nothing else: each describes
// what an operator sees, so the same target can be resolved against a DOM, a desktop
// accessibility tree or OCR output.

import { z } from "zod";

// Where on the surface a control lives: an ordered path of named containers, outermost first.
// The surface defines the names: frames of a frameset on legacy web, window then pane on a
// desktop app, and an empty path for a single-document web page. Matching is exact.
export const ScopePathSchema = z.array(z.string().min(1));

export const StrategySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("role_name"), name: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("anchor"),
    text: z.string().min(1),
    relation: z.enum(["right_of", "below", "same_row"]),
  }),
  z.strictObject({
    kind: z.literal("table_cell"),
    headers: z.array(z.string().min(1)).min(1),
    row: z.strictObject({ column: z.string().min(1), equals: z.string().min(1) }),
    column: z.string().min(1),
  }),
]);

export const TargetSchema = z.strictObject({
  scope: ScopePathSchema,
  role: z.string().min(1),
  strategies: z.array(StrategySchema).min(1),
  rationale: z.string().min(1),
});

export type Strategy = z.infer<typeof StrategySchema>;
export type Target = z.infer<typeof TargetSchema>;
