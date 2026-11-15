// "Ask AI": Claude drives an installed tool or skill inside the Dock VM.
//
// The user types what they want ("trim the first ten seconds and make it a GIF"); Claude
// answers by running shell commands in the VM through the bash tool and reading the
// results. The API key is the user's own and is sent only to the Anthropic API.
//
// No DOM here: the view passes callbacks.

import Anthropic from "../vendor/anthropic.mjs";

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_OUTPUT_CHARS = 12000; // of each command's output shown to the model
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_STEPS = 40;

/** What Claude is told about where it is running. Stable text, so it caches well. */
export function buildSystemPrompt({ app, skills = [], commands = [] }) {
  const lines = [
    "You are the assistant built into Dock, an app that runs open-source tools from GitHub on a phone.",
    "The person is on their phone and cannot type shell commands themselves, so you do the work for them with the bash tool and then tell them plainly what happened.",
    "",
    "# Where commands run",
    "- A small 32-bit x86 Alpine Linux, emulated inside the phone's browser. You are root. Packages install with `apk add`, `pip` and `npm`.",
    "- It is 20 to 50 times slower than a normal computer. Prefer the cheap way to do something: copy streams instead of re-encoding (`ffmpeg -c copy`), work on short clips, avoid compiling. Before starting anything that could take more than a few minutes, tell the person how long you expect it to take and offer a lighter alternative.",
    "- There is no screen, GPU, Docker or desktop browser. If a task needs one of those, say so instead of trying workarounds.",
    "- Each bash call is a fresh shell, so the working directory and variables do not carry over; files do.",
    "",
    "# Files",
    "- Files the person uploads from their phone are in /root/Files. Save anything you make for them there too: the app shows that folder and lets them save files back to the phone.",
    "- Give new files clear names and never overwrite or delete the person's originals unless they ask.",
    "",
    `# The tool this conversation is about: ${app.name}`,
    `- From https://github.com/${app.owner}/${app.repo}${app.description ? ` — ${app.description}` : ""}`,
    `- Installed in /dock/apps/${app.id}`,
  ];
  if (commands.length) lines.push(`- Commands it provides: ${commands.join(", ")}. Run one with --help if you need its options.`);
  if (skills.length) {
    lines.push("", "# Skills installed with it",
      "Each skill is a folder with a SKILL.md that explains how to do a kind of task. Read the SKILL.md with `cat` before using a skill, and follow it.");
    for (const skill of skills) lines.push(`- ${skill.name}: ${skill.description || "no description"} (${skill.path}/SKILL.md)`);
  }
  lines.push("", "# How to answer",
    "Keep replies short and free of jargon: what you did, the name of any file you made, and anything the person needs to decide. Do not paste long command output.");
  return lines.join("\n");
}

function clip(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const half = MAX_OUTPUT_CHARS / 2;
  return `${text.slice(0, half)}\n\n[... ${text.length - MAX_OUTPUT_CHARS} characters left out ...]\n\n${text.slice(-half)}`;
}

/** A readable message for the person from an SDK error. */
export function describeError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return "Stopped.";
  if (err instanceof Anthropic.AuthenticationError) return "That API key was not accepted. Check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key is not allowed to use that model.";
  if (err instanceof Anthropic.RateLimitError) return "The AI service is busy or your key has hit its limit. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) return `The AI service rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the AI service. Check your connection.";
  if (err instanceof Anthropic.APIError) return `The AI service had a problem (${err.status}). Try again.`;
  return err && err.message ? err.message : "Something went wrong.";
}

export class Assistant {
  /**
   * @param {object} o
   * @param {string} o.apiKey the user's Anthropic API key
   * @param {string} o.system from buildSystemPrompt
   * @param {(command: string, signal: AbortSignal) => Promise<{code: number, text: string}>} o.runCommand
   * @param {string} [o.model]
   * @param {string} [o.baseURL] overridden in tests
   */
  constructor(o) {
    this.o = o;
    // This runs in the person's own browser with their own key, which is the case the
    // SDK's dangerouslyAllowBrowser flag exists for.
    this.client = new Anthropic({ apiKey: o.apiKey, baseURL: o.baseURL, dangerouslyAllowBrowser: true, maxRetries: 2 });
    this.messages = [];
    this.busy = false;
    this.abort = null;
    this.usage = { input: 0, output: 0, cached: 0 };
  }

  stop() {
    if (this.abort) this.abort.abort();
  }

