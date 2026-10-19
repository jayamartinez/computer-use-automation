// A capability request: what discovery is asked to find out how to do. The calling side
// declares the contract (goal, typed inputs with values, typed outputs); the model discovers how.

import { z } from "zod";
import { SensitivitySchema } from "../artifact/schema.ts";

const ValueTypeSchema = z.enum(["string", "integer", "money", "date", "enum"]);

const valueSpec = {
  type: ValueTypeSchema,
  sensitivity: SensitivitySchema,
  description: z.string().optional(),
  currency: z.string().length(3).optional(),
  values: z.array(z.string()).min(1).optional(),
  pattern: z.string().optional(),
};

export const RequestInputSchema = z.strictObject({
  ...valueSpec,
  /** The value used for the discovery run itself. */
  value: z.string(),
  example: z.string().optional(),
});
export type RequestInput = z.infer<typeof RequestInputSchema>;

export const RequestOutputSchema = z.strictObject(valueSpec);
export type RequestOutput = z.infer<typeof RequestOutputSchema>;

export const CapabilityRequestSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/),
    goal: z.string().min(1),
    description: z.string().min(1),
    tenant: z.string(),
    inputs: z.record(z.string().regex(/^[a-z][A-Za-z0-9]*$/), RequestInputSchema),
    outputs: z.record(z.string().regex(/^[a-z][A-Za-z0-9]*$/), RequestOutputSchema),
    /** A second input set, different from the discovery values, for the verification replay. */
    verifyInputs: z.record(z.string(), z.string()),
    /** Business outcomes to probe for (secondary scope). */
    probes: z
      .array(z.strictObject({ code: z.string(), inputs: z.record(z.string(), z.string()) }))
      .optional(),
    /**
     * Inputs the screen before an irreversible step does not show, so they cannot be read back
     * before committing. Every other input must be, or the compiler refuses the trace. Declared
     * here, by the person asking for the capability, so that skipping a check is a reviewed
     * decision rather than something discovery happened not to see.
     */
    readbackExempt: z.array(z.string()).optional(),
    budget: z
      .strictObject({
        maxSteps: z.number().int().positive().default(25),
        maxMs: z
          .number()
          .int()
          .positive()
          .default(10 * 60_000),
      })
      .default({ maxSteps: 25, maxMs: 10 * 60_000 }),
  })
  .superRefine((request, ctx) => {
    (request.readbackExempt ?? []).forEach((name, index) => {
      if (!(name in request.inputs)) {
        ctx.addIssue({
          code: "custom",
          path: ["readbackExempt", index],
          message: `readbackExempt names "${name}", which is not a declared input`,
        });
      }
    });
    for (const name of Object.keys(request.inputs)) {
      if (!(name in request.verifyInputs)) {
        ctx.addIssue({
          code: "custom",
          path: ["verifyInputs", name],
          message: `verifyInputs must cover input "${name}"`,
        });
      }
    }
    // Verification only proves anything if it uses different data than discovery.
    const same = Object.entries(request.inputs).every(
      ([name, input]) => request.verifyInputs[name] === input.value,
    );
    if (same && Object.keys(request.inputs).length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["verifyInputs"],
        message: "verifyInputs must differ from the discovery inputs in at least one value",
      });
    }
  });
export type CapabilityRequest = z.infer<typeof CapabilityRequestSchema>;

/** The discovery input values, as a plain map. */
export const inputValues = (request: CapabilityRequest): Record<string, string> =>
  Object.fromEntries(Object.entries(request.inputs).map(([name, spec]) => [name, spec.value]));
