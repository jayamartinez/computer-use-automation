// `{{scope.name}}` templates. Artifacts may only use `inputs`; profiles may also use `secrets`.

const TEMPLATE = /\{\{\s*([A-Za-z]+)\.([A-Za-z0-9_]+)\s*\}\}/g;

export type Scopes = Record<string, Record<string, string>>;

export function templateRefs(text: string): { scope: string; name: string }[] {
  return [...text.matchAll(TEMPLATE)].map((m) => ({ scope: m[1]!, name: m[2]! }));
}

export function render(text: string, scopes: Scopes): string {
  return text.replace(TEMPLATE, (_, scope: string, name: string) => {
    const value = scopes[scope]?.[name];
    if (value === undefined) throw new Error(`Unknown template reference {{${scope}.${name}}}`);
    return value;
  });
}

/** Renders every string inside a JSON-shaped value. */
export function renderDeep<T>(value: T, scopes: Scopes): T {
  if (typeof value === "string") return render(value, scopes) as T;
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, scopes)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderDeep(item, scopes)]),
    ) as T;
  }
  return value;
}

export function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(collectStrings);
  return [];
}