  /**
   * Sends one message from the person and works until Claude is done.
   * @param {string} text
   * @param {object} on callbacks: text(string), command({id, command}), result({id, code, text}), notice(string)
   */
  async send(text, on = {}) {
    if (this.busy) throw new Error("Still working on the previous request.");
    this.busy = true;
    this.abort = new AbortController();
    const { signal } = this.abort;
    this.messages.push({ role: "user", content: text });
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const response = await this.client.beta.messages.create({
          model: this.o.model || DEFAULT_MODEL,
          max_tokens: 16000,
          system: this.o.system,
          // Caches the system prompt and the conversation so far between steps.
          cache_control: { type: "ephemeral" },
          output_config: { effort: "medium" },
          tools: [{ type: "bash_20250124", name: "bash" }],
          // If a safety classifier declines the request, let the API retry it on the
          // model it recommends instead of stopping dead.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          messages: this.messages,
        }, { signal });

        this.usage.input += response.usage.input_tokens || 0;
        this.usage.output += response.usage.output_tokens || 0;
        this.usage.cached += response.usage.cache_read_input_tokens || 0;

        // Keep the whole reply (thinking and tool calls included) exactly as it came.
        this.messages.push({ role: "assistant", content: response.content });
        for (const block of response.content) {
          if (block.type === "text" && block.text.trim() && on.text) on.text(block.text);
        }

        if (response.stop_reason === "refusal") {
          if (on.notice) on.notice("The AI declined this request.");
          return;
        }
        if (response.stop_reason === "max_tokens") {
          if (on.notice) on.notice("The reply was cut off for length. Ask it to continue.");
          return;
        }
        if (response.stop_reason === "pause_turn") continue;
        const calls = response.content.filter(block => block.type === "tool_use");
        if (response.stop_reason !== "tool_use" || !calls.length) return;

        // Run every requested command, then answer all of them in one message.
        const results = [];
        for (const call of calls) {
          results.push(await this.runTool(call, on, signal));
        }
        this.messages.push({ role: "user", content: results });
      }
      if (on.notice) on.notice("Stopped after many steps. Tell it to continue if it wasn't finished.");
    } catch (err) {
      this.repairAfterInterruption();
      throw err;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  async runTool(call, on, signal) {
    const input = call.input || {};
    if (call.name !== "bash") {
      return { type: "tool_result", tool_use_id: call.id, content: `Unknown tool ${call.name}.`, is_error: true };
    }
    if (input.restart) {
      return { type: "tool_result", tool_use_id: call.id, content: "Shell restarted. Every command already runs in a fresh shell." };
    }
    if (typeof input.command !== "string" || !input.command.trim()) {
      return { type: "tool_result", tool_use_id: call.id, content: "No command was given.", is_error: true };
    }
    if (on.command) on.command({ id: call.id, command: input.command });
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), COMMAND_TIMEOUT_MS); });
      const { code, text } = await Promise.race([this.o.runCommand(input.command, signal), timeout]);
      if (signal.aborted) throw new Anthropic.APIUserAbortError();
      if (on.result) on.result({ id: call.id, code, text });
      const body = clip(text.trim()) || "(no output)";
      return { type: "tool_result", tool_use_id: call.id, content: code === 0 ? body : `${body}\n\n[exit code ${code}]`, is_error: code !== 0 };
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError) throw err;
      const message = err.message === "timeout" ? "The command ran for 20 minutes and was stopped." : `The command could not be run: ${err.message}`;
      if (on.result) on.result({ id: call.id, code: -1, text: message });
      return { type: "tool_result", tool_use_id: call.id, content: message, is_error: true };
    } finally {
      clearTimeout(timer);
    }
  }

  // A conversation must never end on tool calls without results, or the next request is
  // rejected. If we were interrupted there, answer the pending calls as cancelled.
  repairAfterInterruption() {
    const last = this.messages[this.messages.length - 1];
    if (!last) return;
    if (last.role === "assistant" && Array.isArray(last.content)) {
      const pending = last.content.filter(block => block.type === "tool_use");
      if (pending.length) {
        this.messages.push({ role: "user", content: pending.map(call => ({ type: "tool_result", tool_use_id: call.id, content: "Cancelled by the person before it finished.", is_error: true })) });
      }
    } else if (last.role === "user" && typeof last.content === "string") {
      this.messages.pop(); // the request never got an answer; let the person resend it
    }
  }
}
