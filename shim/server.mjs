#!/usr/bin/env node
// claude-shim — exposes Claude Code (via the first-party `claude -p` CLI) on
// the Anthropic Messages wire, so pi/OMP can drive a Claude Team subscription
// through Anthropic's own client. This process never reads, extracts, or
// replays an OAuth token: Claude Code owns authentication.
//
// Why the CLI and not @anthropic-ai/claude-agent-sdk: the Agent SDK is an
// API-key product by policy — its children run with CLAUDE_CODE_ENTRYPOINT=
// sdk-ts and Anthropic bills those requests at API rates against the Team
// seat's usage credits, never the plan's weekly quota. A directly spawned
// `claude -p` is first-party Claude Code ("run the CLI as a subprocess with
// -p" is the documented pattern in the Agent SDK overview) and its usage is
// metered to the subscription. Verified empirically: identical 5-prompt
// sessions billed ~$1.50 via the SDK and $0.00 via `claude -p`.
//
// Tool calls are bridged over an stdio MCP server (mcp-bridge.mjs) that the
// claude child spawns via --mcp-config; each call is parked on the shim until
// the caller's NEXT request supplies the matching tool_result.

import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface as readLines } from "node:readline";

const argv = process.argv.slice(2);
if (argv[0] === "models") {
  // Config rendering needs no dependencies — handle it before anything else.
  const { render } = await import("./render.mjs");
  console.log(render(argv[1] ?? "providers-json", Number(argv[2] ?? process.env.CLAUDE_SHIM_PORT ?? 8792)));
  process.exit(0);
}

import { MODELS, DEFAULT_PORT } from "./models.mjs";

const PORT = Number(process.env.CLAUDE_SHIM_PORT ?? DEFAULT_PORT);
const IDLE_MS = Number(process.env.CLAUDE_SHIM_IDLE_MS ?? 10 * 60 * 1000);
const PARK_TIMEOUT_MS = Number(process.env.CLAUDE_SHIM_PARK_TIMEOUT_MS ?? 15_000);
const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_SHIM_TURN_TIMEOUT_MS ?? 15 * 60 * 1000);

const MCP_SERVER_NAME = "cctools";
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const TOOL_USE_ID_META = "claudecode/toolUseId";

const log = (...a) => console.error("[claude-shim]", new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));

// ---- helpers ---------------------------------------------------------------

function normalizeSystem(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === "string" ? b : b?.text ?? ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  }
  return "";
}

/**
 * System blocks the harness rewrites on every request, which must not take part
 * in the conversation identity.
 *
 * OMP injects `x-anthropic-billing-header: … cch=<attester>` as a system block
 * and mints a new attester per request. Hashing it made every turn look like a
 * new conversation, so the shim spawned a fresh session per request: the model
 * never saw its own history and repeated the same tool call until the turn cap
 * (observed as an infinite tool-call loop).
 */
const VOLATILE_SYSTEM_BLOCK = /^x-anthropic-billing-header:/;

function stableSystem(system) {
  const blocks = Array.isArray(system)
    ? system
    : [{ type: "text", text: normalizeSystem(system) }];
  return blocks
    .filter((b) => !VOLATILE_SYSTEM_BLOCK.test(String(b?.text ?? "")))
    .map((b) => String(b?.text ?? ""))
    .join("\n\n");
}

// The wire carries no session id, so a conversation is identified by its
// opening turn: model + system prompt + first real user message. Every later
// request in the same conversation replays a history that still starts with
// that message, so the key stays stable. The model is part of the key because
// one harness can address several models with the same opening message;
// without it the second model's turn would be routed onto the first model's
// live session.
function convKey(model, system, messages) {
  const firstUser = messages.find((m) => m.role === "user" && textOf(m.content));
  return crypto
    .createHash("sha1")
    .update(String(model ?? ""))
    .update("\u0000")
    .update(stableSystem(system))
    .update("\u0000")
    .update(textOf(firstUser?.content ?? ""))
    .digest("hex");
}

