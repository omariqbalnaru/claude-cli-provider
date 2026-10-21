// The merge command: it rewrites the config as text, so the risk is a
// mangled file. These are the cases that would mangle one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeIntoConfig, mergeProvider, stripComments, summarize } from "../shim/merge.mjs";

const CONFIG = [
  "{",
  '  "$schema": "https://opencode.ai/config.json",',
  "  // a comment the merge must not touch",
  '  "skills": ["/tmp/skills"],',
  '  "providers": {',
  '    "claude-cli": {',
  '      "name": "Claude CLI",',
  '      "models": { "claude-opus": { "name": "Claude Opus (latest)" } }',
  "    },",
  '    "cursor-cli": { "name": "Cursor CLI" }',
  "  }",
  "}",
  "",
].join("\n");

const PROVIDER = { name: "Claude CLI", models: { "claude-opus": { name: "Claude Opus (latest)" } } };

const tempConfig = (text) => {
  const dir = mkdtempSync(join(tmpdir(), "merge-test-"));
  const path = join(dir, "opencode.jsonc");
  writeFileSync(path, text);
  return path;
};

test("the merge replaces only the provider's block", () => {
  const merged = mergeProvider(CONFIG, "claude-cli", PROVIDER);
  assert.match(merged.text, /\/\/ a comment the merge must not touch/);
  assert.match(merged.text, /"cursor-cli": \{ "name": "Cursor CLI" \}/);
  assert.match(merged.text, /"skills": \["\/tmp\/skills"\]/);
  assert.equal(merged.replaced, true);
});

test("the merged config still parses as JSON once the comments are gone", () => {
  const merged = mergeProvider(CONFIG, "claude-cli", PROVIDER);
  const stripped = stripComments(merged.text);
  const parsed = JSON.parse(stripped);
  assert.deepEqual(parsed.providers["claude-cli"], PROVIDER);
  assert.equal(parsed.providers["cursor-cli"].name, "Cursor CLI");
});

test("a provider that is not there yet is added", () => {
  const merged = mergeProvider(CONFIG, "new-cli", { name: "New", models: {} });
  assert.equal(merged.replaced, false);
  const stripped = stripComments(merged.text);
  const parsed = JSON.parse(stripped);
  assert.equal(parsed.providers["new-cli"].name, "New");
  assert.equal(parsed.providers["claude-cli"].name, "Claude CLI");
});

test("a '//' inside a string is not a comment", () => {
  const config = '{\n  "providers": {\n    "claude-cli": { "name": "https://example.com" }\n  }\n}\n';
  const merged = mergeProvider(config, "claude-cli", PROVIDER);
  const stripped = stripComments(merged.text);
  assert.equal(JSON.parse(stripped).providers["claude-cli"].name, "Claude CLI");
});

test("a block comment is skipped, not parsed as code", () => {
  const config = '{\n  /* note */\n  "providers": {\n    "claude-cli": { "name": "x" }\n  }\n}\n';
  const merged = mergeProvider(config, "claude-cli", PROVIDER);
  assert.match(merged.text, /\/\* note \*\//);
  const stripped = stripComments(merged.text);
  assert.equal(JSON.parse(stripped).providers["claude-cli"].name, "Claude CLI");
});

test("the summary names what changed", () => {
  const previous = { name: "Claude", models: { "claude-opus": { name: "Opus" }, "claude-haiku": { name: "Haiku" } } };
  const next = { name: "Claude CLI", models: { "claude-opus": { name: "Claude Opus (latest)" } } };
  const lines = summarize(previous, next);
  assert.ok(lines.some((l) => l.includes("name:")));
  assert.ok(lines.some((l) => /1 model\(s\) removed/.test(l)));
  assert.ok(lines.some((l) => /1 model\(s\) renamed/.test(l)));
});

test("merging twice changes nothing the second time", () => {
  const path = tempConfig(CONFIG);
  const first = mergeIntoConfig(path, PROVIDER);
  assert.equal(first.changed, true);
  const text = readFileSync(path, "utf8");
  const second = mergeIntoConfig(path, PROVIDER);
  assert.equal(second.changed, false, "the second merge is a no-op");
  assert.equal(readFileSync(path, "utf8"), text, "and it does not rewrite the file");
});

test("the previous file is kept beside it", () => {
  const path = tempConfig(CONFIG);
  mergeIntoConfig(path, PROVIDER);
  assert.ok(readFileSync(`${path}.bak`, "utf8").includes("a comment the merge must not touch"));
});

test("a dry run writes nothing", () => {
  const path = tempConfig(CONFIG);
  const before = readFileSync(path, "utf8");
  const result = mergeIntoConfig(path, PROVIDER, { dryRun: true });
  assert.equal(result.changed, true);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("a config that is already broken is refused, not merged", () => {
  // A missing comma makes the file unparseable. Rewriting it would replace
  // the operator's broken config with one that silently drops a provider.
  const path = tempConfig('{\n  "providers": {\n    "claude-cli": { "name": "x" }\n    "cursor-cli": { "name": "y" }\n  }\n}\n');
  assert.throws(() => mergeIntoConfig(path, PROVIDER), /not valid JSONC/);
  assert.ok(readFileSync(path, "utf8").includes("cursor-cli"), "the file is left alone");
});
