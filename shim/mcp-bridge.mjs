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
  const text = await new Promise((resolve) => {
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
            resolve(JSON.parse(b).text ?? "(empty tool result)");
          } catch {
            resolve("(bridge: unreadable shim response)");
          }
        });
      },
    );
    req.on("error", (e) => resolve(`(tool call failed: ${e?.message ?? e})`));
    req.end(body);
  });
  return { content: [{ type: "text", text }] };
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