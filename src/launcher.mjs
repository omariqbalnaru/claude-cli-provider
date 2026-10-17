import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "../shim/models.mjs";

const SHIM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "shim");
const SHIM = join(SHIM_DIR, "server.mjs");
const PORT = Number(process.env.CLAUDE_SHIM_PORT ?? DEFAULT_PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("CLAUDE_SHIM_PORT must be an integer from 1 to 65535");
export const BASE = `http://127.0.0.1:${PORT}`;
const LOG = process.env.CLAUDE_SHIM_LOG || join(tmpdir(), "claude-shim.log");

async function shimUp() {
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return false;
    const health = await res.json();
    return health.ok === true && Number.isSafeInteger(health.conversations) && health.conversations >= 0;
  } catch {
    return false;
  }
}

async function bootShim() {
  if (!existsSync(SHIM)) throw new Error(`claude-shim server not found: ${SHIM}`);
  // Bun's node:http does not report disconnects, so it cannot cancel turns.
  const runtime = process.versions.bun ? "node" : process.execPath;
  const user = process.env.USER || process.env.LOGNAME || userInfo().username;
  const fd = openSync(LOG, "a", 0o600);
  let child;
  try {
    child = spawn(runtime, [SHIM], {
      cwd: SHIM_DIR,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        USER: process.env.USER || user,
        LOGNAME: process.env.LOGNAME || user,
        SHELL: process.env.SHELL || "/bin/sh",
        TMPDIR: process.env.TMPDIR || tmpdir(),
        HOME: process.env.HOME || homedir(),
      },
    });
  } finally {
    closeSync(fd);
  }
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new Error(`Cannot start claude-shim with Node (${runtime}): ${error.message}. See ${LOG}`)));
  });
  child.unref();
  for (let i = 0; i < 20; i++) {
    if (await shimUp()) return;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error(`claude-shim did not become healthy at ${BASE}; see ${LOG}`);
}

let starting;
export async function ensureShim() {
  if (starting) return starting;
  starting = (async () => {
    if (!(await shimUp())) await bootShim();
  })();
  try {
    await starting;
  } finally {
    starting = undefined;
  }
}
