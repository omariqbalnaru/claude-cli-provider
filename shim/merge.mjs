#!/usr/bin/env node
/**
 * Merge the rendered provider block into an OpenCode config.
 *
 *   node shim/merge.mjs opencode [--config PATH] [--dry-run]
 *
 * The config is rewritten as text, not re-serialized: comments, key order and
 * everything outside the provider's own block survive untouched, and only
 * that block changes. The write is atomic and the previous file is kept
 * beside it as a .bak.
 *
 * The scanning below is a small JSONC reader - it knows line and block
 * comments and escaped strings - so a comment, or a "//" inside a URL
 * string, never sends it looking in the wrong place.
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PROVIDER_ID, DEFAULT_PORT } from "./models.mjs";
import { render } from "./render.mjs";

const DEFAULT_CONFIG = join(homedir(), ".config/opencode/opencode.jsonc");

/** Skip whitespace and comments, returning the index of the next real token. */
function skipTrivia(text, index) {
  let i = index;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated block comment");
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

/** Read a JSON string, returning its value and the index after the closing quote. */
function readString(text, index) {
  if (text[index] !== '"') throw new Error(`expected a string at ${index}`);
  let i = index + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') return { value: JSON.parse(text.slice(index, i + 1)), end: i + 1 };
    i++;
  }
  throw new Error("unterminated string");
}

/** The index just past the value that starts at `index`. */
function skipValue(text, index) {
  const c = text[index];
  if (c === '"') return readString(text, index).end;
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    let depth = 0;
    let i = index;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        i = readString(text, i).end;
        continue;
      }
      if (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
        i = skipTrivia(text, i);
        continue;
      }
      if (ch === c) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    throw new Error("unterminated object or array");
  }
  const literal = text.slice(index).match(/^[-+0-9.eE]+|^(true|false|null)/);
  if (!literal) throw new Error(`unexpected value at ${index}`);
  return index + literal[0].length;
}

/**
 * The members of the JSONC object that starts at `start`: each with its name,
 * the span of its value, and the span of the whole member.
 */
export function objectMembers(text, start) {
  if (text[start] !== "{") throw new Error(`expected an object at ${start}`);
  const members = [];
  let i = start + 1;
  while (i < text.length) {
    i = skipTrivia(text, i);
    const c = text[i];
    if (c === "}") return { members, end: i };
    if (c === ",") {
      i++;
      continue;
    }
    if (c === undefined) throw new Error("unterminated object");
    const memberStart = i;
    const name = readString(text, i);
    i = skipTrivia(text, name.end);
    if (text[i] !== ":") throw new Error(`expected ':' after "${name.value}" at ${i}`);
    i = skipTrivia(text, i + 1);
    const valueStart = i;
    const valueEnd = skipValue(text, i);
    // The span covers the value only: the comma after it belongs to the
    // separator between members, so replacing the value leaves it in place.
    members.push({ name: name.value, memberStart, valueStart, valueEnd, memberEnd: valueEnd });
    i = valueEnd;
  }
  throw new Error("unterminated object");
}

/** The index of the root object's opening brace, past any leading trivia. */
function rootStart(text) {
  const index = skipTrivia(text, 0);
  if (text[index] !== "{") throw new Error("the config does not start with an object");
  return index;
}

/** The leading whitespace of the line the index sits on. */
function indentAt(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const match = text.slice(lineStart, index).match(/^[ \t]*/);
  return match ? match[0] : "";
}

/**
 * The JSONC text with its comments removed, so the rest of the file can be
 * parsed as JSON. A `//` inside a string is not a comment, so the strings are
 * walked rather than the lines matched.
 */
export function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const { value, end } = readString(text, i);
      out += JSON.stringify(value);
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The provider's own block, rendered at the indentation the config uses. */
function serializeProvider(provider, indent) {
  const lines = JSON.stringify(provider, null, 2).split("\n");
  const inner = lines.slice(1, -1).map((line) => indent + line).join("\n");
  return `{\n${inner}\n${indent}}`;
}

/**
 * The config with the provider's block replaced, or added when it is not
 * there yet. Returns the new text and the block it replaced, so the caller
 * can say what changed.
 */
