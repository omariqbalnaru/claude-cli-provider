# claude-cli-provider

Use a **Claude Pro/Max subscription** as a model provider in **OMP**, **pi**, and
**Command Code** — routed through the Claude Code CLI.

The provider is backed by a small local server (`claude-shim`) that exposes
Claude Code, via Anthropic's official
[Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), on the
Anthropic Messages wire. Auth is owned entirely by Claude Code: this never
reads, extracts, or replays an OAuth token, and the server binds `127.0.0.1`
only.

> **Billing and scope.** This drives Claude Code on your own Pro/Max
> subscription, so turns draw the same quota Claude Code itself does.
> Anthropic's stance on Agent-SDK-under-subscription billing has changed before,
> so treat that as a policy dependency, not a guarantee — and check that your
> plan permits this kind of client before relying on it. Not affiliated with or
> endorsed by Anthropic.

## Install

```bash
# OMP
omp plugin install <this-package>

# pi
pi install <this-package>

# Command Code
cmd mods add -g <this-package>
```

OMP and pi load `src/extension.ts` (both read the `pi.extensions` key).
Command Code loads `src/mod.ts` (the `commandcode.mods` key).

**All three install the same way** — the mod registers the provider and boots
the shim, so no `providers.json` entry is required. `claude-shim models
providers-json` still renders a block if you want the models declared there
too (for `--list-models`, which does not load mods).

## Run the shim directly

```bash
claude-shim start      # boot (idempotent)
claude-shim status     # health + model count
claude-shim stop
claude-shim logs                       # tail the log
claude-shim models <fmt> [port]        # providers-json | models-yml | models-json
```

`start` installs dependencies on first run. `CLAUDE_SHIM_PORT` moves the port.

## Requirements

- `claude` on `PATH`, authenticated with a Pro/Max subscription
  (`npm install -g @anthropic-ai/claude-code`)
- Node 22+

## Model catalog

`shim/models.mjs` is the single source of truth — the shim's `/v1/models`
listing, the registered provider, and the rendered config blocks all read it, so
they cannot drift apart. Add a model by adding one entry there.

## Layout

```
shim/models.mjs    model catalog (plain data, no deps)
shim/render.mjs    renders the catalog per harness config format
shim/server.mjs    the Anthropic-wire server (lazy SDK imports)
src/extension.ts   OMP + pi extension
src/mod.ts         Command Code mod
src/models.ts      typed view of the catalog + renderers
bin/claude-shim    CLI
```

## Notes

- **Thinking levels differ per harness.** OMP reads `thinking: {mode, efforts}`;
  pi reads `thinkingLevelMap` (plus `compat.forceAdaptiveThinking`). The
  registered provider emits all three, so the thinking menu matches what the
  shim accepts — `off`, `low`…`max`, no `minimal` — in either harness. Set only
  the OMP field and pi silently hides `xhigh`/`max` and downgrades both to
  `high` on the wire; set only the pi fields and OMP's menu is wrong.
- **Session key includes the model.** One harness addressing two models with the
  same opening message previously collided onto a single SDK session, so the
  second model's turn ran on the first's. The conversation key is
  model + system prompt + first user message.
- **OMP prompt fix belongs elsewhere.** The xd:// device notice is an OMP
  construct; the prompt clarification and tool-description decoration for it
  live in an OMP-local extension, not here, so they can't leak to pi or
  Command Code.
- **pi and OMP disagree on `baseUrl`.** pi appends `/v1/messages` itself; OMP
  accepts either form. The registered provider omits the `/v1` prefix, which
  both accept. Command Code's mod transport keeps it, since `@ai-sdk/anthropic`
  expects it there.
- **Billing.** Uses your subscription quota the way Claude Code itself does.
  Anthropic's posture toward Agent-SDK-under-subscription billing has changed
  before; this is a policy dependency, not a technical guarantee.
