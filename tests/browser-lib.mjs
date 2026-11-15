import fs from "node:fs";
import { chromium, devices } from "playwright";
import { serve } from "./serve.mjs";

export const SHOTS = process.env.SHOTS || "/tmp/claude-0/-home-user/695b14cd-41e5-5f7d-9343-86edcfeb245d/scratchpad/shots";

export async function launch({ scale = 1 } = {}) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const browser = await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined });
  const context = await browser.newContext({ ...devices["iPhone 14"], deviceScaleFactor: scale, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  const shot = name => page.screenshot({ path: `${SHOTS}/${name}.png` });
  const ready = () => page.waitForSelector('#vm-pill[data-state="ready"]', { timeout: 300000 });
  // Test-only: let the guest trust the build sandbox's TLS-intercepting proxy.
  const trustSandboxCa = async () => {
    const file = "/root/.ccr/agent-proxy-ca.crt";
    if (!fs.existsSync(file)) return;
    const b64 = fs.readFileSync(file).toString("base64");
    await page.evaluate(async b64 => {
      await window.dock.state.vm.machine.agent.capture(`
echo ${b64} | base64 -d > /usr/local/share/sandbox-ca.crt
grep -q sandbox /etc/profile.d/dock.sh && exit 0
cat /usr/local/share/sandbox-ca.crt >> /etc/ssl/certs/ca-certificates.crt
cat >> /etc/profile.d/dock.sh <<'EOT'
export PIP_CERT=/etc/ssl/certs/ca-certificates.crt NODE_EXTRA_CA_CERTS=/usr/local/share/sandbox-ca.crt SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt # sandbox
EOT`);
    }, b64);
  };
  return { server, browser, context, page, errors, shot, ready, trustSandboxCa, close: async () => { await browser.close(); server.close(); } };
}
