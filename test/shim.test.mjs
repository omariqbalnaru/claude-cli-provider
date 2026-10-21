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
const say = (text, model) => {
  out({ type: "assistant", message: { model, content: [{ type: "text", text }], stop_reason: "end_turn" } });
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
  if (text.includes("PID")) return say("pid " + process.pid);
  if (text.includes("ARGS")) return say(JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), tools: JSON.parse(fs.readFileSync(bridge.CLAUDE_BRIDGE_TOOLS, "utf8")), cwd: process.cwd(), files: fs.readdirSync(process.cwd()), memory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY }));
  if (text.includes("FALLBACK")) return say("fallback answer", "claude-opus-4-8");
  if (text.includes("CHATTER")) {
    // Like the real CLI between turns: keeps emitting stdout lines while parked.
    say("echo: " + text);
    setInterval(() => out({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 0 } } }), 100);
    return;
  }
  if (text.includes("FAIL")) {
    out({ type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: "usage limit hit" }], stop_reason: "stop_sequence" } });
    return out({ type: "result", subtype: "success", is_error: true, result: "usage limit hit" });
  }
  if (text.includes("TOOL") && !text.includes("Tool result")) {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__cctools__echo", input: text.includes("canonical") ? { outer: { b: 2, a: 1 }, list: [1, 2] } : {} }] } });
    out({ type: "stream_event", event: { type: "message_stop" } });
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

for (const stream of [false, true]) {
  test(`malformed messages and tools fail before response streaming (stream=${stream})`, async () => {
    const invalid = [
      ["missing messages", {}],
      ["empty messages", { messages: [] }],
      ["non-array messages", { messages: {} }],
      ["null message", { messages: [null] }],
      ["invalid role", { messages: [{ role: "system", content: "x" }] }],
      ["null content", { messages: [user(null)] }],
      ["null block", { messages: [user([null])] }],
      ["missing block type", { messages: [user([{ text: "x" }])] }],
      ["missing text", { messages: [user([{ type: "text" }])] }],
      ["non-string text", { messages: [user([{ type: "text", text: 1 }])] }],
      ["non-array tools", { ...msgs(user("invalid tools")), tools: {} }],
      ["null tools", { ...msgs(user("invalid tools")), tools: null }],
      ["empty tool name", { ...msgs(user("invalid tools")), tools: [{ name: "", input_schema: {} }] }],
      ["missing tool schema", { ...msgs(user("invalid tools")), tools: [{ name: "echo" }] }],
      ["null tool schema", { ...msgs(user("invalid tools")), tools: [{ name: "echo", input_schema: null }] }],
      ["array tool schema", { ...msgs(user("invalid tools")), tools: [{ name: "echo", input_schema: [] }] }],
    ];
    for (const [name, body] of invalid) {
      const response = await request({ ...body, stream });
      assert.equal(response.status, 400, name);
      assert.equal(JSON.parse(response.data).error.type, "invalid_request_error", name);
      assert.doesNotMatch(response.data, /event: message_start/, name);
    }
  });
}

test("model and tools remain optional", async () => {
  const response = await request({ messages: [user("optional request fields")] });
  assert.equal(response.status, 200);
  assert.match(text(response), /optional request fields/);
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

for (const stream of [false, true]) {
  test(`fallback reports answering model (stream=${stream})`, async () => {
    const response = await request({ model: "claude-fable-5-1", messages: [user("FALLBACK")], stream });
    assert.equal(response.status, 200);
    const message = stream
      ? response.data.split("\n").filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "message_start").message
      : JSON.parse(response.data);
    assert.equal(message.model, "claude-opus-4-8");
  });
}

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

test("pi context-mode: a per-request note that vanishes later does not rebuild", async () => {
  // Captured from pi with the context-mode extension: request 1 has the
  // prompt plus an injected note; request 2 drops the note.
  const prompt = user("TOOL ctx");
  const r1 = JSON.parse((await request(msgs(prompt, user("context-mode active. Hierarchy: …")))).data);
  assert.equal(r1.stop_reason, "tool_use");
  const r2 = await request(msgs(prompt, { role: "assistant", content: r1.content }, user([{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }])));
  assert.match(text(r2), /^echo: |tool said: out/);
  assert.doesNotMatch(text(r2), /Continue this conversation/);
});

test("a <system-reminder> block that changes between requests does not rebuild", async () => {
  const first = user([{ type: "text", text: "<system-reminder>Today: day 1</system-reminder>" }, { type: "text", text: "alpha reminder" }]);
  const r1 = JSON.parse((await request(msgs(first))).data);
  const later = user([{ type: "text", text: "<system-reminder>Today: day 2</system-reminder>" }, { type: "text", text: "alpha reminder" }]);
  const r2 = text(await request(msgs(later, { role: "assistant", content: r1.content }, user("beta reminder"))));
  assert.match(r2, /echo: \[\{"type":"text","text":"beta reminder"\}\]/);
});

test("inline reminder changes preserve reuse without hiding real user edits", async () => {
  const opening = user("PID inline reminder");
  const first = JSON.parse((await request(msgs(opening, user("<system-reminder>day 1</system-reminder>keep this rule")))).data);
  const unchanged = [
    opening,
    user("<system-reminder>day 2</system-reminder>keep this rule"),
    { role: "assistant", content: first.content },
  ];
  const second = JSON.parse((await request(msgs(...unchanged, user("PID same rule")))).data);
  assert.equal(second.content[0].text, first.content[0].text);
  const edited = await request(msgs(
    opening,
    user("<system-reminder>day 3</system-reminder>edited rule"),
    { role: "assistant", content: first.content },
    user("PID same rule"),
    { role: "assistant", content: second.content },
    user("PID edited rule"),
  ));
  assert.notEqual(text(edited), first.content[0].text);
});

test("a reminder-only message may disappear without rebuilding", async () => {
  const opening = user("PID disappearing reminder");
  const first = JSON.parse((await request(msgs(opening, user("<system-reminder>transient context</system-reminder>")))).data);
  const next = await request(msgs(opening, { role: "assistant", content: first.content }, user("PID next")));
  assert.equal(text(next), first.content[0].text);
});

test("deleting an ordinary user message rebuilds the child", async () => {
  const opening = user("PID deleted instruction");
  const first = JSON.parse((await request(msgs(opening, user("keep this rule")))).data);
  const next = await request(msgs(opening, { role: "assistant", content: first.content }, user("PID after deletion")));
  assert.notEqual(text(next), first.content[0].text);
});

test("editing assistant text rebuilds from the edited transcript", async () => {
  const opening = user("assistant edit opening");
  await request(msgs(opening));
  const next = await request(msgs(opening, { role: "assistant", content: "edited assistant answer" }, user("continue")));
  assert.match(text(next), /Assistant: edited assistant answer/);
  assert.match(text(next), /Continue this conversation/);
});

test("assistant text string/block serialization and thinking rewrites preserve reuse", async () => {
  const opening = user("PID assistant serialization");
  const first = JSON.parse((await request(msgs(opening))).data);
  const second = JSON.parse((await request(msgs(opening, { role: "assistant", content: ` ${first.content[0].text}\n` }, user("PID string")))).data);
  const third = await request(msgs(
    opening,
    { role: "assistant", content: first.content },
    user("PID string"),
    { role: "assistant", content: [{ type: "thinking", thinking: "rewritten", signature: "changed" }, ...second.content] },
    user("PID blocks"),
  ));
  assert.equal(second.content[0].text, first.content[0].text);
  assert.equal(text(third), first.content[0].text);
});

for (const field of ["input", "name"]) {
  test(`editing assistant tool ${field} rebuilds from the edited transcript`, async () => {
    const opening = user(`TOOL edit ${field}`);
    const first = JSON.parse((await request(msgs(opening))).data);
    assert.equal(first.stop_reason, "tool_use");
    const edited = first.content.map((block) => ({ ...block, [field]: field === "input" ? { changed: true } : "changed_tool" }));
    const next = await request(msgs(opening, { role: "assistant", content: edited }, user([{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }])));
    assert.match(text(next), /Continue this conversation/);
    assert.ok(text(next).includes(field === "input" ? '\\"changed\\":true' : "changed_tool"));
  });
}

test("tool input key order and MCP naming preserve the running tool call", async () => {
  const opening = user("TOOL canonical");
  const first = JSON.parse((await request(msgs(opening))).data);
  const equivalent = first.content.map((block) => ({ ...block, name: "mcp__cctools__echo", input: { list: [1, 2], outer: { a: 1, b: 2 } } }));
  const next = await request(msgs(opening, { role: "assistant", content: equivalent }, user([{ type: "tool_result", tool_use_id: "toolu_1", content: "out" }])));
  assert.equal(text(next), "tool said: out");
});

test("rewritten historical tool outputs and removed images preserve reuse", async () => {
  const opening = user([{ type: "text", text: "TOOL prune output" }, { type: "image", source: IMG }]);
  const first = JSON.parse((await request(msgs(opening))).data);
  const assistant = { role: "assistant", content: first.content };
  const result = JSON.parse((await request(msgs(opening, assistant, user([{ type: "tool_result", tool_use_id: "toolu_1", content: "original output" }])))).data);
  const next = await request(msgs(
    user("TOOL prune output"),
    assistant,
    user([{ type: "tool_result", tool_use_id: "toolu_1", content: "(old output pruned)" }]),
    { role: "assistant", content: result.content },
    user("after pruning"),
  ));
  assert.match(text(next), /^echo: \[\{"type":"text","text":"after pruning"\}\]/);
});

const echoTool = { name: "echo", description: "original description", input_schema: { type: "object", properties: {} } };
for (const [change, beforeTools, afterTools] of [
  ["added", [], [echoTool]],
  ["removed", [echoTool], []],
  ["renamed", [echoTool], [{ ...echoTool, name: "other" }]],
  ["description", [echoTool], [{ ...echoTool, description: "new description" }]],
  ["schema", [echoTool], [{ ...echoTool, input_schema: { type: "object", properties: { value: { type: "string" } } } }]],
]) {
  test(`tool definitions ${change} rebuild and reach the new child`, async () => {
    const opening = user(`ARGS tools ${change}`);
    const first = JSON.parse((await request({ ...msgs(opening), tools: beforeTools })).data);
    const prior = JSON.parse(first.content[0].text);
    const next = JSON.parse(text(await request({ ...msgs(opening, { role: "assistant", content: first.content }, user("ARGS next")), tools: afterTools })));
    assert.notEqual(next.pid, prior.pid);
    assert.deepEqual(next.tools, afterTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })));
  });
}

