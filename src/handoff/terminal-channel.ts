import { createInterface, type Interface } from "node:readline";
import type { InterventionChannel, Question } from "./channel.ts";

/**
 * Prompts on the terminal. It writes to stderr so stdout stays the run's JSON result, and reads
 * whole lines from stdin. Typed answers are compared exactly; nothing else typed is kept.
 */
export class TerminalChannel implements InterventionChannel {
  private readonly lines: Interface;
  private pending: string[] = [];
  private waiting: ((line: string) => void) | undefined;

  constructor() {
    this.lines = createInterface({ input: process.stdin, terminal: false });
    this.lines.on("line", (line) => {
      if (this.waiting) this.waiting(line);
      else this.pending.push(line);
    });
  }

  notify(message: string): void {
    process.stderr.write(`\n[operator] ${message}\n`);
  }

  async ask(question: Question, timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    // Only a line typed after the question is an answer to it: a stray "approve" typed earlier
    // must never approve an irreversible step nobody has looked at yet.
    this.pending = [];
    for (;;) {
      process.stderr.write(
        `\n[operator] ${question.prompt}\n  (${question.answers.join(" / ")}) > `,
      );
      const line = await this.nextLine(deadline - Date.now());
      if (line === undefined) {
        this.notify("No answer in time.");
        return undefined;
      }
      const answer = line.trim();
      if (question.answers.includes(answer)) return answer;
      this.notify(`Please type one of: ${question.answers.join(", ")}.`);
    }
  }

  close(): void {
    this.lines.close();
  }

  private nextLine(timeoutMs: number): Promise<string | undefined> {
    const queued = this.pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (timeoutMs <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        resolve(undefined);
      }, timeoutMs);
      this.waiting = (line) => {
        clearTimeout(timer);
        this.waiting = undefined;
        resolve(line);
      };
    });
  }
}
