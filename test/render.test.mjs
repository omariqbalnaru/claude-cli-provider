// Renderer shapes — plain, no server, no stub CLI needed. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { MODELS } from "../shim/models.mjs";
import { effortsFor, render } from "../shim/render.mjs";

const opencode = (port) => JSON.parse(render("opencode", port));

test("opencode block uses the v2 providers shape", () => {
  const block = opencode();
  assert.equal(block.$schema, "https://opencode.ai/config.json");
  const provider = block.providers?.["claude-cli"];
  assert.ok(provider, "providers.claude-cli entry");
  assert.equal(provider.package, "@opencode/ai/providers/anthropic-compatible");
  // The package appends /messages itself, so baseURL carries the shim's /v1.
  assert.equal(provider.settings.baseURL, "http://127.0.0.1:8792/v1");
  assert.equal(provider.settings.apiKey, "claude-shim");
  // Long max-effort turns wait on the CLI past opencode's 5-min HTTP limits.
  assert.ok(provider.settings.headerTimeout >= 600000);
  assert.equal(provider.settings.chunkTimeout, false);
  // v1 fields that v2 deprecates stay out.
  assert.equal(block.provider, undefined);
  assert.equal(provider.npm, undefined);
  assert.equal(provider.options, undefined);
});

test("opencode models expand every catalog model with its effort variants", () => {
  const { models } = opencode().providers["claude-cli"];
  for (const m of MODELS) {
    assert.deepEqual(models[m.id], { name: m.name, limit: { context: m.context, output: m.out } }, m.id);
    for (const effort of effortsFor(m.id)) {
      assert.deepEqual(
        models[`${m.id}:${effort}`],
        { name: `${m.name} (${effort} effort)`, limit: { context: m.context, output: m.out } },
        `${m.id}:${effort}`,
      );
    }
  }
  const expected = MODELS.reduce((n, m) => n + 1 + effortsFor(m.id).length, 0);
  assert.equal(Object.keys(models).length, expected);
  for (const entry of Object.values(models)) assert.equal(entry.reasoning, undefined);
});

test("opencode port override relays into baseURL", () => {
  assert.equal(opencode(18791).providers["claude-cli"].settings.baseURL, "http://127.0.0.1:18791/v1");
});