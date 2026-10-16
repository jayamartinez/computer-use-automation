import type {
  DecisionProvider,
  DecisionRequest,
  ProviderResponse,
} from "../../src/discovery/llm/provider.ts";
import { labelLeftOf } from "../../src/discovery/observe.ts";
import type { Observation, ObservedElement } from "../../src/surface/types.ts";

export type ScriptedCall = { toolName: string; arguments: Record<string, unknown> };

/**
 * A scripted model: decides from the same observation a real model would be shown, by
 * looking at roles, names and labels the way a person reads the screen. Tests use it to drive
 * discovery deterministically without a key.
 */
export class ScriptedProvider implements DecisionProvider {
  readonly name = "scripted";
  readonly requests: DecisionRequest[] = [];
  private turn = 0;

  constructor(
    private readonly script: (
      screen: Screen,
      turn: number,
      request: DecisionRequest,
    ) => ScriptedCall | undefined,
  ) {}

  async decide(request: DecisionRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const call = this.script(new Screen(request.observation), this.turn++, request);
    if (!call) return { model: "scripted", text: "I do not know what to do." };
    return { toolName: call.toolName, arguments: call.arguments, model: "scripted" };
  }
}

/** Finders over an observation, in the vocabulary of what the model is shown. */
export class Screen {
  constructor(readonly observation: Observation) {}

  get elements(): ObservedElement[] {
    return this.observation.elements;
  }

  named(role: string, name: string): ObservedElement | undefined {
    return this.elements.find((e) => e.role === role && e.name.trim() === name);
  }

  /** An unlabeled field, found by the text beside it (the `label=` hint the model sees). */
  fieldLabeled(label: string, role = "textbox"): ObservedElement | undefined {
    return this.elements.find(
      (e) => e.role === role && labelLeftOf(this.elements, e)?.text.trim() === label,
    );
  }

  withText(role: string, text: string | RegExp): ObservedElement | undefined {
    return this.elements.find(
      (e) =>
        e.role === role && (typeof text === "string" ? e.text.trim() === text : text.test(e.text)),
    );
  }

  has(text: string): boolean {
    return this.elements.some((e) => e.role === "text" && e.text.includes(text));
  }
}

export const click = (ref: string, rationale = "next step"): ScriptedCall => ({
  toolName: "click",
  arguments: { ref, rationale },
});
export const fill = (
  ref: string,
  value: Record<string, string>,
  rationale = "enter the value",
): ScriptedCall => ({
  toolName: "fill",
  arguments: { ref, value, rationale },
});
export const extract = (
  ref: string,
  output: string,
  rationale = "read the value",
): ScriptedCall => ({
  toolName: "extract",
  arguments: { ref, output, rationale },
});
export const finish = (evidenceRefs: string[], summary = "done"): ScriptedCall => ({
  toolName: "finish",
  arguments: { summary, evidenceRefs, rationale: "the goal is met" },
});
export const needHuman = (reason: string): ScriptedCall => ({
  toolName: "need_human",
  arguments: { reason },
});
