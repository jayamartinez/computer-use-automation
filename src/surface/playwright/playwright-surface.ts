import {
  chromium,
  type Browser,
  type Dialog,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import { makeObservation } from "../observation.ts";
import { firstMatching, maskedElements, matchesSignature, resolveTarget } from "../resolve.ts";
import type { Target } from "../target.ts";
import {
  DIALOG_SCOPE,
  type Handle,
  type HumanAction,
  type MaskRule,
  type Observation,
  type ObservedElement,
  type Resolution,
  type Signature,
  type Surface,
  type SurfaceAction,
} from "../types.ts";

/*
 * Runs in every document, in every frame, from the moment it loads. It reports the control a
 * person used (role, the name an operator sees, the frame), never what was typed. Reports are
 * dropped on the Node side unless a takeover is active, so automation's own clicks never count.
 */
function captureHumanActions(): void {
  const report = (kind: string, target: EventTarget | null) => {
    const el = (target as Element | null)?.closest?.("a, button, input, select, textarea");
    if (!el) return;
    const input = el instanceof HTMLInputElement ? el : null;
    const isButton =
      el instanceof HTMLButtonElement ||
      (input !== null && ["submit", "button", "reset"].includes(input.type));
    const role =
      el instanceof HTMLAnchorElement
        ? "link"
        : isButton
          ? "button"
          : el instanceof HTMLSelectElement
            ? "combobox"
            : "textbox";
    // A field is named the way an operator would: by the label cell to its left.
    const label = (el.closest("td")?.previousElementSibling as HTMLElement | null)?.innerText;
    const name = isButton
      ? (input?.value ?? (el as HTMLElement).innerText)
      : role === "link"
        ? (el as HTMLElement).innerText
        : (label ?? "");
    const scope = window.name ? [window.name] : [];
    (window as unknown as Record<string, (a: unknown) => void>).__coreservHumanAction?.({
      kind,
      role,
      name: name.replace(/\s+/g, " ").trim(),
      scope,
    });
  };
  document.addEventListener("click", (e) => report("click", e.target), true);
  document.addEventListener("change", (e) => report("change", e.target), true);
}

export type LaunchOptions = {
  entryUrl: string;
  /** Decides every request the browser makes, including frame loads and redirects. */
  allowRequest: (url: URL) => boolean;
  headed?: boolean;
  onBlocked?: (url: string) => void;
};

// Roles worth perceiving. Role computation is Playwright's ARIA implementation, so an
// <input type="submit"> is a button and a layout <td> is a cell without reading tag names here.
const ROLES = [
  "link",
  "button",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "heading",
  "cell",
  "columnheader",
  "rowheader",
];

type Raw = {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  name: string;
  value?: string;
};

const MAX_TEXT = 200;

/* Runs in the page. Reads what an operator could see; password values never leave the page. */
function describeRoleElements(elements: Element[], maxText: number): (Raw | null)[] {
  return elements.map((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const input = el instanceof HTMLInputElement ? el : null;
    const isButton = input !== null && ["submit", "button", "reset"].includes(input.type);
    const isField =
      (input !== null && !isButton) ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement;
    // A cell that wraps another table is layout; its text is the whole region, not a value.
    const isLayout = el.querySelector("table") !== null;
    const content = isButton
      ? input.value
      : isField || isLayout
        ? ""
        : ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, maxText);
    let value: string | undefined;
    if (el instanceof HTMLSelectElement) value = el.selectedOptions[0]?.text ?? "";
    else if (isField) {
      value =
        input?.type === "password" ? "" : (el as HTMLInputElement | HTMLTextAreaElement).value;
    }
    // A simplified accessible name: explicit label first, otherwise the element's own content.
    const label = isField ? (el as HTMLInputElement).labels?.[0]?.innerText : undefined;
    const name =
      el.getAttribute("aria-label") ??
      label ??
      (isField ? (el.getAttribute("title") ?? el.getAttribute("placeholder") ?? "") : content);
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, text: content, name, value };
  });
}

