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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { MODELS, PROVIDER_ID, PROVIDER_NAME, DEFAULT_PORT } from "./models.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM = join(HERE, "..", "shim", "server.mjs");
const PORT = Number(process.env.CLAUDE_SHIM_PORT ?? DEFAULT_PORT);
const BASE = `http://127.0.0.1:${PORT}`;

interface Disposable {
  dispose(): void;
}

interface ModApi {
  addProvider(module: unknown): Disposable;
  hooks(hooks: { onSessionStart?: () => void | Promise<void> }): Disposable;
}

async function shimUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

function bootShim(): void {
  if (!existsSync(SHIM)) return;
  // Detached so the shim outlives the session, and with a real login env:
  // Claude Code's Keychain-backed auth needs USER/LOGNAME/SHELL/TMPDIR.
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

  cmd.hooks({
    onSessionStart: () => {
      void shimUp().then((up) => {
        if (!up) bootShim();
      });
    },
  });
}
