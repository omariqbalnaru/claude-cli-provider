// The config-drift check's decisions, without a config file: the live check
// reads the world, this proves the same logic fires on fixture blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { configDrift } from "../shim/config-check.mjs";
import { render } from "../shim/render.mjs";

const rendered = JSON.parse(render("opencode")).providers["claude-cli"];
const clone = () => structuredClone(rendered);

test("a config that matches the rendered block has no drift", () => {
  assert.deepEqual(configDrift(rendered, clone()), []);
});

test("a model the block is missing is drift", () => {
  const merged = clone();
  delete merged.models["claude-opus:max"];
  const problems = configDrift(rendered, merged);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1 model\(s\) the block is missing/);
});

test("a model the shim no longer serves is drift", () => {
  const merged = clone();
  merged.models["claude-opus-9-9"] = { name: "Claude Opus 9.9", limit: { context: 1, output: 1 } };
  const problems = configDrift(rendered, merged);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer serves/);
});

test("a stale model name is drift", () => {
  const merged = clone();
  merged.models["claude-opus"].name = "Claude Opus 5.5";
  const problems = configDrift(rendered, merged);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /stale name/);
});

test("a different provider label or package is drift", () => {
  const merged = clone();
  merged.name = "Claude";
  merged.package = "@opencode/ai/sdk";
  const problems = configDrift(rendered, merged);
  assert.equal(problems.length, 2);
});

test("a different port is not drift: the operator chooses it", () => {
  const merged = clone();
  merged.settings.baseURL = "http://127.0.0.1:18792/v1";
  assert.deepEqual(configDrift(rendered, merged), []);
});
