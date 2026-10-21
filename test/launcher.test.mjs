import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { render } from "../shim/render.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shim-launcher-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function executable(path, content) {
  writeFileSync(path, content, { mode: 0o755 });
}

test("render refuses invalid ports instead of producing unusable URLs", () => {
  for (const port of [0, -1, 65536, NaN, 1.5, "8792/path"]) {
    // The port is a number; the string case is a string on purpose.
    assert.throws(() => render("models-json", /** @type {any} */ (port)), /port/i);
  }
});

async function launcher(t, source) {
  const dir = mkdtempSync(join(tmpdir(), "shim-launcher-test-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "shim"));
  copyFileSync(join(ROOT, "src/launcher.mjs"), join(dir, "src/launcher.mjs"));
  copyFileSync(join(ROOT, "shim/models.mjs"), join(dir, "shim/models.mjs"));
  if (source) writeFileSync(join(dir, "shim/server.mjs"), source);
  const saved = { port: process.env.CLAUDE_SHIM_PORT, log: process.env.CLAUDE_SHIM_LOG };
  // Reserve a port without starting the real shim or Claude CLI.
  const http = await import("node:http");
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  process.env.CLAUDE_SHIM_PORT = String(port);
  process.env.CLAUDE_SHIM_LOG = join(dir, "startup.log");
  t.after(() => {
    for (const [key, value] of /** @type {[string, string | undefined][]} */ ([
      ["CLAUDE_SHIM_PORT", saved.port],
      ["CLAUDE_SHIM_LOG", saved.log],
    ])) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const pidFile = join(dir, "shim/pid");
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8"))); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, module: await import(pathToFileURL(join(dir, "src/launcher.mjs")).href) };
}

test("client boot waits for health and reuses one detached Node process", async (t) => {
  const { dir, module } = await launcher(t, `
    import http from "node:http";
    import { writeFileSync } from "node:fs";
    writeFileSync("pid", String(process.pid));
    console.error("startup diagnostic");
    setTimeout(() => http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, conversations: 0 }));
    }).listen(Number(process.env.CLAUDE_SHIM_PORT), "127.0.0.1"), 100);
  `);
  await Promise.all([module.ensureShim(), module.ensureShim()]);
  const pid = readFileSync(join(dir, "shim/pid"), "utf8");
  await module.ensureShim();
  assert.equal(readFileSync(join(dir, "shim/pid"), "utf8"), pid);
  assert.match(readFileSync(join(dir, "startup.log"), "utf8"), /startup diagnostic/);
});

test("client boot exposes early process exit with startup log path", async (t) => {
  const { dir, module } = await launcher(t, 'console.error("broken startup"); process.exit(23);');
  await assert.rejects(module.ensureShim(), /startup\.log/);
  assert.match(readFileSync(join(dir, "startup.log"), "utf8"), /broken startup/);
});

test("client boot reports missing shim", async (t) => {
  const { module } = await launcher(t);
  await assert.rejects(module.ensureShim(), /missing|not found/i);
});

test("Bun hosts without Node fail instead of silently breaking cancellation", async (t) => {
  const { dir } = await launcher(t, "process.exit(0)");
  const entry = join(dir, "entry.mjs");
  writeFileSync(entry, `
    Object.defineProperty(process.versions, "bun", { value: "test" });
    const { ensureShim } = await import("./src/launcher.mjs");
    try { await ensureShim(); process.exitCode = 9; }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  `);
  const result = spawnSync(process.execPath, [entry], { env: { ...process.env, PATH: dir }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Node|node/);
});

test("CLI stop succeeds when no process listens", (t) => {
  const dir = fixture(t);
  executable(join(dir, "lsof"), "#!/bin/bash\nexit 1\n");
  const result = spawnSync("/bin/bash", [join(ROOT, "bin/claude-shim"), "stop"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CLAUDE_SHIM_PORT: "18999" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing listening/);
});

test("CLI config merge writes the provider block into a config", (t) => {
  const dir = fixture(t);
  const config = join(dir, "opencode.jsonc");
  writeFileSync(config, '{\n  // a comment\n  "providers": {\n    "claude-cli": { "name": "old" }\n  }\n}\n');
  const result = spawnSync("/bin/bash", [join(ROOT, "bin/claude-shim"), "config", "merge", "opencode", "--config", config], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated/);
  const merged = readFileSync(config, "utf8");
  assert.match(merged, /\/\/ a comment/, "the comment survives");
  assert.match(merged, /"name": "Claude CLI"/, "the block is the rendered one");
});

test("CLI config merge --dry-run leaves the config alone", (t) => {
  const dir = fixture(t);
  const config = join(dir, "opencode.jsonc");
  const before = '{\n  "providers": {}\n}\n';
  writeFileSync(config, before);
  const result = spawnSync("/bin/bash", [join(ROOT, "bin/claude-shim"), "config", "merge", "opencode", "--config", config, "--dry-run"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /would update/);
  assert.equal(readFileSync(config, "utf8"), before);
});

test("CLI start runs from shim directory so deployment can identify it", async (t) => {
  const { dir } = await launcher(t, `
    import http from "node:http";
    import { writeFileSync } from "node:fs";
    writeFileSync("pid", String(process.pid));
    writeFileSync("cwd", process.cwd());
    http.createServer((req, res) => res.end('{"ok":true,"conversations":0}'))
      .listen(Number(process.env.CLAUDE_SHIM_PORT), "127.0.0.1");
  `);
  mkdirSync(join(dir, "bin"));
  copyFileSync(join(ROOT, "bin/claude-shim"), join(dir, "bin/claude-shim"));
  executable(join(dir, "lsof"), "#!/bin/bash\nexit 1\n");
  const result = spawnSync("/bin/bash", [join(dir, "bin/claude-shim"), "start"], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(dir, "shim/cwd"), "utf8"), realpathSync(join(dir, "shim")));
});

function deployFixture(t) {
  const dir = fixture(t);
  const repo = join(dir, "repo");
  const pkg = join(dir, "install");
  const commands = join(dir, "commands");
  for (const path of [join(repo, "scripts"), join(repo, "src"), join(repo, "shim"), join(repo, "bin"), join(pkg, "shim"), commands]) mkdirSync(path, { recursive: true });
  copyFileSync(join(ROOT, "scripts/sync-to-omp.sh"), join(repo, "scripts/sync-to-omp.sh"));
  writeFileSync(join(repo, "src/new.mjs"), "new");
  writeFileSync(join(repo, "shim/server.mjs"), "new");
  writeFileSync(join(repo, "bin/claude-shim"), "new");
  writeFileSync(join(pkg, "package.json"), '{"name":"claude-cli-provider"}');
  writeFileSync(join(repo, "package.json"), '{"name":"claude-cli-provider"}');
  writeFileSync(join(pkg, "shim/server.mjs"), "old");
  executable(join(commands, "git"), `#!/bin/bash
case "$3" in
  archive) [ "\${ARCHIVE_FAIL:-0}" = 0 ] || exit 7; exec tar -cf - -C "$2" src shim bin package.json ;;
  rev-parse) echo main ;;
esac
`);
  executable(join(commands, "lsof"), `#!/bin/bash
case " $* " in
  *" cwd "*) echo "n$OMP_PKG/shim" ;;
  *) echo 999999 ;;
esac
`);
  executable(join(commands, "curl"), '#!/bin/bash\n[ "${HEALTH_FAIL:-0}" = 0 ] || exit 22\nif [ -n "${HEALTH_BODY:-}" ]; then printf \'%s\\n\' "$HEALTH_BODY"; else echo \'{"ok":true,"conversations":1}\'; fi\n');
  executable(join(commands, "sleep"), "#!/bin/bash\nexit 0\n");
  executable(join(commands, "seq"), "#!/bin/bash\nprintf '1\\n'\n");
  // Never touch any real install, listener, or rsync destination.
  executable(join(commands, "rsync"), '#!/bin/bash\necho called >> "$RSYNC_MARKER"\necho changed\n');
  return { repo, pkg, commands, dir };
}

/** The failure and the env it sets. @type {[string, Record<string, string>][]} */
const deployFailures = [
  ["failed health probe", { HEALTH_FAIL: "1" }],
  ["malformed health response", { HEALTH_BODY: '{"ok":true}' }],
  ["busy conversations at deadline", {}],
  ["failed git archive", { ARCHIVE_FAIL: "1" }],
];
for (const [name, extraEnv] of deployFailures) {
  test(`deploy aborts before replacing live files on ${name}`, (t) => {
    const { repo, pkg, commands, dir } = deployFixture(t);
    const env = {
      ...process.env,
      PATH: `${commands}:${process.env.PATH}`,
      OMP_PKG: pkg,
      CLAUDE_SHIM_PORT: "18999",
      RSYNC_MARKER: join(dir, "rsync-called"),
      ...extraEnv,
    };
    const result = spawnSync("/bin/bash", [join(repo, "scripts/sync-to-omp.sh")], {
      env,
      encoding: "utf8", timeout: 10000,
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    if (name === "busy conversations at deadline") assert.match(result.stderr, /live conversations after 2h/);
    assert.equal(existsSync(join(dir, "rsync-called")), false, result.stdout + result.stderr);
    assert.equal(readFileSync(join(pkg, "shim/server.mjs"), "utf8"), "old");
  });
}
