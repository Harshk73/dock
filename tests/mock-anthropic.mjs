// A local stand-in for the Anthropic Messages API, scripted for tests: it asks for the
// bash commands it was given, one per turn, then finishes with a text reply.
import http from "node:http";

export async function startMockAnthropic({ commands = ["echo hello"], finalText = "All done.", key = "sk-test" } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "*");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const json = (code, body) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    if (!req.url.startsWith("/v1/messages")) return json(404, { type: "error", error: { type: "not_found_error", message: "no such route" } });
    // Current SDKs send the key as a bearer token; older ones used x-api-key.
    if (req.headers.authorization !== `Bearer ${key}` && req.headers["x-api-key"] !== key) return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: req.url, headers: req.headers, body });
    // Validate the conversation shape the real API enforces.
    const msgs = body.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "assistant" && Array.isArray(m.content)) {
        const ids = m.content.filter(b => b.type === "tool_use").map(b => b.id);
        if (ids.length) {
          const next = msgs[i + 1];
          const answered = next && next.role === "user" && Array.isArray(next.content) ? next.content.filter(b => b.type === "tool_result").map(b => b.tool_use_id) : [];
          if (ids.some(id => !answered.includes(id))) return json(400, { type: "error", error: { type: "invalid_request_error", message: "tool_use ids were found without tool_result blocks immediately after" } });
        }
      }
    }
    const done = msgs.filter(m => m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "tool_result")).length;
    const turnStart = msgs.map((m, i) => (m.role === "user" && typeof m.content === "string" ? i : -1)).filter(i => i >= 0).pop();
    const doneThisTurn = msgs.slice(turnStart).filter(m => m.role === "user" && Array.isArray(m.content)).length;
    const base = { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: done ? 80 : 0, cache_creation_input_tokens: 0 } };
    if (doneThisTurn < commands.length) {
      return json(200, { ...base, stop_reason: "tool_use", content: [
        { type: "text", text: doneThisTurn === 0 ? "Let me take a look." : "" },
        { type: "tool_use", id: `toolu_${requests.length}`, name: "bash", input: { command: commands[doneThisTurn] } },
      ] });
    }
    json(200, { ...base, stop_reason: "end_turn", content: [{ type: "text", text: finalText }] });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { baseURL: `http://127.0.0.1:${server.address().port}`, requests, key, close: () => server.close() };
}
