import type { InputSpec, OutputSpec } from "../artifact/schema.ts";
import type { OutputValue } from "../outcome/result.ts";

/** Returns a reason when a caller-supplied input does not satisfy its declared type. */
export function inputProblem(value: string, spec: InputSpec): string | undefined {
  switch (spec.type) {
    case "string":
      break;
    case "integer":
      if (!/^-?\d+$/.test(value)) return "is not an integer";
      break;
    case "money":
      if (!/^\d+(\.\d{2})?$/.test(value)) return "is not a decimal amount";
      break;
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "is not a YYYY-MM-DD date";
      break;
    case "enum":
      if (!spec.values?.includes(value)) return "is not one of the allowed values";
      break;
    default:
      return spec.type satisfies never;
  }
  if (spec.pattern && !new RegExp(spec.pattern).test(value)) return "does not match its pattern";
  return undefined;
}

/** Turns extracted screen text into a typed output, or undefined when it does not parse. */
export function parseOutput(text: string, spec: OutputSpec): OutputValue | undefined {
  const raw = text.trim();
  switch (spec.type) {
    case "string":
    case "date":
      return raw === "" ? undefined : raw;
    case "enum":
      return spec.values?.includes(raw) ? raw : undefined;
    case "integer":
      return /^-?\d+$/.test(raw) ? Number(raw) : undefined;
    case "money": {
      // CoreServ prints money as $#,##0.00.
      const match = /^(-?)\$(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(raw);
      if (!match) return undefined;
      return {
        amount: `${match[1]}${match[2]!.replaceAll(",", "")}.${match[3]}`,
        currency: spec.currency ?? "USD",
      };
    }
    default:
      return spec.type satisfies never;
  }
}

export function outputAsText(value: OutputValue): string {
  return typeof value === "object" ? `${value.amount} ${value.currency}` : String(value);
}