test("equivalent tool schema key order preserves reuse", async () => {
  const opening = user("ARGS equivalent tools");
  const first = JSON.parse((await request({ ...msgs(opening), tools: [echoTool] })).data);
  const next = JSON.parse(text(await request({
    ...msgs(opening, { role: "assistant", content: first.content }, user("ARGS next")),
    tools: [{ input_schema: { properties: {}, type: "object" }, description: "original description", name: "echo" }],
  })));
  assert.equal(next.pid, JSON.parse(first.content[0].text).pid);
});

for (const source of ["effort", "output_config", "suffix"]) {
  test(`removing explicit ${source} effort rebuilds with the CLI default`, async () => {
    const opening = user(`ARGS reset ${source}`);
    const configured = source === "suffix"
      ? { ...msgs(opening), model: "claude-sonnet-5:high" }
      : { ...msgs(opening), ...(source === "effort" ? { effort: "high" } : { output_config: { effort: "high" } }) };
    const first = JSON.parse((await request(configured)).data);
    const prior = JSON.parse(first.content[0].text);
    assert.equal(prior.argv[prior.argv.indexOf("--effort") + 1], "high");
    const next = JSON.parse(text(await request(msgs(opening, { role: "assistant", content: first.content }, user("ARGS default")))));
    assert.notEqual(next.pid, prior.pid);
    assert.ok(!next.argv.includes("--effort"));
  });
}