function userHash(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function toolResultText(block) {
  const c = block.content;
  let text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c
            .map((x) => (x?.type === "text" ? x.text ?? "" : `[${x?.type ?? "block"}]`))
            .join("\n")
        : "";
  if (!text) text = "(no output)";
  if (block.is_error) text = `ERROR: ${text}`;
  return text;
}

function stripMcp(name) {
  return typeof name === "string" && name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

function makeQueue() {
  const items = [];
  const waiters = [];
  let ended = false;
  return {
    push(x) {
      if (waiters.length) waiters.shift()(x);
      else items.push(x);
    },
    end() {
      ended = true;
      while (waiters.length) waiters.shift()({ __end: true });
    },
    async next() {
      if (items.length) return items.shift();
      if (ended) return { __end: true };
      return new Promise((r) => waiters.push(r));
    },
  };
}

// Reasoning effort levels the CLI accepts. The caller sends the selected
// level as `output_config.effort` on the Anthropic wire; without this the shim
// silently ran every request at Claude Code's own default.
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

function normalizeEffort(value) {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return EFFORT_LEVELS.has(v) ? v : undefined;
}

// ---- internal bridge endpoint ----------------------------------------------

const conversations = new Map();

// The MCP bridge long-polls here when claude calls one of the caller's tools;
// the promise resolves when the caller's next request carries the matching
// tool_result (handleMessages step 1) or the conversation dies.
async function handleInternalToolcall(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "(bridge sent an unreadable request)" }));
    return;
  }
  const conv = conversations.get(String(body.conv ?? ""));
  if (!conv) {
    res.writeHead(410, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "(tool call aborted: session ended)" }));
    return;
  }
  const id = String(body.id ?? "");
  let bridgeGone = false;
  const text = await new Promise((resolve) => {
    conv.parked.set(id, resolve);
    req.on("close", () => {
      // The bridge child died (conversation teardown kills the whole tree).
      if (conv.parked.get(id) === resolve) {
        conv.parked.delete(id);
        bridgeGone = true;
        resolve("(tool call aborted: bridge disconnected)");
      }
    });
  });
  if (bridgeGone) return;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ text }));
}

// Random-port loopback listener the MCP bridges talk to. Bound before the
// first conversation can spawn its child, which needs the port number.
let internalPort = 0;
const internalServer = http.createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (req.method === "POST" && path === "/internal/toolcall") {
    handleInternalToolcall(req, res).catch((e) => {
      log("internal toolcall failed:", e?.stack ?? e);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: `(tool call failed: ${String(e?.message ?? e)})` }));
      } else {
        res.end();
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => {
  internalServer.listen(0, "127.0.0.1", () => {
    internalPort = internalServer.address().port;
    resolve();
  });
});

// ---- conversation ----------------------------------------------------------

// The first-party entrypoint is the whole point of this backend: the SDK and
// anything it leaves behind mark the child as third-party, which is what flips
// billing to usage credits. Strip them defensively in case pi itself ever runs
// under Claude Code.
const STRIPPED_ENV = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "AI_AGENT"];

