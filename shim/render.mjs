/**
 * Config renderers — plain JS so both the shim CLI (`claude-shim models <fmt>`)
 * and the TypeScript extension/mod can use the same code. Renders the one
 * shared catalog (models.mjs) into each harness's hand-written config shape.
 */

import { MODELS, DEFAULT_PORT } from "./models.mjs";

export const PROVIDER_ID = "claude-cli";
export const PROVIDER_NAME = "Claude (Pro/Max via claude CLI)";

/** Thinking efforts each model accepts, least → most intensive. */
export const EFFORTS_BY_MODEL = {
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-5": ["low", "medium", "high"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-5": ["low", "medium", "high"],
  "claude-haiku-4-5": ["low", "medium", "high"],
};

/** pi's full thinking ladder; levels a model lacks map to null. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

export const effortsFor = (id) => EFFORTS_BY_MODEL[id] ?? ["low", "medium", "high"];

export function render(fmt, port = DEFAULT_PORT) {
  const base = `http://127.0.0.1:${port}`;
  if (fmt === "providers-json") {
    return JSON.stringify(
      {
        provider: {
          [PROVIDER_ID]: {
            name: PROVIDER_NAME,
            api: "anthropic-messages",
            baseURL: `${base}/v1`,
            apiKey: false,
            models: Object.fromEntries(
              MODELS.map((m) => [
                m.id,
                { name: m.name, contextWindow: m.context, maxOutput: m.out, reasoningEfforts: effortsFor(m.id) },
              ]),
            ),
          },
        },
      },
      null,
      2,
    );
  }
  if (fmt === "models-yml") {
    return [
      "providers:",
      `  ${PROVIDER_ID}:`,
      `    baseUrl: ${base}/v1`,
      "    api: anthropic-messages",
      "    apiKey: claude-shim",
      "    disableStrictTools: true",
      "    models:",
      ...MODELS.flatMap((m) => [
        `      - id: ${m.id}`,
        `        name: ${m.name}`,
        "        reasoning: true",
        "        input: [text, image]",
        `        contextWindow: ${m.context}`,
        `        maxTokens: ${m.out}`,
        "        thinking:",
        "          mode: anthropic-adaptive",
        `          efforts: [${effortsFor(m.id).join(", ")}]`,
      ]),
    ].join("\n");
  }
  if (fmt === "models-json") {
    // pi: baseUrl is a prefix — pi appends /v1/messages itself, so no /v1 here.
    return JSON.stringify(
      {
        providers: {
          [PROVIDER_ID]: {
            name: PROVIDER_NAME,
            baseUrl: base,
            apiKey: "claude-shim",
            api: "anthropic-messages",
            models: MODELS.map((m) => ({
              id: m.id,
              name: m.name,
              reasoning: true,
              input: ["text", "image"],
              contextWindow: m.context,
              maxTokens: m.out,
              // pi reads thinkingLevelMap, not `efforts`: xhigh/max are hidden
              // unless mapped, and every other level shows unless nulled.
              thinkingLevelMap: Object.fromEntries([
                ["off", null],
                ...effortsFor(m.id).map((e) => [e, e]),
                ...THINKING_LEVELS.filter((l) => !effortsFor(m.id).includes(l)).map((l) => [l, null]),
              ]),
              // The shim takes an adaptive `effort`; without this pi sends a
              // thinkingBudgetTokens instead and the effort never reaches it.
              compat: { forceAdaptiveThinking: true },
            })),
          },
        },
      },
      null,
      2,
    );
  }
  throw new Error(`unknown format: ${fmt} (expected providers-json | models-yml | models-json)`);
}
