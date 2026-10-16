import { appendFileSync } from "node:fs";

export type Scrub = { value: string; replacement: string };

// Shorter values would also match ordinary words and numbers in the log.
const MIN_SCRUB_LENGTH = 4;

/**
 * Structured run log, one JSON event per line. Events are built from redacted values in the
 * first place; the scrub list is a backstop that replaces any known secret or sensitive input
 * that reaches a log line anyway (for example inside an error message).
 */
export class RunLog {
  private seq = 0;
  private readonly scrubs: Scrub[];

  constructor(
    private readonly sink: (line: string) => void,
    scrubs: Scrub[] = [],
  ) {
    this.scrubs = scrubs
      .filter((s) => s.value.length >= MIN_SCRUB_LENGTH)
      .sort((a, b) => b.value.length - a.value.length);
  }

  static toFile(path: string, scrubs: Scrub[] = []): RunLog {
    return new RunLog((line) => appendFileSync(path, `${line}\n`), scrubs);
  }

  /**
   * Adds a value learned during the run, such as text the screen masks or an output just
   * read, so free text written afterwards (a model's own words, an error) cannot carry it.
   */
  addScrub(scrub: Scrub): void {
    if (scrub.value.length < MIN_SCRUB_LENGTH) return;
    if (this.scrubs.some((s) => s.value === scrub.value)) return;
    this.scrubs.push(scrub);
    this.scrubs.sort((a, b) => b.value.length - a.value.length);
  }

  write(event: string, fields: Record<string, unknown> = {}): void {
    const entry = { seq: ++this.seq, ts: new Date().toISOString(), event, ...fields };
    this.sink(JSON.stringify(this.scrub(entry)));
  }

  /** Applies the same backstop to text saved outside the log, such as an observation dump. */
  scrubText(text: string): string {
    return this.scrubs.reduce((result, s) => result.replaceAll(s.value, s.replacement), text);
  }

  private scrub(value: unknown): unknown {
    if (typeof value === "string") return this.scrubText(value);
    if (Array.isArray(value)) return value.map((item) => this.scrub(item));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.scrub(v)]));
    }
    return value;
  }
}
