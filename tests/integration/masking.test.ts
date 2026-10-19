// Every screen an evidence file can capture, walked on the real app: what the profile's mask rules
// leave in a saved observation dump must not identify the member, the operator or any amount.

import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderDeep } from "../../src/artifact/template.ts";
import type { Profile } from "../../src/profile/schema.ts";
import { PlaywrightSurface } from "../../src/surface/playwright/playwright-surface.ts";
import { maskObservation, maskedElements } from "../../src/surface/resolve.ts";
import type { Strategy, Target } from "../../src/surface/target.ts";
import type { SurfaceAction } from "../../src/surface/types.ts";
import { OPERATOR, SUPERVISOR, startTestApp } from "../support/demo-app.ts";
import { coreservProfile } from "../support/fixtures.ts";

let app: Awaited<ReturnType<typeof startTestApp>>;
let surface: PlaywrightSurface;
let profile: Profile;

const target = (scope: string[], role: string, strategy: Strategy): Target => ({
  scope,
  role,
  strategies: [strategy],
  rationale: "test",
});
const button = (name: string) => target(["workarea"], "button", { kind: "role_name", name });
const beside = (role: string, text: string) =>
  target(["workarea"], role, { kind: "anchor", text, relation: "right_of" });

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Screen state not reached within 5 s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function act(t: Target, action: SurfaceAction = { kind: "click" }): Promise<void> {
  await until(async () => (await surface.resolve(t)).kind === "unique");
  const found = await surface.resolve(t);
  if (found.kind !== "unique") throw new Error("not unique");
  await surface.act(found.handle, action);
}

const shown = (text: string) => until(() => surface.matches({ textPresent: text }));

/** The masked dump a failure would save for the current screen, as text. */
async function dump(): Promise<string> {
  return JSON.stringify(maskObservation(await surface.observe(), profile.masks));
}

// Never in evidence: the member number (alone or inside an account number), the member's name,
// balances and amounts, the operator ID and the supervisor's ID.
const SENSITIVE = [
  "10077",
  "Marcus",
  "Oyelaran",
  "15,902.66",
  "4,210.05",
  "15902.66",
  "3,000.00",
  "3000.00",
  OPERATOR.operatorId,
  SUPERVISOR.id,
  SUPERVISOR.id.toUpperCase(),
];

beforeAll(async () => {
  app = await startTestApp();
  profile = await coreservProfile();
  surface = await PlaywrightSurface.launch({ entryUrl: app.url, allowRequest: () => true });
  for (const step of profile.login.steps) {
    await act(
      step.target,
      step.action === "fill"
        ? { kind: "fill", value: renderDeep(step.value, { secrets: OPERATOR }) }
        : { kind: "click" },
    );
  }
  await until(() => surface.matches(profile.login.authenticated));
});

afterAll(async () => {
  await surface?.close();
  await app?.close();
});

describe("saved evidence masking on every CoreServ screen", () => {
  it("leaves no member number, name, amount or operator id in any dump", async () => {
    const dumps: Record<string, string> = {};
    await shown("Main Menu");
    dumps.mainMenu = await dump();

    await act(target(["nav"], "link", { kind: "role_name", name: "Member Inquiry" }));
    await act(beside("textbox", "Member Number"), { kind: "fill", value: "10077" });
    dumps.inquiry = await dump();
    await act(button("Search"));
    await shown("1 member(s) found");
    dumps.results = await dump();

    await act(target(["workarea"], "link", { kind: "role_name", name: "View" }));
    await shown("Accounts");
    dumps.profile = await dump();

    await act(button("Open Sub-Account"));
    await act(beside("combobox", "Account Type *"), { kind: "select", value: "Certificate" });
    await act(beside("textbox", "Nickname *"), { kind: "fill", value: "Big One" });
    await act(beside("textbox", "Opening Deposit *"), { kind: "fill", value: "3000.00" });
    dumps.form = await dump();

    await act(button("Continue"));
    await shown("Teller limit exceeded");
    await act(beside("textbox", "Supervisor ID"), { kind: "fill", value: SUPERVISOR.id });
    dumps.override = await dump();
    await act(beside("textbox", "Override Code"), { kind: "fill", value: SUPERVISOR.code });
    await act(button("Authorize"));
    await shown("Pending Transaction");
    dumps.review = await dump();

    await act(button("Confirm"));
    await shown("Sub-account opened.");
    dumps.confirmation = await dump();
    // Control: without the rules, the same screen does show these values.
    const raw = JSON.stringify(await surface.observe());
    for (const value of ["10077", OPERATOR.operatorId, "3,000.00"]) {
      expect(raw).toContain(value);
    }

    for (const [screen, text] of Object.entries(dumps)) {
      for (const value of SENSITIVE) {
        expect(text, `${screen} contains ${value}`).not.toContain(value);
      }
      expect(text, `${screen} contains the override code`).not.toContain(SUPERVISOR.code);
    }
    // Labels, types and the confirmation reference stay readable for debugging.
    expect(dumps.confirmation).toContain("New Account No");
    expect(dumps.confirmation).toContain("Certificate");
    expect(dumps.confirmation).toMatch(/OSA-\d{4}-\d{4}/);
    expect(dumps.review).toContain("Opening Deposit");
    // The button under the Accounts table is not in the Account No column: masking it put its
    // name on discovery's scrub list, which erased it from the trace.
    expect(dumps.profile).toContain('"name":"Open Sub-Account"');
  });

  it("masks the operator id in screenshots as well as in dumps", async () => {
    const observation = await surface.observe();
    const masked = maskedElements(observation.elements, profile.masks);
    expect(masked.some((e) => e.scope[0] === "banner" && e.text.includes("Operator:"))).toBe(true);
    const png = await surface.screenshot({ mask: profile.masks });
    expect(png!.subarray(1, 4).toString()).toBe("PNG");
    if (process.env.MASKING_SHOT) writeFileSync(process.env.MASKING_SHOT, png!);
  });
});
