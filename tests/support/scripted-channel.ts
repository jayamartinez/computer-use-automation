import type { InterventionChannel, Question } from "../../src/handoff/channel.ts";

/**
 * A scripted operator. The script answers each question (undefined stands for "no answer in
 * time") and may act on the live session before it answers, as a person would.
 */
export class ScriptedChannel implements InterventionChannel {
  readonly asked: Question[] = [];
  readonly notes: string[] = [];

  constructor(
    private readonly script: (
      question: Question,
    ) => Promise<string | undefined> | string | undefined,
  ) {}

  async ask(question: Question): Promise<string | undefined> {
    this.asked.push(question);
    return this.script(question);
  }

  notify(message: string): void {
    this.notes.push(message);
  }
}

/** Answers questions in order, whatever they are. */
export const answers = (...queue: (string | undefined)[]) =>
  new ScriptedChannel(() => queue.shift());
