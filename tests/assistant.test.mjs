// The assistant's agent loop, against tests/mock-anthropic.mjs. Run: node --test tests/assistant.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { Assistant, buildSystemPrompt, describeError, DEFAULT_MODEL } from "../web/js/assistant.js";
import { startMockAnthropic } from "./mock-anthropic.mjs";

const app = { id: "acme--tool", owner: "acme", repo: "tool", name: "tool", description: "Does things" };

test("system prompt names the tool, its commands and its skills", () => {
  const text = buildSystemPrompt({ app, commands: ["tool"], skills: [{ name: "edit", description: "Edits video", path: "/dock/skills/edit" }] });
  assert.match(text, /https:\/\/github\.com\/acme\/tool/);
  assert.match(text, /Commands it provides: tool/);
  assert.match(text, /edit: Edits video \(\/dock\/skills\/edit\/SKILL\.md\)/);
  assert.match(text, /\/root\/Files/);
  assert.equal(text, buildSystemPrompt({ app, commands: ["tool"], skills: [{ name: "edit", description: "Edits video", path: "/dock/skills/edit" }] }), "stable, so it can be cached");
});

test("runs the commands Claude asks for and returns their output", async () => {
  const api = await startMockAnthropic({ commands: ["ls /root/Files", "false"], finalText: "Trimmed it." });
  const ran = [];
  const assistant = new Assistant({
    apiKey: api.key, baseURL: api.baseURL, system: "sys",
    runCommand: async command => { ran.push(command); return command === "false" ? { code: 1, text: "boom" } : { code: 0, text: "clip.mp4\n" }; },
  });
  const events = [];
  await assistant.send("trim my clip", {
    text: t => events.push(["text", t]), command: c => events.push(["command", c.command]), result: r => events.push(["result", r.code]),
  });
  assert.deepEqual(ran, ["ls /root/Files", "false"]);
  assert.deepEqual(events, [["text", "Let me take a look."], ["command", "ls /root/Files"], ["result", 0], ["command", "false"], ["result", 1], ["text", "Trimmed it."]]);
  assert.equal(api.requests.length, 3);
  const first = api.requests[0];
  assert.equal(first.body.model, DEFAULT_MODEL);
  assert.deepEqual(first.body.tools, [{ type: "bash_20250124", name: "bash" }]);
  assert.deepEqual(first.body.cache_control, { type: "ephemeral" });
  assert.equal(first.body.fallbacks, "default");
  assert.match(first.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(first.body.thinking, undefined, "adaptive thinking is the default; nothing to send");
  const last = api.requests[2].body.messages;
  assert.deepEqual(last.map(m => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.deepEqual(last[2].content, [{ type: "tool_result", tool_use_id: "toolu_1", content: "clip.mp4", is_error: false }]);
  assert.equal(last[4].content[0].is_error, true);
  assert.match(last[4].content[0].content, /boom\n\n\[exit code 1\]/);
  assert.deepEqual(assistant.usage, { input: 300, output: 60, cached: 160 });

  // a second request continues the same conversation
  await assistant.send("thanks");
  assert.equal(api.requests[3].body.messages.length, 7);
  api.close();
});

test("stopping mid-command leaves a conversation the API will still accept", async () => {
  const api = await startMockAnthropic({ commands: ["sleep 600"] });
  let calls = 0;
  let assistant;
  assistant = new Assistant({
    apiKey: api.key, baseURL: api.baseURL, system: "sys",
    runCommand: (command, signal) => {
      if (++calls > 1) return Promise.resolve({ code: 0, text: "ok" });
      return new Promise(resolve => {
        signal.addEventListener("abort", () => resolve({ code: 143, text: "" }));
        setTimeout(() => assistant.stop(), 30);
      });
    },
  });
  await assert.rejects(assistant.send("do something slow"), err => describeError(err) === "Stopped.");
  assert.equal(assistant.busy, false);
  const tail = assistant.messages[assistant.messages.length - 1];
  assert.equal(tail.content[0].type, "tool_result");
  await assistant.send("never mind"); // the mock rejects unanswered tool calls with a 400
  api.close();
});

test("a bad key is reported in plain words and the unsent message is dropped", async () => {
  const api = await startMockAnthropic();
  const assistant = new Assistant({ apiKey: "wrong", baseURL: api.baseURL, system: "sys", runCommand: async () => ({ code: 0, text: "" }) });
  await assert.rejects(assistant.send("hi"), err => /API key was not accepted/.test(describeError(err)));
  assert.equal(assistant.messages.length, 0);
  api.close();
});
