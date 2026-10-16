// The one seam to a model. A provider turns a decision request into one tool call; the loop
// validates it. The real provider talks to OpenRouter; the recorded one replays saved answers.

import type { Observation } from "../../surface/types.ts";
import type { ToolDefinition } from "../actions.ts";

export type DecisionRequest = {
  system: string;
  /** Goal, inputs, outputs, history and the rendered observation. */
  user: string;
  /** The screen as the operator sees it. Discovery runs only on synthetic data. */
  screenshot?: Buffer;
  tools: ToolDefinition[];
  /** For scripted providers in tests; a real provider reads only `user`. */
  observation: Observation;
};

export type ProviderResponse = {
  /** The tool the model called, or undefined when it answered in prose only. */
  toolName?: string;
  arguments?: unknown;
  text?: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; cost?: number };
};

export interface DecisionProvider {
  readonly name: string;
  decide(request: DecisionRequest): Promise<ProviderResponse>;
}
