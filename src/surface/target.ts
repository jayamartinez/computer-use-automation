// How a control is identified. Three semantic locator kinds and nothing else: each describes
// what an operator sees, so the same target can be resolved against a DOM, a desktop
// accessibility tree or OCR output.

import { z } from "zod";

export const FramePathSchema = z.array(z.string().min(1));

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
  frame: FramePathSchema,
  role: z.string().min(1),
  strategies: z.array(StrategySchema).min(1),
  rationale: z.string().min(1),
});

export type Strategy = z.infer<typeof StrategySchema>;
export type Target = z.infer<typeof TargetSchema>;
