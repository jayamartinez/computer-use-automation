// How an intervention request reaches a person. The minimal operator surface is a terminal
// prompt plus the same headed browser window; in production this would be a queue or a ticket
// and a streamed session, behind the same interface.

export type Question = {
  requestId: string;
  prompt: string;
  /** The only answers accepted. Anything else is asked again. */
  answers: readonly string[];
};

export interface InterventionChannel {
  /** One question at a time. Resolves with one of `answers`, or undefined when time runs out. */
  ask(question: Question, timeoutMs: number): Promise<string | undefined>;
  /** Tells the person something without asking. */
  notify(message: string): void;
}
