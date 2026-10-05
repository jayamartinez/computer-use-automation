import { chromium, type Browser, type Frame, type Locator, type Page } from "playwright";
import { makeObservation } from "../observation.ts";
import { firstMatching, maskedElements, matchesSignature, resolveTarget } from "../resolve.ts";
import type { Target } from "../target.ts";
import type {
  Handle,
  MaskRule,
  Observation,
  ObservedElement,
  Resolution,
  Signature,
  Surface,
  SurfaceAction,
} from "../types.ts";

export type NetworkPolicy = { origins: string[]; denyPaths: string[] };

export type LaunchOptions = {
  entryUrl: string;
  network: NetworkPolicy;
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

  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {}

  /**
   * Opens the entry point. There is no navigate action afterwards: the flow moves only by
   * acting on what is on screen. The origin allowlist is enforced here, at the network layer,
   * because a click's destination is not known when policy approves the click.
   */
  static async launch(options: LaunchOptions): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({ headless: !options.headed });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        const allowed =
          options.network.origins.includes(url.origin) &&
          !options.network.denyPaths.some((path) => url.pathname.startsWith(path));
        if (allowed) return route.continue();
        options.onBlocked?.(`${url.origin}${url.pathname}`);
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      await page.goto(options.entryUrl);
      return new PlaywrightSurface(browser, page);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  async observe(): Promise<Observation> {
    const locators = new Map<string, Locator>();
    const elements: ObservedElement[] = [];
    const perFrame = await Promise.all(this.page.frames().map((frame) => this.observeFrame(frame)));
    for (const found of perFrame.flat()) {
      const ref = `e${elements.length + 1}`;
      locators.set(ref, found.locator);
      elements.push({ ref, ...found.element });
    }
    const observation = makeObservation(elements);
    this.locators = locators;
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

  async matches(signature: Signature): Promise<boolean> {
    return matchesSignature(await this.observe(), signature);
  }

  async firstMatch(signatures: Signature[]): Promise<number | undefined> {
    return firstMatching(await this.observe(), signatures);
  }

  async screenshot(opts: { mask: MaskRule[] }): Promise<Buffer> {
    const observation = await this.observe();
    const mask = maskedElements(observation.elements, opts.mask).flatMap(
      (element) => this.locators.get(element.ref) ?? [],
    );
    return this.page.screenshot({ mask, maskColor: "#000000" });
  }
}