function createConversation({ key, system, tools, model, effort }) {
  const q = makeQueue();
  const parked = new Map(); // toolUseId -> resolve(text)
  const resolved = new Set();
  const pushedUsers = new Set();

  const tempDir = mkdtempSync(join(tmpdir(), "claude-shim-conv-"));
  const defs = (tools ?? [])
    .filter((t) => t && typeof t.name === "string")
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.input_schema ?? { type: "object", properties: {} },
    }));
  const toolsFile = join(tempDir, "tools.json");
  const sysFile = join(tempDir, "system-prompt.txt");
  const mcpFile = join(tempDir, "mcp-config.json");
  writeFileSync(toolsFile, JSON.stringify(defs));
  const systemAppend = normalizeSystem(system);
  if (systemAppend) writeFileSync(sysFile, systemAppend);
  writeFileSync(
    mcpFile,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: process.execPath,
          args: [join(HERE, "mcp-bridge.mjs")],
          env: {
            CLAUDE_BRIDGE_PORT: String(internalPort),
            CLAUDE_BRIDGE_TOOLS: toolsFile,
            CLAUDE_BRIDGE_CONV: key,
          },
        },
      },
    }),
  );

  const sdkModel = String(model ?? "").split("/").pop() || "claude-sonnet-5";

  const childArgs = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--model", sdkModel,
    "--permission-mode", "bypassPermissions",
    "--strict-mcp-config",
    "--mcp-config", mcpFile,
    "--setting-sources", "",
    // Built-in tools (Bash, Read, …) must stay off: the child would execute
    // them locally in the shim's cwd and the calls would reach pi under
    // Claude Code's names ("Tool Bash not found"). Only the MCP bridge's
    // tools — pi's own — are visible to the model.
    "--tools", "",
  ];
  if (systemAppend) childArgs.push("--append-system-prompt-file", sysFile);
  if (effort) childArgs.push("--effort", effort);

  const env = { ...process.env };
  for (const k of STRIPPED_ENV) delete env[k];
  env.USER = env.USER || env.LOGNAME || "user";
  env.LOGNAME = env.LOGNAME || env.USER || "user";
  env.SHELL = env.SHELL || "/bin/sh";
  env.TMPDIR = env.TMPDIR || "/tmp";
  env.HOME = env.HOME || tmpdir();
  env.DISABLE_AUTO_COMPACT = "1";

  const child = spawn("claude", childArgs, {
    cwd: HERE, // keep transcripts in the shim's own project folder
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  const conv = {
    q, child, parked, resolved, pushedUsers, model: sdkModel, effort,
    last: Date.now(), tempDir, pushedTotal: 0, consumedResults: 0,
    busy: false, aborted: false, _abortWait: null,
  };
  log(`conversation created model=${sdkModel} effort=${effort ?? "(model default)"}`);

  readLines({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout; ignore
    }
    conv.last = Date.now();
    q.push(msg);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    for (const line of String(d).split("\n")) if (line.trim()) log(`claude: ${line}`);
  });
  child.on("exit", (code, signal) => {
    log(`claude child exited code=${code} signal=${signal}`);
    q.end();
  });
  child.on("error", (e) => {
    log("claude child spawn error:", e?.message ?? e);
    q.end();
  });

  return conv;
}

function writeUserMessage(conv, content) {
  if (!conv.child.stdin.writable) return;
  conv.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

function destroyConversation(key) {
  const conv = conversations.get(key);
  if (!conv) return;
  conversations.delete(key);
  conv._abortWait?.({ aborted: true });
  conv._abortWait = null;
  for (const resolve of conv.parked.values()) resolve("(tool call aborted: session ended)");
  conv.parked.clear();
  try {
    conv.child.stdin.end();
  } catch {}
  try {
    conv.child.kill("SIGKILL");
  } catch {}
  try {
    rmSync(conv.tempDir, { recursive: true, force: true });
  } catch {}
}

setInterval(() => {
  const now = Date.now();
  for (const [key, conv] of conversations) {
    if (now - conv.last > IDLE_MS) {
      log("idle conversation closed");
      destroyConversation(key);
    }
  }
}, 60_000).unref();

// ---- turn handling ---------------------------------------------------------

async function nextTurn(conv) {
  const blocks = [];
  let stopReason = null;
  let sawToolUse = false;
  let timedOut = false;
  let aborted = false;
  let hadResult = false;
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // The deadline is only checked between messages, so a wedged child that
    // emits nothing would block q.next() — and this request — forever. Race
    // the wait against the remaining time explicitly.
    const winner = await Promise.race([
      conv.q.next().then((msg) => ({ msg })),
      sleep(deadline - Date.now()).then(() => null),
      new Promise((resolve) => {
        conv._abortWait = resolve;
      }),
    ]);
    conv._abortWait = null;
    if (!winner) {
      timedOut = true;
      break;
    }
    if (winner.aborted) {
      aborted = true;
      break;
    }
    const msg = winner.msg;
    if (msg.__end) break;
    if (msg.type === "assistant") {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          // Replaying thinking blocks requires a signature Anthropic can verify.
          // The CLI's summary thinking carries one; keep whatever it provides.
          blocks.push(b);
          if (b.type === "tool_use") sawToolUse = true;
        }
      }
      // A tool_use turn must end on the tool_use block, not on stop_reason:
      // once a call parks, the child blocks inside the tool and never emits a
      // result, so waiting for one would deadlock the request.
      if (sawToolUse) {
        stopReason = "tool_use";
        break;
      }
      const sr = msg.message?.stop_reason;
      if (sr) {
        // Keep draining: the child ends every turn with a `result` message,
        // and the result counter depends on seeing exactly one per user push.
        stopReason = sr;
      }
    } else if (msg.type === "result") {
      stopReason = stopReason ?? "end_turn";
      hadResult = true;
      const u = msg.usage ?? {};
      log(
        `turn result subtype=${msg.subtype ?? "?"} session=${msg.session_id ?? "?"} ` +
        `out=${u.output_tokens ?? 0} cacheRead=${u.cache_read_input_tokens ?? 0} cacheWrite=${u.cache_creation_input_tokens ?? 0} costUSD=${msg.modelUsage ? Object.values(msg.modelUsage).reduce((s, m) => s + (m.costUSD ?? 0), 0).toFixed(4) : msg.costUSD ?? "?"}`,
      );
      break;
    }
  }
  if (timedOut) log(`turn timed out after ${TURN_TIMEOUT_MS}ms with no child message`);
  if (aborted) log("turn aborted by client disconnect");
  return { blocks, stopReason: stopReason ?? "end_turn", timedOut, aborted, hadResult };
}

