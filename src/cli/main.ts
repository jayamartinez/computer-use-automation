import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadArtifact } from "../artifact/store.ts";
import { compileAndVerify } from "../compiler/verify.ts";
import { OpenRouterProvider } from "../discovery/llm/openrouter.ts";
import type { DecisionProvider } from "../discovery/llm/provider.ts";
import { RecordedProvider } from "../discovery/llm/recorded.ts";
import { CapabilityRequestSchema } from "../discovery/request.ts";
import { runDiscovery } from "../discovery/run.ts";
import { TerminalChannel } from "../handoff/terminal-channel.ts";
import { loadProfile, loadTenant, resolveSecrets } from "../profile/load.ts";
import { runReplay } from "../replay/run.ts";
import { loadTrace } from "../trace/store.ts";

const USAGE = `Usage:
  replay <capability-id | artifact.json> --input name=value [--input ...] [--tenant lakeside | tenant.json]
         [--headed] [--allow-irreversible] [--operator]
  discover <request.json> [--tenant lakeside] [--headed] [--operator] [--recording trace.json]
  compile <trace.json> --request <request.json> [--out capabilities] [--tenant lakeside] [--operator]

--tenant takes a tenant name (profiles/<product>/tenants/<name>.json) or a binding file.

replay: a capability id is looked up in capabilities/<id>.json. --allow-irreversible lets an
approved artifact run its irreversible steps unattended; a draft never does. --operator puts
escalations, approvals and unknown outcomes to you in this terminal, with the same browser
window opened for you to work in.

discover: runs the model against the live app for the request's goal and writes
runs/<runId>/trace.json. Needs OPENROUTER_API_KEY and DISCOVERY_MODEL, or --recording to
replay a saved trace's model answers without a key.

compile: turns a trace into a draft artifact, replays it with the request's verifyInputs
against the live app, and writes <out>/<id>.json only if that succeeds. --operator lets you
approve an irreversible step during verification.`;

/** A tenant name under profiles/<product>/tenants/, or the path of a binding file. */
function tenantFile(profileDir: string, tenant: string): string {
  if (tenant.endsWith(".json")) return tenant;
  if (!/^[a-z0-9-]+$/.test(tenant)) {
    throw new Error(`--tenant expects a tenant name or a .json binding file, got "${tenant}"`);
  }
  return join(profileDir, "tenants", `${tenant}.json`);
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (existsSync(".env")) process.loadEnvFile(".env");
  switch (command) {
    case "replay":
      return replay(rest);
    case "discover":
      return discover(rest);
    case "compile":
      return compile(rest);
    default:
      console.error(USAGE);
      return 2;
  }
}

