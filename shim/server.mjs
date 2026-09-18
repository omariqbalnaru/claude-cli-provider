#!/usr/bin/env node
// claude-shim — exposes Claude Code (via the official Agent SDK) on the
// Anthropic Messages wire, so Command Code can drive a Claude Pro/Max
// subscription through Anthropic's own client. This process never reads,
// extracts, or replays an OAuth token: Claude Code owns authentication.
//
// Tool calls are bridged over an in-process MCP server. Claude runs with
// `tools: []`; the caller's tools are served as MCP tools, and each call is
// parked until the caller's NEXT request supplies the matching tool_result.

import http from "node:http";
import crypto from "node:crypto";

const argv = process.argv.slice(2);
if (argv[0] === "models") {
  // Config rendering needs no dependencies — handle it before the SDK imports.
  const { render } = await import("./render.mjs");
  console.log(render(argv[1] ?? "providers-json", Number(argv[2] ?? process.env.CLAUDE_SHIM_PORT ?? 8792)));
  process.exit(0);
}

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

const PORT = Number(process.env.CLAUDE_SHIM_PORT ?? DEFAULT_PORT);
const IDLE_MS = Number(process.env.CLAUDE_SHIM_IDLE_MS ?? 10 * 60 * 1000);
const PARK_TIMEOUT_MS = Number(process.env.CLAUDE_SHIM_PARK_TIMEOUT_MS ?? 15_000);
const TURN_TIMEOUT_MS = Number(process.env.CLAUDE_SHIM_TURN_TIMEOUT_MS ?? 15 * 60 * 1000);

const MCP_SERVER_NAME = "cctools";
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const TOOL_USE_ID_META = "claudecode/toolUseId";

import { MODELS, DEFAULT_PORT } from "./models.mjs";
const log = (...a) => console.error("[claude-shim]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * new conversation, so the shim spawned a fresh SDK session per request: the
 * model never saw its own history and repeated the same tool call until the
 * turn cap (observed as an infinite tool-call loop).
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
// live SDK session.
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

// Controllable async generator of SDK user messages. Kept open between turns
// so a fresh user message can be pushed into a live query.
function makePromptStream() {
  const buf = [];
  let waiter = null;
  let closed = false;
  return {
    push(message) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: message, done: false });
      } else {
        buf.push(message);
      }
    },
    close() {
      closed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: undefined, done: true });
      }
    },
    get stream() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
              if (closed) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => {
                waiter = resolve;
              });
            },
          };
        },
      };
    },
  };
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

// Reasoning effort levels the Agent SDK accepts. Command Code sends the selected
// level as `output_config.effort` on the Anthropic wire; without this the shim
// silently ran every request at Claude Code's own default.
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

function normalizeEffort(value) {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  return EFFORT_LEVELS.has(v) ? v : undefined;
}

// ---- conversation ----------------------------------------------------------

const conversations = new Map();

async function createConversation({ system, tools, model, effort }) {
  const q = makeQueue();
  const prompt = makePromptStream();
  const parked = new Map(); // toolUseId -> resolve(text)
  const resolved = new Set();
  const pushedUsers = new Set();

  const defs = (tools ?? [])
    .filter((t) => t && typeof t.name === "string")
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.input_schema ?? { type: "object", properties: {} },
    }));

  const mcp = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: defs }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const id = req.params?._meta?.[TOOL_USE_ID_META];
    if (typeof id !== "string") throw new Error("tools/call missing toolUseId");
    const text = await new Promise((resolve) => parked.set(id, resolve));
    return { content: [{ type: "text", text }] };
  });

  const sdkModel = String(model ?? "").split("/").pop() || "claude-sonnet-5";
  const systemAppend = normalizeSystem(system);

  const sdkQuery = query({
    prompt: prompt.stream,
    options: {
      tools: [],
      permissionMode: "bypassPermissions",
      settingSources: [],
      systemPrompt: { type: "preset", preset: "claude_code", append: systemAppend || undefined },
      mcpServers: { [MCP_SERVER_NAME]: { type: "sdk", name: MCP_SERVER_NAME, instance: mcp } },
      model: sdkModel,
      ...(effort ? { effort } : {}),
      env: {
        ...process.env,
        ENABLE_CLAUDEAI_MCP_SERVERS: "0",
        DISABLE_AUTO_COMPACT: "1",
      },
      extraArgs: { "strict-mcp-config": null },
    },
  });

  const conv = { q, prompt, parked, resolved, pushedUsers, sdkQuery, model: sdkModel, last: Date.now(), mcp, effort };
  log(`conversation created model=${sdkModel} effort=${effort ?? "(model default)"}`);

  (async () => {
    try {
      for await (const msg of sdkQuery) {
        conv.last = Date.now();
        q.push(msg);
      }
    } catch (e) {
      log("query stream error:", e?.message ?? e);
    } finally {
      q.end();
    }
  })();

  return conv;
}

