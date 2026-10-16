import type { DecisionProvider, DecisionRequest, ProviderResponse } from "./provider.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// Enough for a reasoning model to think and still answer; the spike lost one answer at 400.
const MAX_TOKENS = 1500;

export type OpenRouterOptions = {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

type ChatResponse = {
  error?: unknown;
  choices?: {
    message: {
      content?: string | null;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number };
};

/** One model behind the OpenAI-compatible OpenRouter API. The model id is configuration. */
export class OpenRouterProvider implements DecisionProvider {
  readonly name: string;

  constructor(private readonly options: OpenRouterOptions) {
    this.name = `openrouter:${options.model}`;
  }

  async decide(request: DecisionRequest): Promise<ProviderResponse> {
    const content: unknown[] = [{ type: "text", text: request.user }];
    if (request.screenshot) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${request.screenshot.toString("base64")}` },
      });
    }
    const body = {
      model: this.options.model,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      tools: request.tools,
      tool_choice: "auto",
      usage: { include: true },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content },
      ],
    };
    const doFetch = this.options.fetch ?? fetch;
    const response = await doFetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 90_000),
    });
    const json = (await response.json()) as ChatResponse;
    if (!response.ok || json.error) {
      throw new Error(`OpenRouter: ${JSON.stringify(json.error ?? json).slice(0, 300)}`);
    }
    const message = json.choices?.[0]?.message;
    const call = message?.tool_calls?.[0];
    let args: unknown;
    if (call) {
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = { malformed: call.function.arguments };
      }
    }
    return {
      ...(call ? { toolName: call.function.name, arguments: args } : {}),
      ...(message?.content ? { text: message.content } : {}),
      model: this.options.model,
      ...(json.usage
        ? {
            usage: {
              promptTokens: json.usage.prompt_tokens,
              completionTokens: json.usage.completion_tokens,
              ...(json.usage.cost === undefined ? {} : { cost: json.usage.cost }),
            },
          }
        : {}),
    };
  }
}