async function replay(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      input: { type: "string", multiple: true, default: [] },
      tenant: { type: "string", default: "lakeside" },
      headed: { type: "boolean", default: false },
      "allow-irreversible": { type: "boolean", default: false },
      operator: { type: "boolean", default: false },
    },
  });
  const [capability] = positionals;
  if (!capability) {
    console.error(USAGE);
    return 2;
  }
  const artifact = await loadArtifact(
    existsSync(capability) ? capability : join("capabilities", `${capability}.json`),
  );
  const profileDir = join("profiles", artifact.app.product);
  const profile = await loadProfile(join(profileDir, "profile.json"));
  const tenant = await loadTenant(tenantFile(profileDir, values.tenant));

  const inputs: Record<string, string> = {};
  for (const pair of values.input) {
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error(`--input expects name=value, got "${pair}"`);
    if (pair.slice(0, separator) in inputs)
      throw new Error(`--input ${pair.slice(0, separator)} was given twice`);
    inputs[pair.slice(0, separator)] = pair.slice(separator + 1);
  }

  const channel = values.operator ? new TerminalChannel() : undefined;
  try {
    const result = await runReplay({
      artifact,
      inputs,
      profile,
      tenant,
      secrets: resolveSecrets(tenant, process.env),
      runsDir: "runs",
      headed: values.headed || values.operator,
      allowIrreversible: values["allow-irreversible"],
      ...(channel ? { channel } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return result.status === "failure" ? 1 : 0;
  } finally {
    channel?.close();
  }
}

async function discover(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      tenant: { type: "string" },
      headed: { type: "boolean", default: false },
      operator: { type: "boolean", default: false },
      recording: { type: "string" },
    },
  });
  const [requestPath] = positionals;
  if (!requestPath) {
    console.error(USAGE);
    return 2;
  }
  const parsed = CapabilityRequestSchema.safeParse(JSON.parse(await readFile(requestPath, "utf8")));
  if (!parsed.success) {
    console.error(`Invalid request:\n${z.prettifyError(parsed.error)}`);
    return 2;
  }
  const request = parsed.data;
  const tenantName = values.tenant ?? request.tenant;
  const product = request.id.split(".")[0]!;
  const profileDir = join("profiles", product);
  const profile = await loadProfile(join(profileDir, "profile.json"));
  const tenant = await loadTenant(tenantFile(profileDir, tenantName));

  let provider: DecisionProvider;
  if (values.recording) {
    provider = RecordedProvider.fromTrace(await loadTrace(values.recording));
  } else {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.DISCOVERY_MODEL;
    if (!apiKey || !model) {
      console.error(
        "Set OPENROUTER_API_KEY and DISCOVERY_MODEL (see .env.example), or pass --recording",
      );
      return 2;
    }
    provider = new OpenRouterProvider({ apiKey, model });
  }

  const channel = values.operator ? new TerminalChannel() : undefined;
  try {
    const { trace, tracePath } = await runDiscovery({
      request,
      profile,
      tenant,
      secrets: resolveSecrets(tenant, process.env),
      provider,
      runsDir: "runs",
      headed: values.headed || values.operator,
      ...(channel ? { channel } : {}),
    });
    console.log(
      JSON.stringify(
        {
          traceId: trace.traceId,
          end: trace.end.kind,
          reason: trace.end.reason,
          summary: trace.end.summary,
          decisions: trace.events.filter((e) => e.raw).length,
          outputsBound: Object.keys(trace.outputs_bound),
          cost: trace.cost,
          trace: tracePath,
        },
        null,
        2,
      ),
    );
    return trace.end.kind === "finish" ? 0 : 1;
  } finally {
    channel?.close();
  }
}

async function compile(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      request: { type: "string" },
      out: { type: "string", default: "capabilities" },
      tenant: { type: "string" },
      operator: { type: "boolean", default: false },
    },
  });
  const [tracePath] = positionals;
  if (!tracePath || !values.request) {
    console.error(USAGE);
    return 2;
  }
  const trace = await loadTrace(tracePath);
  const parsed = CapabilityRequestSchema.safeParse(
    JSON.parse(await readFile(values.request, "utf8")),
  );
  if (!parsed.success) {
    console.error(`Invalid request:
${z.prettifyError(parsed.error)}`);
    return 2;
  }
  const request = parsed.data;
  const profileDir = join("profiles", request.id.split(".")[0]!);
  const profile = await loadProfile(join(profileDir, "profile.json"));
  const tenant = await loadTenant(tenantFile(profileDir, values.tenant ?? request.tenant));
  const channel = values.operator ? new TerminalChannel() : undefined;
  try {
    const outcome = await compileAndVerify(trace, request, {
      profile,
      tenant,
      secrets: resolveSecrets(tenant, process.env),
      runsDir: "runs",
      outDir: values.out,
      ...(channel ? { channel } : {}),
    });
    console.log(
      JSON.stringify(
        {
          capability: outcome.artifact.id,
          steps: outcome.report.steps.map((s) => s.id),
          targets: Object.keys(outcome.report.targets),
          flags: outcome.report.flags,
          verification: {
            status: outcome.verification.status,
            runId: outcome.verification.runId,
            ...(outcome.verification.status === "failure"
              ? { failure: outcome.verification.failure }
              : {}),
          },
          saved: outcome.saved ?? null,
        },
        null,
        2,
      ),
    );
    return outcome.saved ? 0 : 1;
  } finally {
    channel?.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
