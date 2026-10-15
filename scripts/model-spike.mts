// Pre-M11 spike: can a model pick the right next action from this project's real observation
// format (element list plus screenshot) on the legacy CoreServ screens? Runs two one-shot
// decisions per model and reports correctness, latency and cost. Not part of the product.
//
//   pnpm exec tsx scripts/model-spike.mts [model ...]

import { readFileSync, writeFileSync } from "node:fs";
import { startCoreServ } from "../demo-app/server.ts";
import { PlaywrightSurface } from "../src/surface/playwright/playwright-surface.ts";
import type { Target } from "../src/surface/target.ts";
import type { Observation, SurfaceAction } from "../src/surface/types.ts";

for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
}
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) throw new Error("OPENROUTER_API_KEY missing");

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "openai/gpt-6-luna",
      "anthropic/claude-haiku-5.5",
      "google/gemini-3.5-flash-lite",
      "qwen/qwen3.5-flash-02-23",
      "deepseek/deepseek-v4.1-flash",
      "z-ai/glm-5.3-flash",
      "google/gemini-3.8-flash",
      "openai/gpt-5.4-mini",
      "qwen/qwen3-vl-30b-a3b-instruct",
      "x-ai/grok-4.3",
      "anthropic/claude-sonnet-5.5",
      "openai/gpt-6-sol",
    ];

const OPERATOR = {
  operatorId: process.env.CORESERV_OPERATOR_ID!,
  password: process.env.CORESERV_OPERATOR_PASSWORD!,
};

// ---------- drive the demo app to the two screens ----------

const anchorField = (scope: string[], text: string): Target => ({
  scope,
  role: "textbox",
  strategies: [{ kind: "anchor", text, relation: "right_of" }],
  rationale: "spike",
});
const named = (scope: string[], role: string, name: string): Target => ({
  scope,
  role,
  strategies: [{ kind: "role_name", name }],
  rationale: "spike",
});

const app = await startCoreServ({ port: 0, ...OPERATOR, supervisorCode: "spike-override" });
const surface = await PlaywrightSurface.launch({ entryUrl: app.url, allowRequest: () => true });

async function act(target: Target, action: SurfaceAction = { kind: "click" }) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const found = await surface.resolve(target);
    if (found.kind === "unique") return surface.act(found.handle, action);
    if (Date.now() > deadline) throw new Error(`could not resolve ${JSON.stringify(target)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function waitFor(target: Target) {
  const deadline = Date.now() + 8000;
  while ((await surface.resolve(target)).kind !== "unique") {
    if (Date.now() > deadline) throw new Error(`never saw ${JSON.stringify(target)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

await act(anchorField([], "Operator ID"), { kind: "fill", value: OPERATOR.operatorId });
await act(anchorField([], "Password"), { kind: "fill", value: OPERATOR.password });
await act(named([], "button", "Sign In"));
await act(named(["nav"], "link", "Member Inquiry"));
const W = ["workarea"];
await waitFor(anchorField(W, "Member Number"));

type Scene = { name: string; observation: Observation; image: string; goalState: string };
const capture = async (name: string, goalState: string): Promise<Scene> => ({
  name,
  observation: await surface.observe(),
  image: (await surface.screenshot({ mask: [] }))!.toString("base64"),
  goalState,
});

const sceneA = await capture(
  "search-form",
  "On the Member Inquiry search form, nothing entered yet.",
);
await act(anchorField(W, "Member Number"), { kind: "fill", value: "10042" });
await act(named(W, "button", "Search"));
await act(named(W, "link", "View"));
await waitFor(named(W, "button", "Open Sub-Account"));
const sceneB = await capture("member-profile", "On the member's profile after searching for them.");

await surface.close();
await app.close();

// ---------- the decision request, in the shape M11 will send ----------

const TOOLS = [
  tool("click", "Click a link or button.", { ref: str("Element ref from the observation") }),
  tool("fill", "Type into a text field.", {
    ref: str("Element ref"),
    value: {
      type: "object",
      description: "Where the text comes from. Prefer an input reference over retyping it.",
      properties: { input: str("Name of the input to use"), literal: str("Literal text") },
    },
  }),
  tool("select", "Choose an option in a dropdown.", {
    ref: str("Element ref"),
    option: str("Visible option label"),
  }),
  tool("extract", "Read a value from an element into a declared output.", {
    ref: str("Element ref whose text holds the value"),
    output: str("Name of the declared output"),
  }),
  tool("finish", "The goal is met. Cite the elements that prove it.", {
    summary: str("One sentence"),
    evidenceRefs: { type: "array", items: { type: "string" } },
  }),
  tool("need_human", "Stuck or unsafe; ask an operator.", { reason: str("Why") }),
  tool("give_up", "The goal cannot be met.", { reason: str("Why") }),
];
function str(description: string) {
  return { type: "string", description };
}
function tool(name: string, description: string, properties: Record<string, unknown>) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required: Object.keys(properties) },
    },
  };
}