// A fresh child (after abort/timeout destroyed the old one) receives the whole
// replayed user-text backlog and answers it one turn at a time; the response
// the caller wants is the LAST one. Resolve any tool calls the stale turns
// parked so the child keeps moving through the backlog.
function discardParked(conv, text) {
  for (const [id, resolve] of conv.parked) {
    conv.parked.delete(id);
    resolve(text);
  }
}

// Render pi's message history as a single transcript prompt for a fresh
// child. The child knows nothing (its own context died with the old
// conversation), so the whole visible conversation is replayed in one prompt
// and the model answers the final message in context. Blocks are capped to
// keep a big session from costing more than it must.
function renderTranscript(messages) {
  const cap = (s) => (s.length > 4000 ? s.slice(0, 4000) + "…[truncated]" : s);
  const parts = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      const t = textOf(m.content);
      if (t) parts.push(`User: ${cap(t)}`);
      continue;
    }
    for (const b of m.content) {
      if (b?.type === "text") parts.push(`${m.role === "user" ? "User" : "Assistant"}: ${cap(b.text ?? "")}`);
      else if (b?.type === "tool_use") parts.push(`Assistant called tool ${b.name} with ${cap(JSON.stringify(b.input ?? {}))}`);
      else if (b?.type === "tool_result") parts.push(`Tool result: ${cap(toolResultText(b))}`);
    }
  }
  parts.push("Continue this conversation. Respond to the most recent user message, using the conversation above as context.");
  return parts.join("\n\n");
}

