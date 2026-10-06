import type { Sensitivity } from "../artifact/schema.ts";

/** How a value may appear in a log. The caller of a capability still receives the real value. */
export function redact(value: string, sensitivity: Sensitivity): string {
  switch (sensitivity) {
    case "none":
      return value;
    case "identifier":
    case "account_number":
      return `***${value.slice(-2)}`;
    case "financial":
    case "pii":
      return `[${sensitivity}]`;
    default:
      return sensitivity satisfies never;
  }
}

export const SECRET = "[secret]";