/* Runs in the page. Visible text is every element's own text nodes, like OCR lines. */
function describeTextElements(elements: Element[], maxText: number): (Raw | null)[] {
  const skipped = ["SCRIPT", "STYLE", "NOSCRIPT", "OPTION", "TEXTAREA"];
  return elements.map((el) => {
    if (skipped.includes(el.tagName)) return null;
    const own = [...el.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const rect = el.getBoundingClientRect();
    if (!own || rect.width === 0 || rect.height === 0) return null;
    const text = own.slice(0, maxText);
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, text, name: text };
  });
}

export class PlaywrightSurface implements Surface {
  private locators = new Map<string, Locator>();
  private observationId = "";
  // A native dialog blocks every frame of the page until it is answered, so the surface holds
  // it and reports it instead of the page. It answers only when the dialog's button is clicked.
  private dialog: Dialog | undefined;
  private dialogButtons = new Map<string, "accept" | "dismiss">();
  private readonly dialogWaiters = new Set<() => void>();
  private humanListener: ((action: HumanAction) => void) | undefined;

  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {
    // With a listener registered, Playwright no longer dismisses dialogs silently.
    page.on("dialog", (dialog) => {
      this.dialog = dialog;
      for (const wake of this.dialogWaiters) wake();
      this.humanListener?.({
        kind: "dialog",
        role: "dialog",
        name: dialog.type(),
        scope: [DIALOG_SCOPE],
        message: dialog.message(),
      });
    });
  }

