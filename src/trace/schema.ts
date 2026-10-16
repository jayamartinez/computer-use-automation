// The typed trace of a discovery run: the only thing the compiler reads. Facts captured at the
// moment of acting (value provenance, locator candidates tested live, policy decisions,
// results), never the model transcript.

import { z } from "zod";
import { RiskSchema } from "../artifact/schema.ts";
import { ModelActionSchema } from "../discovery/actions.ts";
import { ScopePathSchema, StrategySchema } from "../surface/target.ts";

const CandidateSchema = z.intersection(StrategySchema, z.object({ unique: z.boolean() }));

export const ProviderResponseSchema = z.strictObject({
  toolName: z.string().optional(),
  arguments: z.unknown().optional(),
  text: z.string().optional(),
  model: z.string(),
  usage: z
    .strictObject({
      promptTokens: z.number(),
      completionTokens: z.number(),
      cost: z.number().optional(),
    })
    .optional(),
});

const TraceDecisionSchema = z.union([
  ModelActionSchema,
  // A profile condition handled by the loop, not a model choice.
  z.strictObject({
    action: z.literal("condition"),
    condition: z.string(),
    disposition: z.enum(["recover", "escalate", "fail"]),
  }),
  // What a person did during a takeover.
  z.strictObject({
    action: z.literal("human"),
    kind: z.enum(["click", "change", "submit", "dialog"]),
    role: z.string(),
    name: z.string(),
    scope: ScopePathSchema,
  }),
  // The model answered with something that is not an action.
  z.strictObject({ action: z.literal("invalid"), problem: z.string() }),
]);
export type TraceDecision = z.infer<typeof TraceDecisionSchema>;

export const TraceEventSchema = z.strictObject({
  seq: z.number().int().positive(),
  actor: z.enum(["automation", "human"]),
  observation: z.strictObject({
    id: z.string(),
    fingerprint: z.string(),
    /** Masked evidence files, relative to the run directory. */
    screenshot: z.string().optional(),
    dump: z.string().optional(),
  }),
  decision: TraceDecisionSchema,
  /** The model's answer verbatim, so the run can be replayed without a model. */
  raw: ProviderResponseSchema.optional(),
  policy: z
    .strictObject({
      risk: RiskSchema,
      rule: z.string(),
      decision: z.enum(["allow", "deny", "approved", "denied_by_human"]),
    })
    .optional(),
  target: z
    .strictObject({
      role: z.string(),
      scope: ScopePathSchema,
      candidates: z.array(CandidateSchema),
    })
    .optional(),
  result: z.strictObject({
    status: z.enum([
      "ok",
      "denied",
      "unresolved",
      "unlocatable",
      "error",
      "invalid",
      "finished",
      "stopped",
    ]),
    message: z.string().optional(),
    postFingerprint: z.string().optional(),
    settleMs: z.number().optional(),
    /** For an extract: whether the text parsed as the declared output type. */
    extracted: z.strictObject({ output: z.string(), parsed: z.boolean() }).optional(),
  }),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

const EvidenceTargetSchema = z.strictObject({
  ref: z.string(),
  role: z.string(),
  scope: ScopePathSchema,
  candidates: z.array(CandidateSchema),
});

export const TraceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  traceId: z.string(),
  capability: z.string(),
  goal: z.string(),
  tenant: z.string(),
  app: z.strictObject({ product: z.string(), version: z.string().optional() }),
  provider: z.string(),
  /** Input names and sensitivities only; the values live in the request file. */
  inputs: z.record(z.string(), z.strictObject({ type: z.string(), sensitivity: z.string() })),
  outputs: z.record(z.string(), z.strictObject({ type: z.string(), sensitivity: z.string() })),
  startedAt: z.string(),
  finishedAt: z.string(),
  events: z.array(TraceEventSchema),
  end: z.strictObject({
    kind: z.enum(["finish", "need_human", "give_up", "stuck", "budget", "failed", "aborted"]),
    reason: z.string().optional(),
    summary: z.string().optional(),
    /** What the model cited as proof, each with its tested locator candidates. */
    evidence: z.array(EvidenceTargetSchema).optional(),
    /** Texts equal to an input value on the final screen, each with tested candidates. */
    identity: z.array(EvidenceTargetSchema.extend({ input: z.string() })).optional(),
  }),
  /** Which declared outputs were bound by an extract whose text parsed. */
  outputs_bound: z.record(z.string(), z.strictObject({ step: z.number().int() })),
  cost: z.number().optional(),
});
export type Trace = z.infer<typeof TraceSchema>;
