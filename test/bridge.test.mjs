import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bridge reports shim aborts as tool errors, preserves successful results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
  await writeFile(join(dir, "tools.json"), "[]");
  let reply = { text: "(tool call aborted: session ended)" };
  const server = http.createServer((req, res) => { req.resume(); res.end(JSON.stringify(reply)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const child = spawn(process.execPath, ["shim/mcp-bridge.mjs"], {
    env: { ...process.env, CLAUDE_BRIDGE_PORT: String(server.address().port), CLAUDE_BRIDGE_TOOLS: join(dir, "tools.json"), CLAUDE_BRIDGE_CONV: "test" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const call = async (id) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo", arguments: {}, _meta: { "claudecode/toolUseId": String(id) } } }) + "\n");
    return JSON.parse((await lines.next()).value).result;
  };
  try {
    const aborted = await call(1);
    assert.equal(aborted.isError, true);
    assert.equal(aborted.content[0].text, reply.text);
    reply = { content: [{ type: "text", text: "actual result" }] };
    assert.deepEqual(await call(2), reply);
    reply = { content: [{ type: "text", text: "tool failed" }], isError: true };
    assert.deepEqual(await call(3), reply);
  } finally {
    child.kill();
    await once(child, "exit");
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
