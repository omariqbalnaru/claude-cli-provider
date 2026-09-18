/**
 * OMP / pi extension: registers the `claude-cli` provider and boots the shim.
 *
 * Both harnesses load this from the `pi.extensions` package.json key and expose
 * the same `ExtensionAPI`, so one file serves both. The provider is declared
 * with OMP/pi's built-in `anthropic-messages` api pointing at the local shim —
 * no custom api id, so no per-host stream function and no compat imports.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS, PROVIDER_ID, PROVIDER_NAME, DEFAULT_PORT } from "./models.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "shim", "server.mjs");
const PORT = Number(process.env.CLAUDE_SHIM_PORT ?? DEFAULT_PORT);
const BASE = `http://127.0.0.1:${PORT}`;

/** pi's full thinking ladder, in order. Levels outside a model's set map to null. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Is something already serving the shim port? */
async function shimUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Boot the shim detached if it is not already listening.
 *
 * `detached` + `unref` puts it in its own session: the harness signals its own
 * process group on exit, and Claude Code's Keychain-backed auth needs a real
 * login environment (USER/LOGNAME/SHELL/TMPDIR), which a stripped hook env
 * lacks — hence the explicit env below.
 */
function bootShim(): void {
  if (!existsSync(SHIM)) return;
  const child = spawn(process.execPath, [SHIM], {
    cwd: join(HERE, "..", "shim"),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      USER: process.env.USER || process.env.LOGNAME || "user",
      LOGNAME: process.env.LOGNAME || process.env.USER || "user",
      SHELL: process.env.SHELL || "/bin/sh",
      TMPDIR: process.env.TMPDIR || "/tmp",
      HOME: process.env.HOME || homedir(),
    },
  });
  child.unref();
}

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
      compat: { forceAdaptiveThinking: true },
    })),
  } as Parameters<ExtensionAPI["registerProvider"]>[1]);

  pi.on("session_start", async () => {
    if (!(await shimUp())) bootShim();
  });
}

export { PROVIDER_NAME };
