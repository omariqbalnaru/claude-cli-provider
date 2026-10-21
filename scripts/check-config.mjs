#!/usr/bin/env node
/**
 * Is the merged OpenCode config current? The config is derived state: the
 * claude-cli block in ~/.config/opencode/opencode.jsonc must match what
 * `claude-shim models opencode` renders today. A stale block leaves the
 * picker offering models the shim no longer serves, or missing ones it does.
 *
 * Skips cleanly when the config is absent or has no claude-cli provider (CI,
 * or a machine that does not use opencode), so the check never blocks a
 * commit it has no opinion about. The comparison itself lives in
 * shim/config-check.mjs and is covered by test/config-check.test.mjs.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDrift } from "../shim/config-check.mjs";
import { stripComments } from "../shim/merge.mjs";
import { render } from "../shim/render.mjs";

const configPath = join(homedir(), ".config/opencode/opencode.jsonc");

let config;
try {
  config = JSON.parse(stripComments(readFileSync(configPath, "utf8")));
} catch (e) {
  if (e.code === "ENOENT") {
    console.log(`no OpenCode config at ${configPath}: skipping the config check`);
    process.exit(0);
  }
  console.error(`cannot read ${configPath}: ${e.message}`);
  process.exit(1);
}

const rendered = JSON.parse(render("opencode")).providers["claude-cli"];
const merged = config.providers?.["claude-cli"];
if (!merged) {
  console.log(`no claude-cli provider in ${configPath}: skipping the config check`);
  process.exit(0);
}

const problems = configDrift(rendered, merged);
if (problems.length) {
  for (const problem of problems) console.error(problem);
  console.error(`Re-merge the block: claude-shim models opencode -> ${configPath}`);
  process.exit(1);
}
console.log(`config ok: ${Object.keys(rendered.models).length} models in the OpenCode config`);