test("rebuild replays complete earlier text, tool input, and tool output", async () => {
  const userText = "U".repeat(4500) + "USER_END";
  const assistantText = "A".repeat(4500) + "ASSISTANT_END";
  const toolInput = "I".repeat(4500) + "INPUT_END";
  const toolOutput = "O".repeat(4500) + "OUTPUT_END";
  const response = await request(msgs(
    user(userText),
    { role: "assistant", content: [{ type: "text", text: assistantText }, { type: "tool_use", id: "old", name: "echo", input: { value: toolInput } }] },
    user([{ type: "tool_result", tool_use_id: "old", content: toolOutput }]),
    { role: "assistant", content: "done" },
    user("continue replay"),
  ));
  for (const complete of [userText, assistantText, toolInput, toolOutput]) assert.ok(text(response).includes(complete));
  assert.doesNotMatch(text(response), /truncated/);
});

test("the same opening in two sessions gets two children", async () => {
  const opening = msgs(user("PID session"));
  const s1 = { "x-claude-code-session-id": "s-1" };
  const a = JSON.parse((await request(opening, s1)).data);
  const b = JSON.parse((await request(opening, { "x-claude-code-session-id": "s-2" })).data);
  assert.notEqual(a.content[0].text, b.content[0].text);
  // Session 1 is still on its own live child.
  const again = JSON.parse((await request(msgs(user("PID session"), { role: "assistant", content: a.content }, user("PID again")), s1)).data);
  assert.equal(again.content[0].text, a.content[0].text);
});

test("child chatter while parked does not defeat the idle sweep", async () => {
  // The real CLI emits periodic stdout lines while parked; they used to
  // refresh conv.last, so idle conversations never reaped (7h+ in
  // production) and every shim deploy wedged on the busy deadline.
  const sweepPort = await new Promise((resolve) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  const sweepShim = spawn(process.execPath, [join(ROOT, "shim/server.mjs")], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CLAUDE_SHIM_PORT: String(sweepPort),
      CLAUDE_SHIM_IDLE_MS: "1000",
      CLAUDE_SHIM_SWEEP_MS: "300",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await new Promise((resolve) => sweepShim.stderr.on("data", (d) => String(d).includes("listening on") && resolve()));
    const base = `http://127.0.0.1:${sweepPort}`;
    const res = await fetch(base + "/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku", messages: [user("CHATTER")] }),
    });
    assert.equal(res.status, 200);
    assert.equal((JSON.parse(await res.text())).stop_reason, "end_turn");
    let conversations = 1;
    for (let i = 0; i < 40 && conversations !== 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const h = JSON.parse(await (await fetch(base + "/healthz")).text());
      assert.ok(Number.isSafeInteger(h.oldest_idle_ms), "healthz reports oldest_idle_ms");
      conversations = h.conversations;
    }
    assert.equal(conversations, 0, "chattering child must still be reaped when idle");
  } finally {
    sweepShim.kill();
  }
});
