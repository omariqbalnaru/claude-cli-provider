# claude-cli-provider

Use a **Claude Pro/Max subscription** as a model provider in **OMP**, **pi**,
**Command Code**, and **OpenCode** — routed through the Claude Code CLI.

The provider is backed by a small local server (`claude-shim`) that exposes
Claude Code on the Anthropic Messages wire by spawning the `claude -p` CLI as a
subprocess — the first-party harness itself, not the Agent SDK. Auth is owned
entirely by Claude Code: this never reads, extracts, or replays an OAuth token,
and the server binds `127.0.0.1` only.

> **Billing and scope.** This drives Claude Code on your own subscription, so
> turns draw the same quota Claude Code itself does. The subprocess must stay
> first-party: the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
> is an API-key product by policy (its children run with
> `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, and those requests bill usage credits at API
> rates instead of the plan's weekly quota — measured ~$1.50 per short session
> on a Team premium seat, $0.00 via `claude -p`). This shim therefore spawns the
> CLI directly and strips SDK entrypoint env vars defensively. That posture is a
> policy dependency, not a guarantee — check that your plan permits this kind of
> client before relying on it. Not affiliated with or endorsed by Anthropic.

## Install

```bash
# OMP
omp plugin install <this-package>

# pi
pi install <this-package>

# Command Code
cmd mods add -g <this-package>

# OpenCode — print the provider block, then merge it by hand into
# ~/.config/opencode/opencode.json (or project opencode.json). Don't redirect
# onto the file: that replaces your whole config.
claude-shim models opencode
```

OMP and pi load `src/extension.ts` (both read the `pi.extensions` key).
Command Code loads `src/mod.ts` (the `commandcode.mods` key).

**Command Code needs one extra step.** Its model picker and `--list-models`
read `providers.json` and the built-in catalog — neither loads mods — so
without an entry there the `claude-cli/*` models are invisible and
unselectable:

```bash
claude-shim models providers-json      # print the block
```

Merge the output into `~/.commandcode/providers.json`. The mod still earns its
place: it boots the shim, so a turn works without starting it by hand.

## Run the shim directly

```bash
claude-shim start      # boot (idempotent)
claude-shim status     # health + model count
claude-shim stop
claude-shim logs                       # tail the log
claude-shim models <fmt> [port]        # providers-json | models-yml | models-json | opencode
```

`CLAUDE_SHIM_PORT` moves the port.

## Requirements

- `claude` on `PATH`, authenticated with a Pro/Max subscription
  (`npm install -g @anthropic-ai/claude-code`). Tested with 2.1.282; the shim
  relies on `--include-partial-messages`, `--disable-slash-commands` and
  `--no-session-persistence`, so older CLIs will not work.
- Node 22+ (the shim runs under node even when the harness runs on bun)

## Model catalog

`shim/models.mjs` is the single source of truth — the shim's `/v1/models`
listing, the registered provider, and the rendered config blocks all read it, so
they cannot drift apart. Add a model by adding one entry there.

## Layout

```
shim/models.mjs     model catalog (plain data, no deps)
shim/render.mjs     renders the catalog per harness config format
shim/server.mjs     the Anthropic-wire server (spawns `claude -p` per conversation)
shim/mcp-bridge.mjs stdio MCP server serving the caller's tools to the claude child
src/extension.ts    OMP + pi extension
src/mod.ts          Command Code mod
src/models.ts       typed view of the catalog + renderers
bin/claude-shim     CLI
```

## Notes

- **Effort via model-id suffix.** Any client can append `:low`…`:max` to a model
  id (`claude-opus-5-5:high`) — the shim strips it and passes it as the CLI's
  `--effort`. opencode, which has no thinking API, gets ready-made effort
  variants in its picker via `claude-shim models opencode`.

- **Thinking levels differ per harness.** OMP reads `thinking: {mode, efforts}`;
  pi reads `thinkingLevelMap` (plus `compat.forceAdaptiveThinking`). The
  registered provider emits all three, so the thinking menu matches what the
  shim accepts — `off`, `low`…`max`, no `minimal` — in either harness. Set only
  the OMP field and pi silently hides `xhigh`/`max` and downgrades both to
  `high` on the wire; set only the pi fields and OMP's menu is wrong.
- **Session key includes the model.** One harness addressing two models with the
  same opening message previously collided onto a single session, so the
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
- **Billing.** Uses your subscription quota the way interactive Claude Code
  does, because it IS Claude Code (`claude -p`). Tool calls from the harness
  are served to the child over an stdio MCP bridge and parked until the
  harness supplies the result; the child's built-in tools are disabled
  (`--tools ""`) so it can only call the harness's tools — with them on, the
  model would run commands locally in the shim's cwd under Claude Code's
  tool names (pi then rejects them: `Tool Bash not found`). Effort levels
  fix at spawn time, so a mid-conversation effort change recreates the child
  from the replayed history.
  Anthropic's posture toward first-party-headless billing has changed before;
  this is a policy dependency, not a technical guarantee.
