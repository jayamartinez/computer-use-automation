// The model's action vocabulary. One typed action per turn; values are references to declared
// inputs (provenance) or flagged literals, never both. There is no navigate action.

import { z } from "zod";

const RefSchema = z.string().regex(/^[ed]\d+$/);

// `input` and `literal` are mutually exclusive by construction; the spike showed some models
// send both when the schema merely asks them to prefer one.
export const ValueSourceSchema = z.union([
  z.strictObject({ input: z.string() }),
  z.strictObject({ literal: z.string() }),
]);
export type ValueSource = z.infer<typeof ValueSourceSchema>;

const rationale = z.string().min(1).describe("One short sentence: why this action now.");

const variants = {
  click: z.strictObject({
    ref: RefSchema.describe("Element ref from the observation"),
    rationale,
  }),
  fill: z.strictObject({
    ref: RefSchema.describe("Element ref of the text field"),
    value: ValueSourceSchema.describe(
      "Where the text comes from: {input: name} for a declared input (always preferred), or {literal: text} only for text that is not an input.",
    ),
    rationale,
  }),
  select: z.strictObject({
    ref: RefSchema.describe("Element ref of the dropdown"),
    option: ValueSourceSchema.describe(
      "The visible option label: {input: name} for a declared input (always preferred), or {literal: text}.",
    ),
    rationale,
  }),
  extract: z.strictObject({
    ref: RefSchema.describe("Element ref whose text is the value"),
    output: z.string().describe("Name of the declared output to bind"),
    rationale,
  }),
  finish: z.strictObject({
    summary: z.string().min(1).describe("One sentence: what was accomplished"),
    evidenceRefs: z
      .array(RefSchema)
      .min(1)
      .describe(
        "Elements on the current screen that prove the goal is met, including one showing which record it was for (for example the member number).",
      ),
    rationale,
  }),
  need_human: z.strictObject({
    reason: z.string().min(1).describe("What a person needs to do or decide"),
  }),
  give_up: z.strictObject({
    reason: z.string().min(1).describe("Why the goal cannot be met on this application"),
  }),
};

export const ModelActionSchema = z.discriminatedUnion("action", [
  variants.click.extend({ action: z.literal("click") }),
  variants.fill.extend({ action: z.literal("fill") }),
  variants.select.extend({ action: z.literal("select") }),
  variants.extract.extend({ action: z.literal("extract") }),
  variants.finish.extend({ action: z.literal("finish") }),
  variants.need_human.extend({ action: z.literal("need_human") }),
  variants.give_up.extend({ action: z.literal("give_up") }),
]);
export type ModelAction = z.infer<typeof ModelActionSchema>;

const DESCRIPTIONS: Record<keyof typeof variants, string> = {
  click: "Click a link or button.",
  fill: "Type into a text field. Prefer referencing a declared input by name.",
  select: "Choose an option in a dropdown.",
  extract: "Read a value from an element into a declared output.",
  finish:
    "The goal is met: every declared output has been extracted and the screen proves it. Cite the proof.",
  need_human: "You are stuck or the next step is unsafe; ask an operator to take over.",
  give_up: "The goal cannot be met.",
};

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** The tools offered to the model, derived from the same schema that validates its answers. */
export function toolDefinitions(): ToolDefinition[] {
  return (Object.keys(variants) as (keyof typeof variants)[]).map((name) => {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(variants[name]);
    return {
      type: "function",
      function: { name, description: DESCRIPTIONS[name], parameters },
    };
  });
}

/** Builds a typed action from a tool call, or explains why it is not one. */
export function parseModelAction(
  toolName: string,
  args: unknown,
): { ok: true; action: ModelAction } | { ok: false; problem: string } {
  const parsed = ModelActionSchema.safeParse({
    ...(typeof args === "object" && args !== null ? args : {}),
    action: toolName,
  });
  if (parsed.success) return { ok: true, action: parsed.data };
  return { ok: false, problem: z.prettifyError(parsed.error).split("\n").slice(0, 3).join(" ") };
}
