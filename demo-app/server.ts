// CoreServ 7.2: a fake legacy core-banking back office. Standalone; never imports from src/.
//
// Every screen is served from /cs.do?act=<token>. Tokens are random and minted per session, so
// a URL says nothing about which screen it leads to.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { seedMembers, type Member } from "./data.ts";
import * as pages from "./pages.ts";

export type CoreServConfig = { port: number; operatorId: string; password: string };

type Action =
  | { screen: "login" }
  | { screen: "banner" }
  | { screen: "nav" }
  | { screen: "main_menu" }
  | { screen: "inquiry" }
  | { screen: "search" }
  | { screen: "profile"; memberId: string };

type Session = { authenticated: boolean; actions: Map<string, Action> };

// Server-side fault injection, set through the admin endpoint. Faults that show a screen
// (notice, session expiry, application error) arrive with those screens.
type Faults = { latencyMs: number };
const NO_FAULTS: Faults = { latencyMs: 0 };
const MAX_LATENCY_MS = 60_000;

const COOKIE = "CSSESSION";

export async function startCoreServ(
  config: CoreServConfig,
): Promise<{ url: string; close: () => Promise<void> }> {
  let members: Member[] = seedMembers();
  let faults: Faults = NO_FAULTS;
  const sessions = new Map<string, Session>();

  const link = (session: Session, action: Action): string => {
    const token = randomBytes(8).toString("hex");
    session.actions.set(token, action);
    return `/cs.do?act=${token}`;
  };

  const render = (session: Session, action: Action, form: URLSearchParams): string => {
    switch (action.screen) {
      case "login":
        return pages.loginPage(link(session, { screen: "login" }));
      case "banner":
        return pages.bannerPage(config.operatorId);
      case "nav":
        return pages.navPage({
          mainMenu: link(session, { screen: "main_menu" }),
          memberInquiry: link(session, { screen: "inquiry" }),
        });
      case "main_menu":
        return pages.mainMenuPage(config.operatorId);
      case "inquiry":
        return pages.inquiryPage(link(session, { screen: "search" }));
      case "search": {
        const memberNo = (form.get("f1") ?? "").trim();
        const lastName = (form.get("f2") ?? "").trim().toLowerCase();
        if (!memberNo && !lastName) {
          return pages.inquiryPage(
            link(session, { screen: "search" }),
            "Enter a member number or a last name.",
          );
        }
        const found = members.filter((m) =>
          memberNo ? m.id === memberNo : m.lastName.toLowerCase() === lastName,
        );
        return pages.resultsPage(
          found.map((member) => ({
            member,
            view: link(session, { screen: "profile", memberId: member.id }),
          })),
        );
      }
      case "profile": {
        const member = members.find((m) => m.id === action.memberId);
        if (!member) return pages.messagePage("Member Profile", "Member record not available.");
        if (member.restricted) {
          return pages.messagePage(
            "Member Profile",
            "Access restricted. Employee accounts require Member Services authorization.",
          );
        }
        return pages.profilePage(member);
      }
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://coreserv.local");
    const html = (body: string, status = 200) => {
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
    };

    if (url.pathname === "/__admin/reset" && req.method === "POST") {
      members = seedMembers();
      sessions.clear();
      faults = NO_FAULTS;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url.pathname === "/__admin/faults" && req.method === "POST") {
      const update = parseFaults(await readBody(req));
      if (!update) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(`Expected JSON like {"latencyMs": 300} (0 to ${MAX_LATENCY_MS})`);
        return;
      }
      faults = { ...faults, ...update };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(faults));
      return;
    }

    if (faults.latencyMs > 0) await new Promise((r) => setTimeout(r, faults.latencyMs));

    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .find(([name]) => name === COOKIE)?.[1];
    let session = cookie ? sessions.get(cookie) : undefined;
    if (!session) {
      const id = randomBytes(16).toString("hex");
      session = { authenticated: false, actions: new Map() };
      sessions.set(id, session);
      res.setHeader("set-cookie", `${COOKIE}=${id}; Path=/; HttpOnly`);
    }

    if (url.pathname === "/") {
      if (!session.authenticated)
        return html(render(session, { screen: "login" }, new URLSearchParams()));
      return html(
        pages.shellPage({
          banner: link(session, { screen: "banner" }),
          nav: link(session, { screen: "nav" }),
          workarea: link(session, { screen: "main_menu" }),
        }),
      );
    }

    if (url.pathname !== "/cs.do") return html(pages.messagePage("CoreServ", "Not found."), 404);

    const action = session.actions.get(url.searchParams.get("act") ?? "");
    const form =
      req.method === "POST" ? new URLSearchParams(await readBody(req)) : new URLSearchParams();

    if (action?.screen === "login") {
      if (form.get("f1") === config.operatorId && form.get("f2") === config.password) {
        session.authenticated = true;
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }
      return html(
        pages.loginPage(link(session, { screen: "login" }), "Invalid operator ID or password."),
      );
    }
    if (!session.authenticated || !action) {
      return html(
        pages.messagePage("CoreServ", "This page is no longer available. Sign in again."),
      );
    }
    return html(render(session, action, form));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("error");
    });
  });
  await new Promise<void>((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function parseFaults(body: string): Partial<Faults> | undefined {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const { latencyMs, ...unknown } = data as Record<string, unknown>;
  if (Object.keys(unknown).length > 0) return undefined;
  if (latencyMs === undefined) return {};
  const valid =
    typeof latencyMs === "number" &&
    Number.isInteger(latencyMs) &&
    latencyMs >= 0 &&
    latencyMs <= MAX_LATENCY_MS;
  return valid ? { latencyMs } : undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
