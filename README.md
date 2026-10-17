# claude-cli-provider

Use a **Claude Pro/Max subscription** as a model provider in **OMP**, **pi**,
**Command Code**, and **OpenCode** — routed through the Claude Code CLI.

The provider is backed by a small local server (`claude-shim`) that exposes
Claude Code on the Anthropic Messages wire by spawning the `claude -p` CLI as a
subprocess — the first-party harness itself, not the Agent SDK. Auth is owned
entirely by Claude Code: this never reads, extracts, or replays an OAuth token.
The server binds `127.0.0.1` and refuses requests whose `Host` or `Origin` is
not loopback, so a web page cannot drive it.

> **Billing and scope.** This drives Claude Code on your own subscription, so
> turns draw the same quota Claude Code itself does. The subprocess must stay
> first-party: the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
> is an API-key product by policy (its children run with
> `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, and those requests bill usage credits at API
> rates instead of the plan's weekly quota — measured ~$1.50 per short session
> on a Team premium seat, $0.00 via `claude -p`). This shim therefore spawns the
> CLI directly and strips SDK entrypoint env vars defensively. It also strips
> every `ANTHROPIC_*` variable and the Bedrock/Vertex/Foundry switches: under
> `-p` an exported `ANTHROPIC_API_KEY` outranks the subscription login and would
> silently bill at API rates. That posture is a
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

The log is `${TMPDIR:-/tmp}/claude-shim.log` (what `claude-shim logs` tails).
It records conversation metadata and CLI diagnostics. Treat it as sensitive:
CLI errors can include request details.
OMP/pi and Command Code wait for shim readiness before starting a session.
Startup failures report the log path; Node is required, with no Bun fallback.

| Env var | Default | |
|---|---|---|
| `CLAUDE_SHIM_PORT` | `8792` | listen port |
| `CLAUDE_SHIM_IDLE_MS` | 10 min | idle conversations are closed after this (1 h while waiting on a tool) |
| `CLAUDE_SHIM_TURN_TIMEOUT_MS` | 15 min | a turn still running after this fails with a 504 |
| `CLAUDE_SHIM_LOG` | `${TMPDIR:-/tmp}/claude-shim.log` | launcher log path |

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
src/launcher.mjs    shared Node startup and health checks
src/models.ts       typed view of the catalog + renderers
bin/claude-shim     CLI
scripts/sync-to-omp.sh  deploy HEAD into OMP's installed copy (dev)
test/shim.test.mjs  drives the real server against a stub `claude`
```

## How a conversation runs

Each conversation keeps one long-lived `claude -p` child. The key is model +
system prompt + first user message, plus the session id when the client sends
one (OMP's `x-claude-code-session-id`, pi's `x-session-affinity`), so two
sessions with the same opening get separate children.

- **Reuse or rebuild.** The shim compares user text, assistant text and tool
  calls against the live child's history. Tool-output rewrites, stripped
  images and thinking metadata do not affect matching. Only recognized
  transient context notes may disappear without rebuilding.
  History edits, resends, tool-definition changes and effort changes rebuild
  the child from the visible transcript. Replay preserves full text rather
  than truncating older blocks at an arbitrary character limit.
  Rebuild reasons appear in the log.
- **Tools.** The caller's tools reach the child through an MCP bridge. Every
  parallel call of a model message comes back in one response. Text sent
  alongside tool results (steering) is folded into the running turn as user
  input.
- **Isolation.** The child runs in an empty temp directory with slash commands,
  session persistence and auto-memory off, and no built-in tools. It never sees
  your repo, your Claude Code sessions or your memory files.
- **Images** in user messages and tool results are passed through.
- **Usage** is the CLI's real token count, so harnesses can compact on time.
  The child can also compact itself.
- **Model attribution.** JSON responses and SSE `message_start` report the
  answering model supplied by the CLI, including automatic fallback models.
  The requested model is used only when the CLI omits that field; selecting
  a model does not guarantee the CLI will answer with it.
- **Errors** (usage limit, auth, prompt too long, overloaded, timeouts) come
  back as Anthropic-style HTTP errors, or an SSE `error` event mid-stream,
  never as an assistant reply.
- **Request validation.** Malformed message/tool shapes return HTTP 400 before
  a child is started or SSE headers are sent. Bridge failures reach Claude as
  tool errors, not successful tool output.
- **Compatibility limits.** SSE responses are emitted after the model message
  completes, with keepalives while waiting; this is not token-by-token streaming.
  Rebuilds flatten conversation roles into a transcript, not native history.
  API controls such as `max_tokens`, `temperature` and `tool_choice` are not
  forwarded to the CLI. This is a client adapter, not a complete Messages API.

## Development

```bash
npm test                  # node --test against a stub claude CLI
scripts/sync-to-omp.sh    # deploy HEAD into ~/.omp/... and restart the shim when idle
```

The sync script deploys the last commit, not the working tree, and copies
`shim/`, `src/`, `bin/` and package metadata into an existing install. Changed
dependencies require reinstalling the plugin first. When shim files change,
the script waits up to 2 h for the installed listener to become idle before
stopping it and replacing files. Failed health checks, a busy deadline or
foreign listeners abort deployment. Copying is not atomic; keep the client
idle during deployment. A local post-commit hook can run
`scripts/sync-to-omp.sh --hook`, which deploys only on `main`. A fast-forward
merge doesn't fire post-commit, so run the script by hand after one.

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
  second model's turn ran on the first's.
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
  model would run commands locally under Claude Code's tool names (pi then
  rejects them: `Tool Bash not found`). Effort levels
  fix at spawn time, so a mid-conversation effort change recreates the child
  from the replayed history.
  Anthropic's posture toward first-party-headless billing has changed before;
  this is a policy dependency, not a technical guarantee.
