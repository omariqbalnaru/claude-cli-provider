/**
 * Model catalog — the single source of truth, shared by the shim (server.mjs,
 * for its /v1/models listing) and the extension/mod (src/models.ts, which
 * registers the provider and renders hand-written config files).
 *
 * Plain data, no imports and no side effects, so both a `node server.mjs` run
 * and a jiti-loaded TypeScript extension can read it.
 */

export const MODELS = [
  { id: "claude-opus-5", name: "Claude Opus 5", context: 1_000_000, out: 128_000 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", context: 1_000_000, out: 128_000 },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", context: 1_000_000, out: 128_000 },
  { id: "claude-fable-5", name: "Claude Fable 5", context: 1_000_000, out: 128_000 },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", context: 1_000_000, out: 128_000 },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", context: 1_000_000, out: 128_000 },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", context: 200_000, out: 128_000 },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", context: 200_000, out: 64_000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context: 200_000, out: 128_000 },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", context: 1_000_000, out: 64_000 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: 200_000, out: 64_000 },
];

/** Thinking efforts each model accepts, least → most intensive. */
export const EFFORTS_BY_MODEL = {
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-5": ["low", "medium", "high"],
  "claude-sonnet-4-6": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-5": ["low", "medium", "high"],
  "claude-haiku-4-5": ["low", "medium", "high"],
};

export const PROVIDER_ID = "claude-cli";
export const PROVIDER_NAME = "Claude (Pro/Max via claude CLI)";
export const DEFAULT_PORT = 8792;
