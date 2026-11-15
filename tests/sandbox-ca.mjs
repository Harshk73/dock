// Test-only: this build sandbox re-terminates outbound TLS with its own CA. Teach the
// guest to trust it so in-VM downloads can be exercised here. Never used by the app.
import fs from "node:fs";
export async function trustSandboxCa(vm) {
  const file = "/root/.ccr/agent-proxy-ca.crt";
  if (!fs.existsSync(file)) return false;
  const b64 = fs.readFileSync(file).toString("base64");
  const r = await vm.sh(`
echo ${b64} | base64 -d > /usr/local/share/sandbox-ca.crt
cat /usr/local/share/sandbox-ca.crt >> /etc/ssl/certs/ca-certificates.crt
cat >> /etc/profile.d/dock.sh <<'EOT'
export PIP_CERT=/etc/ssl/certs/ca-certificates.crt
export NODE_EXTRA_CA_CERTS=/usr/local/share/sandbox-ca.crt
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
EOT
`);
  return r.code === 0;
}
