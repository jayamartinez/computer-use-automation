import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR, SUPERVISOR, startTestApp } from "../support/demo-app.ts";

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

/** A minimal HTTP operator: keeps the session cookie and follows the page's own links. */
async function session() {
  let cookie = "";
  const get = async (path: string, body?: Record<string, string>) => {
    const response = await fetch(`${app.url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(body ? { body: new URLSearchParams(body).toString() } : {}),
      redirect: "manual",
    });
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
    return { status: response.status, html: await response.text() };
  };
  const links = (html: string): string[] =>
    [...html.matchAll(/\/cs\.do\?act=[0-9a-f]+/g)].map((m) => m[0]);
  return { get, links };
}

async function signedIn() {
  const s = await session();
  const login = await s.get("/");
  await s.get(s.links(login.html)[0]!, { f1: OPERATOR.operatorId, f2: OPERATOR.password });
  const [banner, nav, workarea] = s.links((await s.get("/")).html);
  return { ...s, banner: banner!, nav: nav!, workarea: workarea! };
}

async function search(s: Awaited<ReturnType<typeof signedIn>>, form: Record<string, string>) {
  const inquiry = await s.get(s.links((await s.get(s.nav)).html)[1]!);
  return s.get(s.links(inquiry.html)[0]!, form);
}

describe("CoreServ demo app", () => {
  it("rejects a wrong password and serves nothing behind the login", async () => {
    const s = await session();
    const login = await s.get("/");
    const denied = await s.get(s.links(login.html)[0]!, { f1: OPERATOR.operatorId, f2: "wrong" });
    expect(denied.html).toContain("Invalid operator ID or password");
    expect((await s.get("/")).html).toContain("Operator Sign In");
  });

  it("serves a three-frame shell whose URLs do not reveal state", async () => {
    const a = await signedIn();
    const b = await signedIn();
    const shell = (await a.get("/")).html;
    expect(shell).toMatch(
      /<frame name="banner"[\s\S]*<frame name="nav"[\s\S]*<frame name="workarea"/,
    );
    expect((await a.get(a.banner)).html).toContain("CoreServ 7.2");
    // The same screen has a different opaque URL in every session and on every render.
    expect(a.nav).not.toBe(b.nav);
    expect(a.links(shell)).not.toContain(a.nav);
    // Another session's token is meaningless here.
    expect((await a.get(b.nav)).html).toContain("no longer available");
  });

  it("looks up members and shows their balances", async () => {
    const s = await signedIn();
    for (const [memberId, savings] of [
      ["10042", "$2,480.17"],
      ["10077", "$15,902.66"],
    ] as const) {
      const results = await search(s, { f1: memberId, f2: "" });
      expect(results.html).toContain(memberId);
      const profile = await s.get(s.links(results.html)[0]!);
      expect(profile.html).toContain("Member Profile");
      expect(profile.html).toContain(savings);
    }
  });

  it("shows the two business outcomes of the lookup flow", async () => {
    const s = await signedIn();
    expect((await search(s, { f1: "99999", f2: "" })).html).toContain("No members match");
    const restricted = await search(s, { f1: "10200", f2: "" });
    expect((await s.get(s.links(restricted.html)[0]!)).html).toContain("Access restricted");
    expect((await search(s, { f1: "", f2: "nguyen" })).html).toContain("2 member(s) found");
  });

  it("has no ids, labels, test hooks or accessible names in its markup", async () => {
    const s = await signedIn();
    const results = await search(s, { f1: "10077", f2: "" });
    const pages = [
      (await (await session()).get("/")).html,
      (await s.get(s.nav)).html,
      (await s.get(s.links((await s.get(s.nav)).html)[1]!)).html,
      results.html,
      (await s.get(s.links(results.html)[0]!)).html,
    ];
    for (const html of pages) {
      expect(html).not.toMatch(/\sid=|<label|data-test|aria-|placeholder=|title=|<th[\s>]|class=/i);
    }
  });

  it("fires each screen fault once, on the screen it was armed for", async () => {
    const arm = (faults: object) =>
      fetch(`${app.url}/__admin/faults`, { method: "POST", body: JSON.stringify(faults) });
    const s = await signedIn();
    const inquiryLink = () => s.get(s.nav).then(({ html }) => s.links(html)[1]!);

    // Notice: shown instead of the search results; Acknowledge continues with the same form.
    await arm({ notice: "search" });
    const inquiry = await s.get(await inquiryLink());
    expect(inquiry.html).toContain("Member Number");
    const notice = await s.get(s.links(inquiry.html)[0]!, { f1: "10077", f2: "" });
    expect(notice.html).toContain("System Notice");
    expect(notice.html).toContain('value="Acknowledge"');
    const continued = await s.get(s.links(notice.html)[0]!, {});
    expect(continued.html).toContain("1 member(s) found");

    // Application error: an HTTP 500 page, once.
    await arm({ error500: "inquiry" });
    const error = await s.get(await inquiryLink());
    expect(error.status).toBe(500);
    expect(error.html).toContain("Application Error");
    expect((await s.get(await inquiryLink())).html).toContain("Member Number");

    // Session expiry: every later request shows the expired page until the operator signs in.
    await arm({ expireSession: "inquiry" });
    const nav = s.nav;
    const expired = await s.get(s.links((await s.get(nav)).html)[1]!);
    expect(expired.html).toContain("Your session has expired");
    expect(expired.html).toContain('href="/" target="_top">Sign in again');
    expect((await s.get(nav)).html).toContain("Your session has expired");
    const login = await s.get("/");
    expect(login.html).toContain("Operator Sign In");
    await s.get(s.links(login.html)[0]!, { f1: OPERATOR.operatorId, f2: OPERATOR.password });
    expect((await s.get("/")).html).toContain('<frame name="workarea"');
  });

  it("injects latency through the faults endpoint and validates what it is given", async () => {
    const faults = (body: string) => fetch(`${app.url}/__admin/faults`, { method: "POST", body });
    expect((await faults('{"latencyMs": 250}')).status).toBe(200);
    const started = Date.now();
    await fetch(`${app.url}/`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    for (const bad of [
      "nope",
      '{"latencyMs": -1}',
      '{"latencyMs": 1.5}',
      '{"other": 1}',
      "[]",
      '{"notice": "banner"}',
      '{"error500": true}',
    ]) {
      expect((await faults(bad)).status).toBe(400);
    }
    expect(await (await faults('{"latencyMs": 0}')).json()).toEqual({ latencyMs: 0 });
  });

  it("validates the fault endpoint's commitThen500 and dialog settings", async () => {
    const faults = (body: string) => fetch(`${app.url}/__admin/faults`, { method: "POST", body });
    expect((await faults('{"commitThen500": "yes"}')).status).toBe(400);
    expect((await faults('{"dialog": "nowhere"}')).status).toBe(400);
    expect((await faults('{"commitThen500": false, "dialog": null}')).status).toBe(200);
  });

  it("resets through the admin endpoint", async () => {
    const s = await signedIn();
    expect((await fetch(`${app.url}/__admin/reset`, { method: "POST" })).status).toBe(200);
    expect((await s.get("/")).html).toContain("Operator Sign In");
  });
});

describe("CoreServ demo app: open sub-account", () => {
  const reset = () => fetch(`${app.url}/__admin/reset`, { method: "POST" });
  const arm = (faults: object) =>
    fetch(`${app.url}/__admin/faults`, { method: "POST", body: JSON.stringify(faults) });

  /** Signs in, opens the member's profile and returns the profile and the sub-account form. */
  async function openForm(memberId: string) {
    const s = await signedIn();
    const results = await search(s, { f1: memberId, f2: "" });
    const profile = await s.get(s.links(results.html)[0]!);
    const form = await s.get(s.links(profile.html)[0]!, {});
    return { s, profile, form };
  }

  const fields = (type: string, nickname: string, deposit: string, b = "Continue") => ({
    f1: type,
    f2: nickname,
    f3: deposit,
    b,
  });

  it("opens a sub-account through form, review and confirmation", async () => {
    await reset();
    const { s, profile, form } = await openForm("10077");
    expect(profile.html).toContain('value="Open Sub-Account"');
    expect(form.html).toContain("Available Balance");
    expect(form.html).toContain("$15,902.66");

    const review = await s.get(
      s.links(form.html)[0]!,
      fields("Money Market", "Vacation Fund", "500.00"),
    );
    expect(review.html).toContain("Review Sub-Account");
    expect(review.html).toContain("Pending Transaction");
    for (const text of ["10077", "Money Market", "Vacation Fund", "$500.00", "Not required"]) {
      expect(review.html).toContain(text);
    }
    expect(review.html).not.toContain("Sub-account opened");

    const done = await s.get(s.links(review.html)[0]!, { b: "Confirm" });
    expect(done.html).toContain("Sub-Account Confirmation");
    expect(done.html).toContain("Sub-account opened.");
    expect(done.html).toContain("4000-10077-03");
    expect(done.html).toMatch(/OSA-\d{4}-\d{4}/);

    // The new account is on the profile and the deposit left Savings.
    const after = await s.get(s.links(done.html)[0]!);
    expect(after.html).toContain("4000-10077-03");
    expect(after.html).toContain("$15,402.66");
  });

  it("has no idempotency: submitting the same review twice opens two accounts", async () => {
    await reset();
    const { s, form } = await openForm("10077");
    const review = await s.get(s.links(form.html)[0]!, fields("Certificate", "Twice", "10"));
    const confirm = s.links(review.html)[0]!;
    expect((await s.get(confirm, { b: "Confirm" })).html).toContain("4000-10077-03");
    expect((await s.get(confirm, { b: "Confirm" })).html).toContain("4000-10077-04");
  });

  it("rejects a deposit above Savings before the teller limit, keeping the values", async () => {
    await reset();
    const { s, form } = await openForm("10077");
    const rejected = await s.get(
      s.links(form.html)[0]!,
      fields("Certificate", "Emergency Fund", "20000.00"),
    );
    expect(rejected.html).toContain("Opening deposit exceeds available balance");
    expect(rejected.html).not.toContain("Supervisor Override Required");
    expect(rejected.html).toContain('value="Emergency Fund"');
    expect(rejected.html).toContain('value="20000.00"');
    expect(rejected.html).toContain('<option value="Certificate" selected>');
  });

  it("shows a validation error for missing or malformed fields", async () => {
    await reset();
    const { s, form } = await openForm("10077");
    for (const bad of [
      fields("", "Name", "10"),
      fields("Certificate", "", "10"),
      fields("Certificate", "Bad<name>", "10"),
      fields("Certificate", "Name", "$10"),
      fields("Certificate", "Name", "0"),
    ]) {
      const page = await s.get(s.links(form.html)[0]!, bad);
      expect(page.html).toContain("Complete all required fields.");
    }
  });

  it("requires a supervisor override above $2,500.00", async () => {
    await reset();
    const { s, form } = await openForm("10077");
    const override = await s.get(
      s.links(form.html)[0]!,
      fields("Certificate", "Big One", "3000.00"),
    );
    expect(override.html).toContain("Supervisor Override Required");
    expect(override.html).toContain("$3,000.00");
    expect(override.html).toContain("$2,500.00");
    expect(override.html).toContain('type="password"');

    const wrong = await s.get(s.links(override.html)[0]!, {
      f1: SUPERVISOR.id,
      f2: "wrong",
      b: "Authorize",
    });
    expect(wrong.html).toContain("Override code not accepted.");

    const review = await s.get(s.links(wrong.html)[0]!, {
      f1: SUPERVISOR.id,
      f2: SUPERVISOR.code,
      b: "Authorize",
    });
    expect(review.html).toContain("Review Sub-Account");
    expect(review.html).toContain("Approved (SUP02)");
    expect(review.html).not.toContain(SUPERVISOR.code);
  });

  it("returns to the form on override Cancel and Back, and to the profile on Cancel", async () => {
    await reset();
    const { s, form } = await openForm("10077");
    const override = await s.get(s.links(form.html)[0]!, fields("Certificate", "Big", "2600"));
    const cancelled = await s.get(s.links(override.html)[0]!, { f1: "", f2: "", b: "Cancel" });
    expect(cancelled.html).toContain("Complete the fields below");
    expect(cancelled.html).toContain('value="2600"');

    const review = await s.get(s.links(cancelled.html)[0]!, fields("Certificate", "Small", "25"));
    const back = await s.get(s.links(review.html)[0]!, { b: "Back" });
    expect(back.html).toContain('value="Small"');
    const review2 = await s.get(s.links(back.html)[0]!, fields("Certificate", "Small", "25"));
    const profile = await s.get(s.links(review2.html)[0]!, { b: "Cancel" });
    expect(profile.html).toContain("Member Profile");
    expect(profile.html).not.toContain("4000-10077-03");
  });

  it("commitThen500 commits the account and then shows the application error, once", async () => {
    await reset();
    const { s, form } = await openForm("10077");
    const review = await s.get(s.links(form.html)[0]!, fields("Money Market", "Ghost", "100"));
    await arm({ commitThen500: true });
    const error = await s.get(s.links(review.html)[0]!, { b: "Confirm" });
    expect(error.status).toBe(500);
    expect(error.html).toContain("Application Error");
    expect(error.html).not.toContain("Sub-account opened");

    // The account exists anyway.
    const results = await search(s, { f1: "10077", f2: "" });
    const profile = await s.get(s.links(results.html)[0]!);
    expect(profile.html).toContain("4000-10077-03");

    // Fired once: the next Confirm succeeds normally.
    const form2 = await s.get(s.links(profile.html)[0]!, {});
    const review2 = await s.get(s.links(form2.html)[0]!, fields("Money Market", "Real", "100"));
    expect((await s.get(s.links(review2.html)[0]!, { b: "Confirm" })).status).toBe(200);
  });

  it("raises a native alert on the armed screen, once", async () => {
    await reset();
    await arm({ dialog: "subaccount" });
    const { s, profile, form } = await openForm("10077");
    expect(profile.html).not.toContain("<script>");
    expect(form.html).toContain("<script>alert(");
    expect(form.html).toContain("password expires in 3 days");
    const again = await s.get(s.links(profile.html)[0]!, {});
    expect(again.html).not.toContain("<script>");
  });

  it("renders write-path screens without ids, labels or test hooks", async () => {
    await reset();
    const { s, profile, form } = await openForm("10077");
    const override = await s.get(s.links(form.html)[0]!, fields("Certificate", "Big", "3000"));
    const review = await s.get(s.links(override.html)[0]!, {
      f1: SUPERVISOR.id,
      f2: SUPERVISOR.code,
      b: "Authorize",
    });
    const done = await s.get(s.links(review.html)[0]!, { b: "Confirm" });
    for (const html of [profile.html, form.html, override.html, review.html, done.html]) {
      expect(html).not.toMatch(/\sid=|<label|data-test|aria-|placeholder=|title=|<th[\s>]|class=/i);
    }
  });

  // D21: design notes live only in Paper. Phrases that only the notes artboards use must never
  // be rendered, so they can never reach a screenshot or an observation dump.
  it("never renders text from the Paper notes artboards", async () => {
    await reset();
    const pages: string[] = [];
    const keep = <T extends { html: string }>(page: T): T => {
      pages.push(page.html);
      return page;
    };
    const { s, profile, form } = await openForm("10077");
    keep(profile);
    keep(form);
    keep(await s.get(s.links(form.html)[0]!, fields("Certificate", "X", "20000")));
    const override = keep(await s.get(s.links(form.html)[0]!, fields("Certificate", "X", "3000")));
    const review = keep(
      await s.get(s.links(override.html)[0]!, { f1: "a", f2: SUPERVISOR.code, b: "Authorize" }),
    );
    await arm({ commitThen500: true });
    keep(await s.get(s.links(review.html)[0]!, { b: "Confirm" }));
    keep(await s.get(s.links(review.html)[0]!, { b: "Confirm" }));
    await arm({ notice: "inquiry" });
    keep(await s.get(s.links((await s.get(s.nav)).html)[1]!));
    await arm({ expireSession: "inquiry" });
    keep(await s.get(s.links((await s.get(s.nav)).html)[1]!));

    const notes = [
      /Paper only/i,
      /annotation/i,
      /Masked in evidence/i,
      /outcome_unknown|sideEffects|safeToRetry|business outcome|disposition/i,
      /Signature:/,
      /Acknowledge continues to the page you requested/,
      /The link replaces the whole window/,
      /Not on this screen/,
      /New on this screen/,
      /Reached from Member Profile/,
    ];
    expect(pages).toHaveLength(9);
    for (const html of pages) for (const note of notes) expect(html).not.toMatch(note);
  });
});
