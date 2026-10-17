/**
 * Command Code mod: registers the `claude-cli` provider and boots the shim.
 *
 * Command Code resolves `--model` against `providers.json` and the built-in
 * catalog, not against mod-registered providers, so the model list still needs
 * a `providers.json` entry (regenerate with `claude-shim models
 * providers-json`). This mod does the two things that file cannot: register the
 * provider through the same `addProvider` seam the built-ins use — keeping it
 * live and self-declaring if providers.json drifts — and boot the shim so the
 * port is serving by the first turn.
 *
 * `@commandcode/harness` is not published to npm, so the ModApi surface this
 * file touches is declared locally.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { MODELS, PROVIDER_ID, PROVIDER_NAME } from "./models.ts";
import { BASE, ensureShim } from "./launcher.mjs";

interface Disposable {
  dispose(): void;
}

interface ModApi {
  addProvider(module: unknown): Disposable;
  hooks(hooks: { onSessionStart?: () => void | Promise<void> }): Disposable;
}

export default function (cmd: ModApi): void {
  cmd.addProvider({
    id: PROVIDER_ID,
    displayName: PROVIDER_NAME,
    models: MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      label: m.name,
      description: m.name,
      reasoning: true,
      reasoningEfforts: m.efforts,
      inputModalities: ["text", "image"],
      contextWindow: m.context,
    })),
    // The shim speaks the Anthropic Messages wire; @ai-sdk/anthropic is the
    // transport that reads it. baseURL keeps the /v1 the shim serves.
    transport: {
      kind: "aisdk",
      buildModel: ({ model }: { model: string }) =>
        createAnthropic({ baseURL: `${BASE}/v1`, apiKey: "claude-shim" })(model),
    },
    // No `auth`: cmd calls `auth.loader(...)` whenever `auth` is present, and
    // the shim owns authentication (via Claude Code), so cmd must send none.
  });

  cmd.hooks({ onSessionStart: ensureShim });
}
