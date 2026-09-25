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
  // Run it under node, not the host's runtime. Under bun, node:http never
  // reports a client disconnect, so the shim cannot abort a turn the user
  // cancelled; and a bun-compiled host's execPath is not a JS runtime at all.
  // No node on PATH: fall back to the host, told to behave as plain bun.
  const start = (cmd: string, extraEnv: Record<string, string> = {}) => {
    const child = spawn(cmd, [SHIM], {
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
        ...extraEnv,
      },
    });
    child.on("error", () => {
      if (cmd === "node") start(process.execPath, { BUN_BE_BUN: "1" });
    });
    child.unref();
  };
  start(process.versions.bun ? "node" : process.execPath);
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
      // sendSessionAffinityHeaders: pi then sends x-session-affinity, which
      // keeps two sessions with the same opening message on separate children.
      compat: { forceAdaptiveThinking: true, sendSessionAffinityHeaders: true },
    })),
  } as Parameters<ExtensionAPI["registerProvider"]>[1]);

  pi.on("session_start", async () => {
    if (!(await shimUp())) bootShim();
  });

  // A shim that died mid-session (crash, OOM, `claude-shim stop`, a deploy)
  // would otherwise stay down until the next session: re-check before each
  // agent run and wait briefly for a fresh boot to listen.
  pi.on("before_agent_start", async () => {
    if (await shimUp()) return;
    bootShim();
    for (let i = 0; i < 20 && !(await shimUp()); i++) await new Promise((r) => setTimeout(r, 250));
  });
}

export { PROVIDER_NAME };