function destroyConversation(key) {
  const conv = conversations.get(key);
  if (!conv) return;
  conversations.delete(key);
  for (const resolve of conv.parked.values()) resolve("(tool call aborted: session ended)");
  conv.parked.clear();
  try {
    conv.sdkQuery.close?.();
  } catch {}
  try {
    conv.sdkQuery.return?.();
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
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const msg = await conv.q.next();
    if (msg.__end) break;
    if (msg.type === "assistant") {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          // Replaying thinking blocks requires a signature Anthropic can verify.
          // The SDK's summary thinking carries one; keep whatever it provides.
          blocks.push(b);
          if (b.type === "tool_use") sawToolUse = true;
        }
      }
      // A tool_use turn must end on the tool_use block, not on stop_reason:
      // once a call parks, the SDK query blocks inside the tool and never
      // emits a result, so waiting for one would deadlock the request.
      if (sawToolUse) {
        stopReason = "tool_use";
        break;
      }
      const sr = msg.message?.stop_reason;
      if (sr) {
        stopReason = sr;
        break;
      }
    } else if (msg.type === "result") {
      stopReason = stopReason ?? "end_turn";
      break;
    }
  }
  return { blocks, stopReason: stopReason ?? "end_turn" };
}

// Push an effort change to a live query. The effort option is fixed at query()
// time, so a later request in the same conversation has to go through the
// session-scoped flag layer. Only available in streaming input mode, which is
// what this shim uses.
async function applyEffort(conv, effort) {
  if (!effort) return;
  const next = normalizeEffort(effort);
  if (!next || next === conv.effort) return;
  try {
    const q = conv.sdkQuery;
    if (typeof q?.applyFlagSettings === "function") {
      await q.applyFlagSettings({ effortLevel: next });
      conv.effort = next;
      log(`effort -> ${next}`);
      return;
    }
    // Older SDK builds exposed a direct setter on some queries.
    const direct = q?.setEffort ?? q?.setEffortLevel;
    if (typeof direct === "function") {
      await direct.call(q, next);
      conv.effort = next;
      log(`effort -> ${next}`);
      return;
    }
    log(`effort ${next} not applied: no control method on this SDK build`);
  } catch (e) {
    log("effort update failed:", e?.message ?? e);
  }
}

async function handleMessages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const key = convKey(body.model, body.system, messages);

  // Anthropic's wire name for the reasoning level; older bodies nest it under
  // `output_config`. Accept either so a version bump cannot silently drop it.
  const requestedEffort =
    normalizeEffort(body.effort) ?? normalizeEffort(body.output_config?.effort);

  let conv = conversations.get(key);
  if (!conv) {
    conv = await createConversation({
      system: body.system,
      tools: body.tools,
      model: body.model,
      effort: requestedEffort,
    });
    conversations.set(key, conv);
  } else {
    await applyEffort(conv, requestedEffort);
  }
  conv.last = Date.now();

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

  // 2. Push any user turn we have not fed to the query yet. A message whose
  //    blocks are tool_results is a resolution, not a new turn.
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) continue;
    const text = textOf(m.content);
    if (!text) continue;
    const h = userHash(text);
    if (conv.pushedUsers.has(h)) continue;
    conv.pushedUsers.add(h);
    conv.prompt.push({ type: "user", message: { role: "user", content: text } });
    conv.last = Date.now();
  }

  // 3. Produce the next assistant turn.
  const turn = await nextTurn(conv);

  // 4. A tool_use turn ends only once every call has parked — that is the
  //    point at which the caller can execute them and come back.
  if (turn.stopReason === "tool_use") {
    const ids = turn.blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
    const deadline = Date.now() + PARK_TIMEOUT_MS;
    while (ids.some((id) => !conv.parked.has(id)) && Date.now() < deadline) {
      await sleep(25);
    }
  }

  return turn;
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
  const model = conv.model;
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

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
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
    try {
      const turn = await handleMessages(body);
      emitTurn(res, conversations.get(convKey(body.model, body.system, Array.isArray(body.messages) ? body.messages : [])), turn, body.stream === true);
    } catch (e) {
      log("request failed:", e?.stack ?? e);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(e?.message ?? e) } }));
      } else {
        res.end();
      }
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
  log(`listening on http://127.0.0.1:${PORT} (models: ${MODELS.length})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`received ${sig}, closing ${conversations.size} conversation(s)`);
    for (const key of [...conversations.keys()]) destroyConversation(key);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
