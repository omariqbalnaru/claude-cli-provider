/**
 * Config renderers — plain JS so both the shim CLI (`claude-shim models <fmt>`)
 * and the TypeScript extension/mod can use the same code. Renders the one
 * shared catalog (models.mjs) into each harness's hand-written config shape.
 */

import { MODELS, ALIAS_MODELS, DEFAULT_PORT, EFFORTS_BY_MODEL, PROVIDER_ID, PROVIDER_NAME } from "./models.mjs";

export { PROVIDER_ID, PROVIDER_NAME };

/** Thinking efforts each model accepts — single source of truth in models.mjs. */
export { EFFORTS_BY_MODEL };

/** pi's full thinking ladder; levels a model lacks map to null. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

export const effortsFor = (id) => EFFORTS_BY_MODEL[id] ?? ["low", "medium", "high"];

export function render(fmt, port = DEFAULT_PORT) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
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
              compat: { forceAdaptiveThinking: true, sendSessionAffinityHeaders: true },
            })),
          },
        },
      },
      null,
      2,
    );
  }
  if (fmt === "opencode") {
    // opencode v2 config: `providers.<id>` with `package` + `settings` (v1's
    // `provider.<id>`, `npm`, `options` and the model `reasoning` flag are
    // deprecated there). The native anthropic-compatible package speaks the
    // Anthropic Messages protocol the shim already serves and appends
    // `/messages` itself, so only baseURL + model catalog differ.
    // opencode has no thinking API on this route, so each model also gets
    // `:effort` variants (the shim strips the suffix and passes it as the
    // CLI's --effort), and max-effort turns wait on the CLI past opencode's
    // default HTTP limits, so the block widens the timeouts.
    return JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        providers: {
          [PROVIDER_ID]: {
            name: PROVIDER_NAME,
            package: "@opencode/ai/providers/anthropic-compatible",
            settings: {
              baseURL: `${base}/v1`,
              apiKey: "claude-shim",
              headerTimeout: 600000,
              chunkTimeout: false,
            },
            models: Object.fromEntries(
              // The aliases only: each resolves to the newest release of its
              // family, so the picker never offers a superseded version.
              ALIAS_MODELS.flatMap((m) => [
                [m.id, { name: m.name, limit: { context: m.context, output: m.out } }],
                ...effortsFor(m.id).map((e) => [
                  `${m.id}:${e}`,
                  // "(low)", not "(low effort)": the picker gives the model name
                  // only the cells the provider label leaves over.
                  { name: `${m.name} (${e})`, limit: { context: m.context, output: m.out } },
                ]),
              ]),
            ),
          },
        },
      },
      null,
      2,
    );
  }
  throw new Error(`unknown format: ${fmt} (expected providers-json | models-yml | models-json | opencode)`);
}