async function handleMessages(body, res) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const key = convKey(body.model, body.system, messages);

  // Anthropic's wire name for the reasoning level; older bodies nest it under
  // `output_config`. Accept either so a version bump cannot silently drop it.
  const requestedEffort =
    normalizeEffort(body.effort) ?? normalizeEffort(body.output_config?.effort);

  let conv = conversations.get(key);
  if (conv && requestedEffort && conv.effort && requestedEffort !== conv.effort) {
    // The CLI fixes --effort at spawn time. pi always replays the full history,
    // so a fresh child reconstructed from the transcript loses nothing.
    log(`effort change ${conv.effort} -> ${requestedEffort}; recreating conversation`);
    destroyConversation(key);
    conv = undefined;
  }
  if (!conv) {
    conv = createConversation({
      key,
      system: body.system,
      tools: body.tools,
      model: body.model,
      effort: requestedEffort,
    });
    conversations.set(key, conv);
  }
  conv.last = Date.now();

  // The conversation is stateful on the child side, so two concurrent requests
  // for the same key (e.g. two pi instances resumed on one session) would
  // interleave user pushes and steal each other's turns — one sees an empty
  // response, the other hangs forever. Refuse the second writer instead.
  if (conv.busy) {
    log("concurrent request refused: conversation already in flight");
    throw new Error("conversation already has a request in flight (another client is driving this session)");
  }
  conv.busy = true;
  conv.aborted = false;
  // A client that disconnects mid-turn (Ctrl-C on pi) must not keep the turn
  // running as a ghost that consumes the child's next response.
  res.on("close", () => {
    // 'close' also fires after a response is written normally; only a
    // mid-turn disconnect (response unfinished) is an abort.
    if (res.writableEnded || conv.aborted || !conv.busy) return;
    conv.aborted = true;
    log("client disconnected mid-turn; aborting");
    conv._abortWait?.({ aborted: true });
    for (const [id, resolve] of conv.parked) {
      conv.parked.delete(id);
      resolve("(tool call aborted: client disconnected)");
    }
  });

  try {
  // 1. Resolve parked tool calls with any tool_result blocks in this request.
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      if (conv.resolved.has(b.tool_use_id)) continue;
      conv.resolved.add(b.tool_use_id);
      const resolve = conv.parked.get(b.tool_use_id);
      if (resolve) {
        conv.parked.delete(b.tool_use_id);
        resolve(toolResultText(b));
      }
    }
  }

  // 2. Feed user turns to the child. A fresh child knows nothing, so its
  //    history arrives as ONE synthesized transcript prompt — re-pushing the
  //    backlog text-by-text makes the child merge queued turns and the
  //    result-per-push accounting drift. A live child only gets new texts.
  const isFresh = conv.pushedTotal === 0;
  if (isFresh) {
    writeUserMessage(conv, renderTranscript(messages));
    conv.pushedTotal = 1;
    for (const m of messages) {
      if (m.role !== "user") continue;
      if (Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) continue;
      const text = textOf(m.content);
      if (text) conv.pushedUsers.add(userHash(text));
    }
    conv.last = Date.now();
  } else {
    // A message whose blocks are tool_results is a resolution, not a new turn.
    for (const m of messages) {
      if (m.role !== "user") continue;
      if (Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) continue;
      const text = textOf(m.content);
      if (!text) continue;
      const h = userHash(text);
      if (conv.pushedUsers.has(h)) continue;
      conv.pushedUsers.add(h);
      conv.pushedTotal++;
      writeUserMessage(conv, text);
      conv.last = Date.now();
    }
  }

  // 3. Produce the next assistant turn. A fresh child replaying a backlog
  //    answers historical user texts one per turn; only the response to the
  //    LAST push is this request's answer — discard the earlier ones.
  let turn;
  for (;;) {
    turn = await nextTurn(conv);
    if (turn.timedOut || turn.aborted) break;
    if (turn.hadResult) conv.consumedResults++;
    else discardParked(conv, "(tool call discarded: replayed history turn)");
    if (conv.consumedResults >= conv.pushedTotal - 1) break;
    log(`discarding stale replayed response (${conv.consumedResults}/${conv.pushedTotal - 1})`);
  }

  // A turn that ended on the timeout never got a single child message, so the
  // child is wedged (or gone silently); drop the conversation so the next
  // request starts a fresh child instead of blocking on the same corpse.
  // Same for a client-disconnect abort: the child may have half-consumed the
  // turn, so replay it against a fresh child rather than trusting the corpse.
  if (turn.timedOut || turn.aborted) {
    for (const [k, c] of conversations) {
      if (c === conv) {
        destroyConversation(k);
        break;
      }
    }
  }

  // 4. A tool_use turn ends only once every call has parked — that is the
  //    point at which the caller can execute them and come back.
  if (turn.stopReason === "tool_use") {
    const ids = turn.blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
    const deadline = Date.now() + PARK_TIMEOUT_MS;
    while (ids.some((id) => !conv.parked.has(id)) && !conv.aborted && Date.now() < deadline) {
      await sleep(25);
    }
  }

  return turn;
  } finally {
    conv.busy = false;
  }
}