export function mergeProvider(text, providerId, provider) {
  const root = objectMembers(text, rootStart(text));
  const providers = root.members.find((member) => member.name === "providers");
  if (!providers) throw new Error("the config has no providers object");
  const inner = objectMembers(text, providers.valueStart);
  const member = inner.members.find((entry) => entry.name === providerId);

  if (member) {
    const indent = indentAt(text, member.memberStart);
    const replacement = `"${providerId}": ${serializeProvider(provider, indent)}`;
    let previous = null;
    try {
      // The value alone is JSON; the whole member is not.
      previous = JSON.parse(text.slice(member.valueStart, member.valueEnd));
    } catch {
      previous = null; // a hand-edited block: replace it, but cannot summarize
    }
    return {
      text: text.slice(0, member.memberStart) + replacement + text.slice(member.memberEnd),
      previous,
      replaced: true,
    };
  }

  // Not there yet: add it as the last member of the providers object, before
  // the object's closing brace.
  const close = inner.end; // the index of the '}' that ends the providers object
  const last = inner.members[inner.members.length - 1];
  const indent = last ? indentAt(text, last.memberStart) : indentAt(text, close);
  const entry = `${indent}"${providerId}": ${serializeProvider(provider, indent)}`;
  const needsComma = inner.members.length > 0;
  const insertion = `${needsComma ? "," : ""}\n${entry}\n${indentAt(text, close)}`;
  return { text: text.slice(0, close) + insertion + text.slice(close), previous: null, replaced: false };
}

/** What changed between the block that was there and the one that is now. */
export function summarize(previous, provider) {
  if (!previous) return ["provider added"];
  const lines = [];
  if (previous.name !== provider.name) {
    lines.push(`name: ${JSON.stringify(previous.name)} -> ${JSON.stringify(provider.name)}`);
  }
  const before = Object.keys(previous.models ?? {});
  const after = Object.keys(provider.models ?? {});
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  const renamed = after.filter((id) => before.includes(id) && previous.models[id]?.name !== provider.models[id].name);
  if (added.length) lines.push(`${added.length} model(s) added (e.g. ${added.slice(0, 3).join(", ")})`);
  if (removed.length) lines.push(`${removed.length} model(s) removed (e.g. ${removed.slice(0, 3).join(", ")})`);
  if (renamed.length) lines.push(`${renamed.length} model(s) renamed (e.g. ${renamed[0]})`);
  if (!lines.length) lines.push("no change");
  return lines;
}

/** Merge the provider block into the config file, atomically, keeping a .bak. */
export function mergeIntoConfig(configPath, provider, { dryRun = false } = {}) {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    text = '{\n  "$schema": "https://opencode.ai/config.json",\n  "providers": {\n  }\n}\n';
  }
  try {
    JSON.parse(stripComments(text));
  } catch (e) {
    throw new Error(`${configPath} is not valid JSONC: ${e.message}`);
  }
  const merged = mergeProvider(text, PROVIDER_ID, provider);
  const summary = summarize(merged.previous, provider);
  if (dryRun) return { summary, changed: merged.text !== text, path: configPath };
  if (merged.text !== text) {
    mkdirSync(dirname(configPath), { recursive: true });
    copyFileSync(configPath, `${configPath}.bak`);
    const temp = `${configPath}.tmp-${process.pid}`;
    writeFileSync(temp, merged.text);
    renameSync(temp, configPath);
  }
  return { summary, changed: merged.text !== text, path: configPath };
}

/** The CLI: `node shim/merge.mjs opencode [--port N] [--config PATH] [--dry-run]`. */
function main(argv) {
  const target = argv[0];
  if (target !== "opencode") {
    console.error(`usage: merge.mjs opencode [--port N] [--config PATH] [--dry-run] (got ${target ?? "nothing"})`);
    process.exit(2);
  }
  let configPath = DEFAULT_CONFIG;
  let port = DEFAULT_PORT;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--config") configPath = argv[++i];
    else if (argv[i] === "--port") port = Number(argv[++i]);
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("--port must be an integer from 1 to 65535");
    process.exit(2);
  }
  const provider = JSON.parse(render("opencode", port)).providers[PROVIDER_ID];
  const result = mergeIntoConfig(configPath, provider, { dryRun });
  console.log(`${dryRun ? "would update" : "updated"} ${result.path}`);
  for (const line of result.summary) console.log(`  ${line}`);
  if (!result.changed) console.log("  (already current)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`merge failed: ${e.message}`);
    process.exit(1);
  }
}
