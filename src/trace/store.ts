import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { TraceSchema, type Trace } from "./schema.ts";

export class TraceError extends Error {}

export function parseTrace(data: unknown): Trace {
  const parsed = TraceSchema.safeParse(data);
  if (!parsed.success) throw new TraceError(`Invalid trace:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function loadTrace(path: string): Promise<Trace> {
  return parseTrace(JSON.parse(await readFile(path, "utf8")));
}

/** Validates, scrubs (the caller passes the run log's backstop) and writes. */
export async function saveTrace(
  path: string,
  trace: Trace,
  scrub: (text: string) => string = (text) => text,
): Promise<void> {
  await writeFile(path, `${scrub(JSON.stringify(parseTrace(trace), null, 2))}\n`);
}
