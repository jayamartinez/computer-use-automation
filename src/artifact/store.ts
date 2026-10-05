import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ArtifactSchema, type Artifact } from "./schema.ts";

export class ArtifactError extends Error {}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/**
 * Identifies the reviewed content. `status` is excluded so that approving an artifact does
 * not change the hash of what was approved.
 */
export function contentHash(artifact: Artifact): string {
  const { contentHash: _hash, status: _status, ...content } = artifact;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(content)))
    .digest("hex")}`;
}

export function parseArtifact(data: unknown): Artifact {
  const parsed = ArtifactSchema.safeParse(data);
  if (!parsed.success) {
    throw new ArtifactError(`Invalid artifact:\n${z.prettifyError(parsed.error)}`);
  }
  const expected = contentHash(parsed.data);
  if (parsed.data.contentHash !== expected) {
    throw new ArtifactError(
      `Artifact content does not match its contentHash (expected ${expected}). ` +
        "It was edited after it was saved; re-save it and review the change.",
    );
  }
  return parsed.data;
}

export async function loadArtifact(path: string): Promise<Artifact> {
  return parseArtifact(JSON.parse(await readFile(path, "utf8")));
}

/** Stamps the content hash, validates and writes. */
export async function saveArtifact(path: string, artifact: Artifact): Promise<Artifact> {
  const stamped = parseArtifact({ ...artifact, contentHash: contentHash(artifact) });
  await writeFile(path, `${JSON.stringify(stamped, null, 2)}\n`);
  return stamped;
}
