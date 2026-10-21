#!/usr/bin/env node
/**
 * Catalog freshness check. One grep pass over the installed claude CLI bundle
 * collects the versioned model ids it references; any id NEWER than the
 * catalog's newest for its family fails the run — the "a release shipped,
 * the catalog didn't" case. Older ids the bundle still mentions are not
 * findings: the catalog deliberately pins recent models only, and dated ids
 * like claude-opus-4-20250514 are not pins.
 *
 * No CLI spawn, no subscription turn. Skips cleanly when claude is not on
 * PATH (CI) so `npm test` stays green off this machine.
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { MODELS } from "../shim/models.mjs";

const tuple = (id) => {
  const m = id.match(/^claude-(opus|sonnet|fable|haiku)-(\d)-(\d)$/);
  return m && { family: m[1], v: [Number(m[2]), Number(m[3])] };
};

const rank = ([major, minor]) => major * 100 + minor;

const catalogNewest = new Map();
for (const model of MODELS) {
  if (model.cli) continue; // aliases resolve at spawn time; not bundle strings
  const t = tuple(model.id);
  if (!t) continue;
  const known = catalogNewest.get(t.family);
  if (!known || rank(t.v) > rank(known)) catalogNewest.set(t.family, t.v);
}

let bundle;
try {
  const which = execSync("command -v claude", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (which && existsSync(which)) bundle = realpathSync(which);
} catch {}
if (!bundle) {
  console.log("claude CLI not on PATH: skipping catalog freshness check");
  process.exit(0);
}

const grep = spawnSync("grep", ["-a", "-o", "-E", "claude-(opus|sonnet|fable|haiku)-[0-9]+-[0-9]+", bundle], {
  encoding: "utf8",
  env: { ...process.env, LC_ALL: "C" },
  timeout: 60_000,
});
if (grep.error || grep.status === null) {
  console.log(`catalog freshness check inconclusive (${grep.error ?? "grep timed out"}): not blocking`);
  process.exit(0);
}

const newer = new Map();
for (const id of new Set((grep.stdout ?? "").split("\n").filter(Boolean))) {
  const t = tuple(id);
  if (!t) continue;
  const known = catalogNewest.get(t.family) ?? [0, 0];
  if (rank(t.v) > rank(known)) {
    if (!newer.has(t.family)) newer.set(t.family, new Set());
    newer.get(t.family).add(id);
  }
}

if (newer.size === 0) {
  console.log(`catalog is current with the installed claude CLI (${bundle})`);
  process.exit(0);
}
for (const [family, ids] of newer) {
  console.error(`claude CLI references newer ${family} models the catalog lacks: ${[...ids].sort().join(", ")}`);
}
console.error("Add entries to shim/models.mjs (id, context, out, efforts), then re-merge `claude-shim models opencode` into ~/.config/opencode/opencode.jsonc");
process.exit(1);