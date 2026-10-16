import type { Trace } from "../../trace/schema.ts";
import type { DecisionProvider, ProviderResponse } from "./provider.ts";

/**
 * Replays the model's recorded answers in order, so a discovery run can be reproduced without
 * a key: the same screens get the same decisions. Tests and "run without live services" use it.
 */
export class RecordedProvider implements DecisionProvider {
  readonly name: string;
  private index = 0;

  constructor(
    private readonly responses: ProviderResponse[],
    source = "recording",
  ) {
    this.name = `recorded:${source}`;
  }

  /** The answers a trace recorded, in the order they were given. */
  static fromTrace(trace: Trace): RecordedProvider {
    // Usage is the original run's; a replay from the recording costs nothing.
    const responses = trace.events.flatMap((event) =>
      event.raw ? [{ ...event.raw, usage: undefined }] : [],
    );
    return new RecordedProvider(responses, trace.traceId);
  }

  async decide(): Promise<ProviderResponse> {
    const next = this.responses[this.index++];
    if (!next) throw new Error(`The recording has only ${this.responses.length} answers`);
    return next;
  }
}
