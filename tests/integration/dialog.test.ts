// Native dialogs on the real app: the surface reports an open dialog as the `dialog` container,
// never answers it by itself, and answers it only when its button is clicked.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderDeep } from "../../src/artifact/template.ts";
import { PlaywrightSurface } from "../../src/surface/playwright/playwright-surface.ts";
import type { Target } from "../../src/surface/target.ts";
import { DIALOG_SCOPE, type SurfaceAction } from "../../src/surface/types.ts";
import { OPERATOR, startTestApp } from "../support/demo-app.ts";
import { coreservProfile } from "../support/fixtures.ts";

let app: Awaited<ReturnType<typeof startTestApp>>;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

const arm = (faults: object) =>
  fetch(`${app.url}/__admin/faults`, { method: "POST", body: JSON.stringify(faults) });

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Screen state not reached within 5 s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const named = (scope: string[], role: string, name: string): Target => ({
  scope,
  role,
  strategies: [{ kind: "role_name", name }],
  rationale: "test",
});

/** Signs in and opens member 10077's profile, where the armed dialog fires. */
async function openProfile(surface: PlaywrightSurface): Promise<void> {
  const act = async (target: Target, action: SurfaceAction = { kind: "click" }) => {
    await until(async () => (await surface.resolve(target)).kind === "unique");
    const found = await surface.resolve(target);
    if (found.kind !== "unique") throw new Error("not unique");
    await surface.act(found.handle, action);
  };
  const profile = await coreservProfile();
  for (const step of profile.login.steps) {
    await act(
      step.target,
      step.action === "fill"
        ? { kind: "fill", value: renderDeep(step.value, { secrets: OPERATOR }) }
        : { kind: "click" },
    );
  }
  await act(named(["nav"], "link", "Member Inquiry"));
  await act(
    {
      scope: ["workarea"],
      role: "textbox",
      strategies: [{ kind: "anchor", text: "Member Number", relation: "right_of" }],
      rationale: "test",
    },
    { kind: "fill", value: "10077" },
  );
  await act(named(["workarea"], "button", "Search"));
  await act(named(["workarea"], "link", "View"));
}

describe("PlaywrightSurface and native dialogs", () => {
  it("reports an open alert as the dialog container and holds it unanswered", async () => {
    await arm({ dialog: "profile" });
    const surface = await PlaywrightSurface.launch({ entryUrl: app.url, allowRequest: () => true });
    try {
      await openProfile(surface);
      await until(() => surface.matches({ scope: [DIALOG_SCOPE], textPresent: "password" }));

      const { elements } = await surface.observe();
      expect(elements.every((e) => e.scope[0] === DIALOG_SCOPE)).toBe(true);
      expect(elements.map((e) => `${e.role}:${e.name}`)).toEqual([
        expect.stringMatching(/^text:Your CoreServ password expires in 3 days/),
        "button:OK",
      ]);
      // Nothing answers it on its own: still open after a while, and the page is not captured.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await surface.matches({ scope: [DIALOG_SCOPE], textPresent: "password" })).toBe(true);
      expect(await surface.screenshot({ mask: [] })).toBeUndefined();

      // Clicking OK accepts it, and the profile behind it is observable again.
      const ok = await surface.resolve(named([DIALOG_SCOPE], "button", "OK"));
      if (ok.kind !== "unique") throw new Error("OK not found");
      await surface.act(ok.handle, { kind: "click" });
      await until(() => surface.matches({ scope: ["workarea"], textPresent: "Accounts" }));
      expect(await surface.matches({ scope: [DIALOG_SCOPE], textPresent: "password" })).toBe(false);
      expect((await surface.screenshot({ mask: [] }))!.subarray(1, 4).toString()).toBe("PNG");
    } finally {
      await surface.close();
    }
  });
});
