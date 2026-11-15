// Runs an install plan (see planner.js) inside the VM, one step at a time.

const decoder = new TextDecoder();

function prelude(id) {
  return `set -e -o pipefail\nexport APP=/dock/apps/${id} SRC=/dock/apps/${id}/src\nmkdir -p "$APP"\ncd "$APP"\n`;
}

const LIST_COMMANDS = "ls -1 /dock/bin /dock/npm/bin 2>/dev/null | grep -v ':$' | sort -u";

async function listCommands(agent) {
  const { text } = await agent.capture(LIST_COMMANDS);
  return new Set(text.split("\n").map(s => s.trim()).filter(Boolean));
}

export class InstallCancelled extends Error {}

/**
 * @param {object} o
 * @param {import("./agent.js").GuestAgent} o.agent
 * @param {object} o.plan
 * @param {(event: object) => void} o.onEvent
 *   {type:"steps", steps, method} | {type:"step", index, state} | {type:"output", bytes}
 * @param {{cancelled: boolean, session: object|null}} o.control set control.cancelled to stop
 * @returns {Promise<{bins: string[], method: string}>}
 */
export async function runInstall({ agent, plan, onEvent, control, size }) {
  const before = await listCommands(agent);
  const note = text => onEvent({ type: "output", bytes: new TextEncoder().encode(`\r\n\x1b[38;5;141m${text}\x1b[0m\r\n`) });

  const runSteps = async (steps, method) => {
    onEvent({ type: "steps", steps, method });
    for (let i = 0; i < steps.length; i++) {
      if (control.cancelled) throw new InstallCancelled();
      onEvent({ type: "step", index: i, state: "running" });
      note(`▸ ${steps[i].title}`);
      const session = agent.open({ script: prelude(plan.id) + steps[i].cmd, rows: size.rows, cols: size.cols });
      control.session = session;
      session.onData = bytes => onEvent({ type: "output", bytes });
      const code = await session.exited;
      control.session = null;
      if (control.cancelled) throw new InstallCancelled();
      if (code !== 0) {
        onEvent({ type: "step", index: i, state: "failed" });
        const err = new Error(`"${steps[i].title}" failed (exit code ${code}).`);
        err.step = i;
        throw err;
      }
      onEvent({ type: "step", index: i, state: "done" });
    }
  };

  let method = plan.method;
  try {
    await runSteps(plan.steps, plan.method);
  } catch (err) {
    if (err instanceof InstallCancelled || !plan.fallback) throw err;
    note(`That didn't work (${err.message}) Trying another way: ${plan.fallback.method}.`);
    await agent.capture(prelude(plan.id) + `rm -rf "$APP/src" "$APP/venv"`);
    method = plan.fallback.method;
    await runSteps(plan.fallback.steps, method);
  }

  const after = await listCommands(agent);
  const bins = [...after].filter(name => !before.has(name));
  if (plan.discover) {
    const { text } = await agent.capture(plan.discover);
    for (const name of text.split("\n").map(s => s.trim()).filter(Boolean)) {
      if (!bins.includes(name)) bins.push(name);
    }
  }
  for (const name of plan.bins) {
    if (after.has(name) && !bins.includes(name)) bins.push(name);
  }
  return { bins, method };
}

/** Removes an installed app's files and commands. */
export async function runUninstall(agent, app) {
  // Links that point into the app's directory (commands, skills) go with it.
  const script = `export APP=/dock/apps/${app.id} SRC=/dock/apps/${app.id}/src\n${app.uninstall || "true"}\n` +
    `for l in /dock/bin/* /dock/skills/* /root/.claude/skills/*; do\n` +
    `  [ -L "$l" ] && case "$(readlink "$l")" in "$APP"/*) rm -f "$l";; esac\ndone\nrm -rf "$APP"\n`;
  const { code, text } = await agent.capture(script);
  return { code, text };
}

/** Saves the app record next to its files, so a restored disk can rebuild the dock. */
export async function writeAppRecord(agent, app) {
  const json = JSON.stringify(app).replace(/'/g, "'\\''");
  await agent.capture(`mkdir -p /dock/apps/${app.id} && printf '%s' '${json}' > /dock/apps/${app.id}/dock.json`);
}

export async function readAppRecords(agent) {
  const { text } = await agent.capture(`for f in /dock/apps/*/dock.json; do [ -f "$f" ] && { cat "$f"; echo; }; done; true`);
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* skip damaged record */ }
  }
  return records;
}

export function bytesToText(bytes) {
  return decoder.decode(bytes);
}
