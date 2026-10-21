#!/usr/bin/env node
/**
 * The shell scripts have to parse, and their commands have to exist.
 *
 * A bash script with a typo in a case label does not fail: it falls through
 * to the usage message and exits 0, so the command is simply unreachable and
 * nothing downstream learns about it. `bash -n` catches the syntax; the
 * usage lines and the case labels have to agree about which commands exist,
 * in both directions, so a typo in either shows up.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = ["bin/claude-shim", "scripts/sync-to-omp.sh"];

let failed = 0;

/**
 * The top-level commands a usage line promises. The script's own usage
 * reads `usage: <script> {start|stop|status|logs|models <format> [port]}`:
 * the commands are the alternatives, and the `<format>` after a space is an
 * argument of the command before it, not a command of its own.
 */
function promisedCommands(usage) {
  const group = usage.match(/\{([^}]*)\}/);
  if (!group) return new Set();
  const list = group[1].split("<")[0];
  return new Set(
    list
      .split("|")
      .map((word) => word.trim())
      .filter((word) => /^[a-z][a-z-]*$/.test(word)),
  );
}

for (const script of scripts) {
  const path = join(ROOT, script);
  const text = readFileSync(path, "utf8");

  // The syntax: a bash parse error is a hard failure.
  const parse = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  if (parse.status !== 0) {
    failed++;
    console.error(`syntax error in ${script}\n${parse.stderr}`);
    continue;
  }

  // The case labels the script has: a case arm, two spaces in. A bash case
  // label is CASE-SENSITIVE, so the label is compared as written: lowercasing
  // it would hide exactly the typo this check exists to find.
  const labels = new Set([...text.matchAll(/^\s{2}([a-z][a-zA-Z-]*)\)/gm)].map((m) => m[1]));

  // Every usage line the script prints.
  const usages = [...text.matchAll(/usage: [^\n]*/g)].map((m) => m[0]);

  // The command list in the header comment — where a subcommand like
  // `config` is announced. A header line reads
  // `#   <script> <command> <what it does>`.
  const header = text.slice(0, text.indexOf("case "));
  const announcements = [...header.matchAll(/^#\s+(?:\S+\s+)?([a-z][a-z-]*)\s+\S/gm)].map((m) => m[1]);

  // The top-level usage line is the one with a brace group: the catch-all's.
  const top = usages.find((usage) => usage.includes("{")) ?? usages[0] ?? "";
  const promised = promisedCommands(top);

  // A promised command with no case is unreachable.
  const missing = [...promised].filter((command) => !labels.has(command));
  if (missing.length) {
    failed++;
    console.error(`${script}: the usage line promises ${missing.join(", ")}, but there is no case for it`);
  }

  // A case that nothing announces is a command nobody was told about — and
  // a typo in a label shows up as exactly that, because the announcement
  // still names the real one. Checking both directions is what makes a
  // typo impossible to hide.
  const unmentioned = [...labels].filter(
    (label) =>
      !announcements.includes(label) && !usages.some((usage) => new RegExp(`\\b${label}\\b`).test(usage)),
  );
  if (unmentioned.length) {
    failed++;
    console.error(`${script}: the case ${unmentioned.join(", ")} is in no usage line`);
  }
}

if (failed) {
  console.error(`${failed} shell script(s) failed the check`);
  process.exit(1);
}
console.log(`shell ok: ${scripts.length} scripts parsed, usage matches their cases`);
