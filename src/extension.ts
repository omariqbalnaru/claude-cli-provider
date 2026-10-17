/**
 * OMP / pi extension: registers the `claude-cli` provider and boots the shim.
 *
 * Both harnesses load this from the `pi.extensions` package.json key and expose
 * the same `ExtensionAPI`, so one file serves both. The provider is declared
 * with OMP/pi's built-in `anthropic-messages` api pointing at the local shim —
 * no custom api id, so no per-host stream function and no compat imports.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODELS, PROVIDER_ID, PROVIDER_NAME } from "./models.ts";
import { BASE, ensureShim } from "./launcher.mjs";

/** pi's full thinking ladder, in order. Levels outside a model's set map to null. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerProvider(PROVIDER_ID, {
    // No trailing /v1: pi appends /v1/messages itself, and OMP accepts either.
    baseUrl: BASE,
    apiKey: "claude-shim",
    api: "anthropic-messages",
    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      contextWindow: m.context,
      maxTokens: m.out,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // OMP reads `thinking`; pi reads `thinkingLevelMap`. Emit both so the
      // thinking menu matches what the shim actually accepts (low→max, no
      // minimal) in either harness.
      thinking: { mode: "anthropic-adaptive", efforts: m.efforts },
      // pi hides xhigh/max unless mapped, and shows `minimal` unless nulled.
      // `off` is null because pi signals "no reasoning" by omitting the effort.
      thinkingLevelMap: Object.fromEntries([
        ["off", null],
        ...m.efforts.map((e) => [e, e]),
        ...THINKING_LEVELS.filter((l) => !m.efforts.includes(l)).map((l) => [l, null]),
      ]),
      // The shim sends an adaptive `effort`, not a token budget; without this
      // pi emits thinkingBudgetTokens and the effort never reaches the wire.
      // sendSessionAffinityHeaders: pi then sends x-session-affinity, which
      // keeps two sessions with the same opening message on separate children.
      compat: { forceAdaptiveThinking: true, sendSessionAffinityHeaders: true },
    })),
  } as Parameters<ExtensionAPI["registerProvider"]>[1]);

  pi.on("session_start", ensureShim);

  // Recover if the detached shim died during this session.
  pi.on("before_agent_start", ensureShim);
}

export { PROVIDER_NAME };
