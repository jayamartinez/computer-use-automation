import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadArtifact } from "../artifact/store.ts";
import { loadProfile, loadTenant, resolveSecrets } from "../profile/load.ts";
import { runReplay } from "../replay/run.ts";

const USAGE = `Usage:
  replay <capability-id | artifact.json> --input name=value [--input ...] [--tenant lakeside] [--headed]

A capability id is looked up in capabilities/<id>.json.`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "replay") {
    console.error(USAGE);
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      input: { type: "string", multiple: true, default: [] },
      tenant: { type: "string", default: "lakeside" },
      headed: { type: "boolean", default: false },
    },
  });
  const [capability] = positionals;
  if (!capability) {
    console.error(USAGE);
    return 2;
  }
  if (existsSync(".env")) process.loadEnvFile(".env");

  const artifact = await loadArtifact(
    existsSync(capability) ? capability : join("capabilities", `${capability}.json`),
  );
  const profileDir = join("profiles", artifact.app.product);
  const profile = await loadProfile(join(profileDir, "profile.json"));
  const tenant = await loadTenant(join(profileDir, "tenants", `${values.tenant}.json`));

  const inputs: Record<string, string> = {};
  for (const pair of values.input) {
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error(`--input expects name=value, got "${pair}"`);
    inputs[pair.slice(0, separator)] = pair.slice(separator + 1);
  }

  const result = await runReplay({
    artifact,
    inputs,
    profile,
    tenant,
    secrets: resolveSecrets(tenant, process.env),
    runsDir: "runs",
    headed: values.headed,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.status === "failure" ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
