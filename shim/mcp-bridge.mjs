#!/usr/bin/env node
// stdio MCP bridge spawned by the claude CLI child (--mcp-config). Serves the
// caller's tools to claude and parks each call on the shim over a localhost
// HTTP long-poll until the caller's next request supplies the matching
// tool_result. Kept dependency-free: raw JSON-RPC over stdin/stdout lines.

import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.env.CLAUDE_BRIDGE_PORT);
const TOOLS_FILE = process.env.CLAUDE_BRIDGE_TOOLS;
const CONV = process.env.CLAUDE_BRIDGE_CONV ?? "";

let defs = [];
try {
  defs = JSON.parse(fs.readFileSync(TOOLS_FILE, "utf8"));
} catch (e) {
  process.stderr.write(`[mcp-bridge] failed to read tools file: ${e?.message ?? e}\n`);
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function callTool(msg) {
  const id = msg.params?._meta?.["claudecode/toolUseId"];
  const name = msg.params?.name ?? "";
  const input = msg.params?.arguments ?? {};
  const body = JSON.stringify({ conv: CONV, id, name, input });
  // The shim answers { content: [Anthropic blocks], isError } for a real tool
  // result, or { text } for its own aborts and failures.
  const reply = await new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/internal/toolcall",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch {
            resolve({ text: "(bridge: unreadable shim response)" });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ text: `(tool call failed: ${e?.message ?? e})` }));
    req.end(body);
  });
  const blocks = reply.content ?? [{ type: "text", text: reply.text ?? "(empty tool result)" }];
  return { content: blocks.map(toMcp), ...(reply.isError && { isError: true }) };
}

// Anthropic content block -> MCP content item. MCP images carry base64 only.
function toMcp(b) {
  if (b?.type === "image" && b.source?.type === "base64") {
    return { type: "image", data: b.source.data, mimeType: b.source.media_type };
  }
  if (b?.type === "image") return { type: "text", text: `[image: ${b.source?.url ?? "unsupported source"}]` };
  return { type: "text", text: b?.text ?? `[${b?.type ?? "block"}]` };
}

function handle(msg) {
  if (msg?.id === undefined || msg?.id === null) return; // notification
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cctools", version: "1.0.0" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: defs } });
    return;
  }
  if (msg.method === "tools/call") {
    callTool(msg)
      .then((result) => send({ jsonrpc: "2.0", id: msg.id, result }))
      .catch((e) => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }));
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let i; (i = buf.indexOf("\n")) >= 0; ) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      process.stderr.write(`[mcp-bridge] bad line: ${e?.message ?? e}\n`);
    }
  }
});
process.stdin.resume();