const SYSTEM = `You operate a legacy bank back-office web application on behalf of an automation system. Each turn you see the current screen as a list of interactive and readable elements (with refs) and a screenshot. Choose exactly ONE next action by calling exactly one tool. Rules: never retype an input value as a literal when a fill can reference the input by name; only read values with extract into declared outputs; call finish only when every declared output has been extracted and the screen proves the goal.`;

const GOAL = {
  goal: "Look up the member and read their current savings balance.",
  inputs: { memberId: { type: "string", value: "10042" } },
  outputs: { savingsBalance: { type: "money", currency: "USD" } },
};

function renderElements(observation: Observation): string {
  return observation.elements
    .map((e) => {
      const where = e.scope.length ? e.scope.join("/") : "page";
      const bits = [`${e.ref}`, `[${where}]`, e.role];
      if (e.name) bits.push(`name="${e.name}"`);
      if (e.text && e.text !== e.name) bits.push(`text="${e.text.slice(0, 80)}"`);
      if (e.value !== undefined) bits.push(`value="${e.value}"`);
      return bits.join(" ");
    })
    .join("\n");
}

type Verdict = { ok: boolean; why: string };
function judge(
  scene: Scene,
  call: { name: string; args: Record<string, unknown> } | undefined,
): Verdict {
  if (!call) return { ok: false, why: "no tool call" };
  const el = scene.observation.elements.find((e) => e.ref === call.args.ref);
  if (scene.name === "search-form") {
    if (call.name !== "fill") return { ok: false, why: `expected fill, got ${call.name}` };
    // Unlabeled inputs carry no name in the observation; the Member Number field is the first
    // textbox in the work area, directly after its label cell.
    const first = scene.observation.elements.find(
      (e) => e.role === "textbox" && e.scope[0] === "workarea",
    );
    if (!el || el !== first)
      return {
        ok: false,
        why: `wrong element ${String(call.args.ref)} (${el?.role} "${el?.name}")`,
      };
    const value = call.args.value as { input?: string; literal?: string } | undefined;
    if (value?.input !== "memberId")
      return { ok: false, why: `value ${JSON.stringify(value)} is not {input: memberId}` };
    return { ok: true, why: "fill Member Number with {input: memberId}" };
  }
  if (call.name !== "extract") return { ok: false, why: `expected extract, got ${call.name}` };
  if (!el || !/2,480\.17/.test(el.text))
    return { ok: false, why: `wrong element ${String(call.args.ref)} ("${el?.text}")` };
  if (call.args.output !== "savingsBalance")
    return { ok: false, why: `output ${String(call.args.output)}` };
  return { ok: true, why: "extract the Savings balance cell into savingsBalance" };
}

async function decide(model: string, scene: Scene) {
  const body = {
    model,
    max_tokens: 400,
    temperature: 0,
    tools: TOOLS,
    tool_choice: "auto",
    usage: { include: true },
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Goal: ${GOAL.goal}\nInputs: ${JSON.stringify(GOAL.inputs)}\nOutputs to extract: ${JSON.stringify(GOAL.outputs)}\n` +
              `Context: ${scene.goalState}\n\nElements on screen:\n${renderElements(scene.observation)}`,
          },
          { type: "image_url", image_url: { url: `data:image/png;base64,${scene.image}` } },
        ],
      },
    ],
  };
  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const ms = Date.now() - started;
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || json.error) return { ms, error: JSON.stringify(json.error ?? json).slice(0, 200) };
  const choice = (
    json.choices as {
      message: {
        content?: string;
        tool_calls?: { function: { name: string; arguments: string } }[];
      };
    }[]
  )[0];
  if (!choice) return { ms, error: "no choices in response" };
  const tc = choice.message.tool_calls?.[0];
  let call: { name: string; args: Record<string, unknown> } | undefined;
  if (tc) {
    try {
      call = { name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") };
    } catch {
      call = { name: tc.function.name, args: {} };
    }
  }
  const usage = json.usage as { prompt_tokens: number; completion_tokens: number; cost?: number };
  return {
    ms,
    call,
    content: choice.message.content?.slice(0, 120),
    usage,
    verdict: judge(scene, call),
  };
}

const results: Record<string, unknown>[] = [];
let totalCost = 0;
for (const model of MODELS) {
  for (const scene of [sceneA, sceneB]) {
    const r = await decide(model, scene);
    const cost = r.usage?.cost ?? 0;
    totalCost += cost;
    results.push({ model, scene: scene.name, ...r });
    const status = r.error
      ? `ERROR ${r.error}`
      : `${r.verdict!.ok ? "PASS" : "FAIL"} ${r.verdict!.why}`;
    console.log(
      `${model.padEnd(34)} ${scene.name.padEnd(15)} ${String(r.ms).padStart(6)}ms  $${cost.toFixed(4)}  ${status}`,
    );
  }
}
console.log(
  `\nelements per scene: A=${sceneA.observation.elements.length} B=${sceneB.observation.elements.length}; total cost $${totalCost.toFixed(4)}`,
);
writeFileSync("runs/model-spike.json", JSON.stringify({ results, totalCost }, null, 2));
writeFileSync(
  "runs/model-spike-scenes.txt",
  [sceneA, sceneB].map((s) => `== ${s.name}\n${renderElements(s.observation)}`).join("\n\n"),
);
