// Renderer shapes — plain, no server, no stub CLI needed. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALIAS_MODELS, OPENCODE_EFFORTS } from "../shim/models.mjs";
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

test("opencode lists one entry per alias, with no effort suffix", () => {
  const { models } = opencode().providers["claude-cli"];
  assert.deepEqual(Object.keys(models), ALIAS_MODELS.map((m) => m.id));
  for (const m of ALIAS_MODELS) {
    assert.deepEqual(
      models[m.id],
      {
        name: m.name,
        limit: { context: m.context, output: m.out },
        capabilities: { reasoning: { supported: true, effort: OPENCODE_EFFORTS } },
      },
      m.id,
    );
  }
  // The v1 per-model reasoning flag stays out; the capability block replaces it.
  for (const entry of Object.values(models)) assert.equal(entry.reasoning, undefined);
});

test("the opencode picker offers the latest generation only", () => {
  const { models } = opencode().providers["claude-cli"];
  // Every entry is an alias, which the CLI resolves to the newest release of
  // its family at spawn time: a pinned version would be a superseded one.
  for (const id of Object.keys(models)) {
    assert.ok(
      ALIAS_MODELS.some((m) => m.id === id),
      `${id} is not one of the aliases (${ALIAS_MODELS.map((m) => m.id).join(", ")})`,
    );
  }
});

test("effort is one choice, not two", () => {
  const { models } = opencode().providers["claude-cli"];
  // opencode offers effort as a native variant, so the model list must not
  // also carry `:effort` ids: two pickers for one choice is a step the user
  // should not have to take.
  for (const id of Object.keys(models)) {
    assert.ok(!id.includes(":"), `${id} is a suffixed model id`);
  }
  // And the native variant has to be declared, or opencode offers no effort
  // selector at all and every turn runs at the model's default.
  for (const entry of Object.values(models)) {
    assert.equal(entry.capabilities?.reasoning?.supported, true);
    assert.deepEqual(entry.capabilities?.reasoning?.effort, OPENCODE_EFFORTS);
  }
});

test("opencode port override relays into baseURL", () => {
  assert.equal(opencode(18791).providers["claude-cli"].settings.baseURL, "http://127.0.0.1:18791/v1");
});