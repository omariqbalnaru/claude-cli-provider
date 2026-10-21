/**
 * Model catalog — the single source of truth, shared by the shim (server.mjs,
 * for its /v1/models listing) and the extension/mod (src/models.ts, which
 * registers the provider and renders hand-written config files).
 *
 * Plain data, no imports and no side effects, so both a `node server.mjs` run
 * and a jiti-loaded TypeScript extension can read it.
 */

export const MODELS = [
  // Aliases — the CLI resolves these to its latest version at spawn time, so
  // new model releases appear here with no catalog change.
  { id: "claude-opus", name: "Claude Opus (latest)", cli: "opus", context: 1_000_000, out: 128_000 },
  { id: "claude-sonnet", name: "Claude Sonnet (latest)", cli: "sonnet", context: 1_000_000, out: 128_000 },
  { id: "claude-fable", name: "Claude Fable (latest)", cli: "fable", context: 1_000_000, out: 128_000 },
  { id: "claude-haiku", name: "Claude Haiku (latest)", cli: "haiku", context: 200_000, out: 64_000 },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", context: 1_000_000, out: 128_000 },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", context: 200_000, out: 64_000 },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", context: 1_000_000, out: 128_000 },
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

/**
 * The models the picker offers: the CLI's unpinned aliases. Each resolves to
 * the newest release of its family at spawn time, so the picker tracks the
 * CLI without a catalog edit and never shows a superseded version. The
 * pinned versions stay in the catalog for the /v1/models listing and for the
 * freshness gate that compares the CLI's bundle against them.
 */
export const ALIAS_MODELS = MODELS.filter((model) => model.cli);

/** Thinking efforts each model accepts, least → most intensive. */
export const EFFORTS_BY_MODEL = {
  "claude-sonnet-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-haiku-5-5": ["low", "medium", "high"],
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable": ["low", "medium", "high", "xhigh", "max"],
  "claude-haiku": ["low", "medium", "high"],
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
/**
 * Short on purpose: opencode's model picker renders the provider name as the
 * row's footer, which never shrinks, and the model name beside it is the only
 * flexible cell — a long provider label clips the model name it is supposed
 * to sit next to. test/picker.test.mjs holds the fit.
 */
export const PROVIDER_NAME = "Claude CLI";
export const DEFAULT_PORT = 8792;

/**
 * Model ids a CLI bundle mentions that are NEWER than the catalog's newest
 * for their family — the "a release shipped, the catalog didn't" signal.
 * `bundleText` is whatever the bundle grep extracted; older ids, dated ids
 * and the alias slugs are not findings.
 */
export function findNewerModels(bundleText, catalog = MODELS) {
  const tuple = (id) => {
    const m = id.match(/^claude-(opus|sonnet|fable|haiku)-(\d)-(\d)$/);
    return m && { family: m[1], v: [Number(m[2]), Number(m[3])] };
  };
  const rank = ([major, minor]) => major * 100 + minor;
  const newest = new Map();
  for (const model of catalog) {
    if (model.cli) continue; // aliases resolve at spawn; not bundle strings
    const t = tuple(model.id);
    if (!t) continue;
    const known = newest.get(t.family);
    if (!known || rank(t.v) > rank(known)) newest.set(t.family, t.v);
  }
  const newer = new Map();
  for (const id of new Set(String(bundleText).split("\n").filter(Boolean))) {
    const t = tuple(id);
    if (!t) continue;
    const known = newest.get(t.family) ?? [0, 0];
    if (rank(t.v) > rank(known)) {
      if (!newer.has(t.family)) newer.set(t.family, new Set());
      newer.get(t.family).add(id);
    }
  }
  return newer;
}