// ---- wire emission ---------------------------------------------------------

function toApiBlock(b) {
  if (b.type === "text") return { type: "text", text: b.text ?? "" };
  if (b.type === "thinking") {
    return b.signature
      ? { type: "thinking", thinking: b.thinking ?? "", signature: b.signature }
      : { type: "thinking", thinking: b.thinking ?? "" };
  }
  if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: stripMcp(b.name), input: b.input ?? {} };
  return { type: "text", text: JSON.stringify(b) };
}

function emitTurn(res, conv, turn, wantStream) {
  const id = "msg_" + crypto.randomBytes(10).toString("hex");
  const model = conv?.model ?? "claude-sonnet-5";
  const content = turn.blocks
    .filter((b) => b.type === "text" || b.type === "thinking" || b.type === "tool_use")
    .map(toApiBlock)
    .filter((b) => (b.type === "text" ? b.text.length > 0 : true));

  if (!wantStream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: turn.stopReason,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    return;
  }

  // The route already wrote the SSE head and started keepalive heartbeats.
  if (!res.headersSent) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
  }
  const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  sse("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let idx = 0;
  for (const b of content) {
    if (b.type === "text") {
      sse("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
      if (b.text) sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: b.text } });
      sse("content_block_stop", { type: "content_block_stop", index: idx });
      idx++;
    } else if (b.type === "thinking") {
      sse("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "" } });
      if (b.thinking) sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: b.thinking } });
      if (b.signature) sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "signature_delta", signature: b.signature } });
      sse("content_block_stop", { type: "content_block_stop", index: idx });
      idx++;
    } else if (b.type === "tool_use") {
      sse("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      sse("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input ?? {}) } });
      sse("content_block_stop", { type: "content_block_stop", index: idx });
      idx++;
    }
  }

  sse("message_delta", { type: "message_delta", delta: { stop_reason: turn.stopReason, stop_sequence: null }, usage: { output_tokens: 0 } });
  sse("message_stop", { type: "message_stop" });
  res.end();
}

// ---- HTTP ------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0].replace(/\/+$/, "") || "/";

  if (req.method === "GET" && path === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, conversations: conversations.size }));
    return;
  }

  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: MODELS.map((m) => ({
          id: m.id,
          object: "model",
          owned_by: "claude-code",
          display_name: m.name,
          context_length: m.context,
          max_output_tokens: m.out,
        })),
      }),
    );
    return;
  }

  const messagesPath = path === "/v1/messages" || path === "/messages";
  if (req.method === "POST" && messagesPath) {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "invalid JSON body" } }));
      return;
    }

    // Command Code probes with a trivial request first; answer it cheaply.
    // Streaming requests get SSE keepalive comments while the child works —
    // without bytes on the wire, pi's request timeout kills long turns.
    const wantStream = body.stream === true;
    let heartbeat = null;
    if (wantStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": keepalive\n\n");
      }, 10_000);
    }
    try {
      const turn = await handleMessages(body, res);
      emitTurn(res, conversations.get(convKey(body.model, body.system, Array.isArray(body.messages) ? body.messages : [])), turn, wantStream);
    } catch (e) {
      log("request failed:", e?.stack ?? e);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(e?.message ?? e) } }));
      } else {
        res.end();
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `No route: ${req.method} ${path}` }));
});

// A second instance losing the bind race is normal — the SessionStart hook can
// fire more than once. Whoever already owns the port is serving, so exit
// quietly instead of crashing noisily into the log.
server.on("error", (e) => {
  if (e?.code === "EADDRINUSE") {
    log(`port ${PORT} already in use — another shim is serving; exiting`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, "127.0.0.1", () => {
  log(`listening on http://127.0.0.1:${PORT} (models: ${MODELS.length}, bridge: ${internalPort})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`received ${sig}, closing ${conversations.size} conversation(s)`);
    for (const key of [...conversations.keys()]) destroyConversation(key);
    server.close(() => process.exit(0));
    internalServer.close();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}