// The catalog freshness gate's decision, without a CLI: the live check greps
// the installed claude bundle, this proves the same logic fires on a listing
// that names a model the catalog does not carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findNewerModels, MODELS } from "../shim/models.mjs";

test("the freshness gate fires on a model newer than the catalog", () => {
  const newer = findNewerModels("claude-haiku-9-9\nclaude-opus-4-8\n");
  assert.ok(newer.has("haiku"), "the newer family is reported");
  assert.deepEqual([...newer.get("haiku")], ["claude-haiku-9-9"]);
  assert.equal(newer.has("opus"), false, "a known id is not a finding");
});

test("the gate is silent when the bundle mentions nothing newer", () => {
  const newer = findNewerModels("claude-opus-5-5\nclaude-haiku-4-5\nclaude-sonnet-4-6\n");
  assert.equal(newer.size, 0);
});

test("dated ids and alias slugs are not findings", () => {
  const newer = findNewerModels("claude-opus-4-20250514\nclaude-opus\nclaude-sonnet\n");
  assert.equal(newer.size, 0);
});

test("the catalog's own newest id is the boundary, not a finding", () => {
  const newest = MODELS.filter((m) => !m.cli).map((m) => m.id).join("\n");
  assert.equal(findNewerModels(newest).size, 0);
});