  /**
   * Opens the entry point. There is no navigate action afterwards: the flow moves only by
   * acting on what is on screen. The request allowlist is enforced here, at the network layer,
   * because a click's destination is not known when policy approves the click.
   */
  static async launch(options: LaunchOptions): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({ headless: !options.headed });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (options.allowRequest(url)) return route.continue();
        options.onBlocked?.(`${url.origin}${url.pathname}`);
        return route.abort("blockedbyclient");
      });
      // Installed before anything loads, so every frame of every page can report a person's
      // actions during a takeover.
      const created: { surface?: PlaywrightSurface } = {};
      await context.exposeBinding("__coreservHumanAction", (_source, action: HumanAction) =>
        created.surface?.humanListener?.(action),
      );
      await context.addInitScript(captureHumanActions);
      const page = await context.newPage();
      const surface = new PlaywrightSurface(browser, page);
      created.surface = surface;
      await page.goto(options.entryUrl);
      return surface;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  async observe(): Promise<Observation> {
    if (this.dialog) return this.observeDialog(this.dialog);
    // A dialog that opens while the frames are being read would block that read until it is
    // answered, so the read races the dialog.
    let wake = (): void => {};
    const opened = new Promise<"dialog">((resolve) => {
      wake = () => resolve("dialog");
      this.dialogWaiters.add(wake);
    });
    const read = Promise.all(this.page.frames().map((frame) => this.observeFrame(frame)));
    const perFrame = await Promise.race([read, opened]).finally(() =>
      this.dialogWaiters.delete(wake),
    );
    if (perFrame === "dialog" || this.dialog) return this.observeDialog(this.dialog!);

    const locators = new Map<string, Locator>();
    const elements: ObservedElement[] = [];
    for (const found of perFrame.flat()) {
      const ref = `e${elements.length + 1}`;
      locators.set(ref, found.locator);
      elements.push({ ref, ...found.element });
    }
    const observation = makeObservation(elements);
    this.locators = locators;
    this.dialogButtons = new Map();
    this.observationId = observation.id;
    return observation;
  }

  /** What an operator sees while a dialog is open: its message and its buttons, nothing else. */
  private observeDialog(dialog: Dialog): Observation {
    const element = (role: string, text: string, x: number, y: number, width: number) => ({
      scope: [DIALOG_SCOPE],
      role,
      name: text,
      text,
      bounds: { x, y, width, height: 20 },
    });
    const buttons: ["OK" | "Cancel", "accept" | "dismiss"][] =
      dialog.type() === "alert"
        ? [["OK", "accept"]]
        : [
            ["OK", "accept"],
            ["Cancel", "dismiss"],
          ];
    const elements: ObservedElement[] = [
      { ref: "d1", ...element("text", dialog.message(), 0, 0, 420) },
      ...buttons.map(([name], i) => ({
        ref: `d${i + 2}`,
        ...element("button", name, 280 + i * 70, 40, 60),
      })),
    ];
    const observation = makeObservation(elements);
    this.locators = new Map();
    this.dialogButtons = new Map(buttons.map(([, answer], i) => [`d${i + 2}`, answer]));
    this.observationId = observation.id;
    return observation;
  }

  private async observeFrame(
    frame: Frame,
  ): Promise<{ locator: Locator; element: Omit<ObservedElement, "ref"> }[]> {
    // On this surface a scope is the path of frame names below the top document.
    const path: string[] = [];
    for (let f: Frame | null = frame; f?.parentFrame(); f = f.parentFrame()) path.unshift(f.name());

    const groups = [
      ...ROLES.map((role) => ({
        role,
        all: frame.getByRole(role as "link"),
        describe: describeRoleElements,
      })),
      { role: "text", all: frame.locator("body *"), describe: describeTextElements },
    ];
    try {
      const described = await Promise.all(
        groups.map((group) => group.all.evaluateAll(group.describe, MAX_TEXT)),
      );
      return groups.flatMap((group, g) =>
        (described[g] ?? []).flatMap((raw, index) =>
          raw === null
            ? []
            : [
                {
                  locator: group.all.nth(index),
                  element: {
                    scope: path,
                    role: group.role,
                    name: raw.name,
                    text: raw.text,
                    ...(raw.value === undefined ? {} : { value: raw.value }),
                    bounds: { x: raw.x, y: raw.y, width: raw.w, height: raw.h },
                  },
                },
              ],
        ),
      );
    } catch {
      // The frame is mid-navigation. It has no stable content this instant; callers poll.
      return [];
    }
  }

  async resolve(target: Target): Promise<Resolution> {
    const observation = await this.observe();
    const found = resolveTarget(observation.elements, target);
    if (found.kind !== "unique") return found;
    return { ...found, handle: { observationId: observation.id, ref: found.element.ref } };
  }

  async act(handle: Handle, action: SurfaceAction): Promise<void> {
    const answer = this.dialogButtons.get(handle.ref);
    if (answer && handle.observationId === this.observationId && this.dialog) {
      if (action.kind !== "click") throw new Error("A dialog's buttons can only be clicked.");
      const dialog = this.dialog;
      this.dialog = undefined;
      this.dialogButtons = new Map();
      await (answer === "accept" ? dialog.accept() : dialog.dismiss());
      return;
    }
    const locator = this.locators.get(handle.ref);
    if (handle.observationId !== this.observationId || !locator) {
      throw new Error(
        "Stale handle: the screen was observed again after this target was resolved.",
      );
    }
    switch (action.kind) {
      case "click":
        return locator.click();
      case "fill":
        return locator.fill(action.value);
      case "select":
        await locator.selectOption({ label: action.value });
        return;
      default:
        return action satisfies never;
    }
  }

  async watchHuman(listener: (action: HumanAction) => void): Promise<() => Promise<void>> {
    this.humanListener = listener;
    return async () => {
      if (this.humanListener === listener) this.humanListener = undefined;
    };
  }

  async matches(signature: Signature): Promise<boolean> {
    return matchesSignature(await this.observe(), signature);
  }

  async firstMatch(signatures: Signature[]): Promise<number | undefined> {
    return firstMatching(await this.observe(), signatures);
  }

  async screenshot(opts: { mask: MaskRule[] }): Promise<Buffer | undefined> {
    const observation = await this.observe();
    // The page cannot be captured while a dialog blocks it; the observation carries the dialog.
    if (this.dialog) return undefined;
    const mask = maskedElements(observation.elements, opts.mask).flatMap(
      (element) => this.locators.get(element.ref) ?? [],
    );
    return this.page.screenshot({ mask, maskColor: "#000000" });
  }
}
