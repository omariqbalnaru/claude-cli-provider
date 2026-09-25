// Drives the real shim against a stub `claude` on PATH. Run: node --test test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "shim-test-"));

// Stub CLI: reads stream-json user messages and reacts to markers in the text.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const say = (text) => {
  out({ type: "assistant", message: { content: [{ type: "text", text }], stop_reason: "end_turn" } });
  out({ type: "result", subtype: "success" });
};
const mcp = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--mcp-config") + 1], "utf8"));
const bridge = Object.values(mcp.mcpServers)[0].env;
rl.on("line", async (line) => {
  const content = JSON.parse(line).message.content;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  if (text.includes("DIE") && !fs.existsSync(process.env.STUB_DIED)) {
    fs.writeFileSync(process.env.STUB_DIED, "");
    process.exit(1);
  }
  if (text.includes("ENV")) return say(Object.keys(process.env).join(","));
  if (text.includes("FAIL")) {
    out({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: "usage limit hit" }], stop_reason: "stop_sequence" } });
    return out({ type: "result", subtype: "success", is_error: true, result: "usage limit hit" });
  }
  if (text.includes("TOOL") && !text.includes("Tool result")) {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__cctools__echo", input: {} }] } });
    const r = await fetch("http://127.0.0.1:" + bridge.CLAUDE_BRIDGE_PORT + "/internal/toolcall", {
      method: "POST", body: JSON.stringify({ conv: bridge.CLAUDE_BRIDGE_CONV, id: "toolu_1" }),
    });
    return say("tool said: " + (await r.json()).text);
  }
  say("echo: " + text);
});
`;
writeFileSync(join(dir, "claude"), STUB);
chmodSync(join(dir, "claude"), 0o755);

let shim;
let port;
before(async () => {
  port = await new Promise((resolve) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  shim = spawn(process.execPath, [join(ROOT, "shim/server.mjs")], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CLAUDE_SHIM_PORT: String(port),
      STUB_DIED: join(dir, "died"),
      ANTHROPIC_API_KEY: "sk-ant-should-not-reach-child",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      CLAUDE_CODE_OAUTH_TOKEN: "kept",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve) => shim.stderr.on("data", (d) => String(d).includes("listening on") && resolve()));
});
after(() => shim.kill());

function request(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    req.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}
const msgs = (...m) => ({ model: "claude-sonnet-5", messages: m });
const user = (content) => ({ role: "user", content });
const text = (r) => JSON.parse(r.data).content.map((b) => b.text ?? "").join("");

test("null and non-object bodies are 400, shim survives", async () => {
  assert.equal((await request("null")).status, 400);
  assert.equal((await request("[1]")).status, 400);
  assert.equal((await request(msgs(user("hello")))).status, 200);
});

test("non-loopback Host or Origin is refused", async () => {
  assert.equal((await request(msgs(user("x")), { host: "evil.example" })).status, 403);
  assert.equal((await request(msgs(user("x")), { origin: "https://evil.example" })).status, 403);
});

test("oversized body is 413", async () => {
  assert.equal((await request("x".repeat(33 * 1024 * 1024))).status, 413);
});

test("child env drops ANTHROPIC_* but keeps subscription auth", async () => {
  const keys = text(await request(msgs(user("ENV")))).split(",");
  assert.ok(!keys.some((k) => k.startsWith("ANTHROPIC_")), keys.join(","));
  assert.ok(keys.includes("CLAUDE_CODE_OAUTH_TOKEN"));
});

test("CLI API error becomes an HTTP error, and an SSE error event when streaming", async () => {
  const r = await request(msgs(user("FAIL plain")));
  assert.equal(r.status, 429);
  assert.equal(JSON.parse(r.data).error.message, "usage limit hit");
  const s = await request({ ...msgs(user("FAIL stream")), stream: true });
  assert.match(s.data, /event: error\ndata: .*rate_limit_error/);
});

test("dead child errors the turn, next request gets a fresh child", async () => {
  const first = await request(msgs(user("DIE once")));
  assert.equal(first.status, 500);
  const second = await request(msgs(user("DIE once")));
  assert.equal(second.status, 200);
  assert.match(text(second), /echo: .*DIE once/);
});

test("the message being answered is never truncated", async () => {
  const long = "L".repeat(5000) + "END";
  assert.ok(text(await request(msgs(user("opening"), { role: "assistant", content: "ok" }, user(long)))).includes(long));
});

test("text riding with a tool_result reaches the child", async () => {
  const opening = user("TOOL go");
  const r1 = JSON.parse((await request(msgs(opening))).data);
  assert.equal(r1.stop_reason, "tool_use");
  const r2 = await request(msgs(
    opening,
    { role: "assistant", content: r1.content },
    user([{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }, { type: "text", text: "steer left" }]),
  ));
  assert.match(text(r2), /tool said: out\n\nUser message sent with this tool result:\nsteer left/);
});
