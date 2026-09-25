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
// Like the real CLI, input that arrives while a tool call runs is folded into
// that turn instead of starting a new one.
let inTool = false;
const folded = [];
rl.on("line", async (line) => {
  const content = JSON.parse(line).message.content;
  if (inTool) return folded.push(JSON.stringify(content));
  const text = typeof content === "string" ? content : JSON.stringify(content);
  if (text.includes("DIE") && !fs.existsSync(process.env.STUB_DIED)) {
    fs.writeFileSync(process.env.STUB_DIED, "");
    process.exit(1);
  }
  if (text.includes("ENV")) return say(Object.keys(process.env).join(","));
  if (text.includes("ARGS")) return say(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), files: fs.readdirSync(process.cwd()), memory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY }));
  if (text.includes("FAIL")) {
    out({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: "usage limit hit" }], stop_reason: "stop_sequence" } });
    return out({ type: "result", subtype: "success", is_error: true, result: "usage limit hit" });
  }
  if (text.includes("TOOL") && !text.includes("Tool result")) {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__cctools__echo", input: {} }] } });
    inTool = true;
    const r = await fetch("http://127.0.0.1:" + bridge.CLAUDE_BRIDGE_PORT + "/internal/toolcall", {
      method: "POST", body: JSON.stringify({ conv: bridge.CLAUDE_BRIDGE_CONV, id: "toolu_1" }),
    });
    const reply = await r.json();
    inTool = false;
    const said = (reply.content ?? [reply]).map((b) => b.text ?? "[" + b.type + "]").join("\\n");
    return say("tool said: " + said + (folded.length ? " | folded: " + folded.splice(0).join(" ") : ""));
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

test("child runs isolated: no slash commands, no session files, no memory, empty cwd", async () => {
  const info = JSON.parse(text(await request(msgs(user("ARGS")))).replace(/^echo: /, ""));
  for (const flag of ["--disable-slash-commands", "--no-session-persistence", "--allowedTools"]) assert.ok(info.argv.includes(flag), flag);
  assert.equal(info.argv[info.argv.indexOf("--allowedTools") + 1], "mcp__cctools");
  assert.equal(info.memory, "1");
  assert.deepEqual(info.files, []);
  assert.ok(!info.cwd.startsWith(ROOT), info.cwd);
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

test("text sent with a tool_result is folded into the running turn", async () => {
  const opening = user("TOOL go");
  const r1 = JSON.parse((await request(msgs(opening))).data);
  assert.equal(r1.stop_reason, "tool_use");
  const r2 = await request(msgs(
    opening,
    { role: "assistant", content: r1.content },
    user([
      { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "out" }, { type: "image", source: IMG }] },
      { type: "text", text: "steer left" },
    ]),
  ));
  assert.match(text(r2), /tool said: out\n\[image\] \| folded: .*steer left/);
  // Nothing was written to the child mid-turn, so the next reply answers the
  // next message rather than lagging one behind.
  const r3 = await request(msgs(
    opening,
    { role: "assistant", content: r1.content },
    user([{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }, { type: "text", text: "steer left" }]),
    { role: "assistant", content: JSON.parse(r2.data).content },
    user("after the tool"),
  ));
  assert.match(text(r3), /^echo: .*after the tool/);
});

const IMG = { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" };

test("live child gets only the new message; an edited history rebuilds it", async () => {
  const a = user("alpha live");
  const r1 = JSON.parse((await request(msgs(a))).data);
  const next = [a, { role: "assistant", content: r1.content }];
  const live = text(await request(msgs(...next, user("beta"))));
  assert.match(live, /echo: \[\{"type":"text","text":"beta"\}\]/);
  // Same length, different last message: the child's context no longer
  // matches, so it is rebuilt from the transcript instead of hanging.
  const edited = text(await request(msgs(...next, user("gamma"))));
  assert.match(edited, /Continue this conversation/);
  assert.match(edited, /User: gamma/);
});

test("an identical resend rebuilds instead of waiting on an idle child", async () => {
  const a = user("alpha resend");
  const r1 = JSON.parse((await request(msgs(a))).data);
  const history = msgs(a, { role: "assistant", content: r1.content }, user("again"));
  assert.equal((await request(history)).status, 200);
  const resent = await request(history);
  assert.equal(resent.status, 200);
  assert.match(text(resent), /Continue this conversation/);
});

test("user images reach the child as image blocks", async () => {
  const r = await request(msgs(user([{ type: "text", text: "look" }, { type: "image", source: IMG }])));
  assert.match(text(r), /"type":"image","source":\{"type":"base64","media_type":"image\/png"/);
});
