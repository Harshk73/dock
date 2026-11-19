// Start-up must fail with a clear error, not wait forever, when the disk download hangs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { startVm } from "./node-vm.mjs";
const DISK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "vm", "disk");
let served = 0;
const t0 = Date.now();
try {
  await startVm({
    stallMs: 15000,
    // The first few chunks arrive, then the "network" goes silent.
    loadBase: i => (++served > 6 ? new Promise(() => {}) : Promise.resolve(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(DISK, `${i}.gz`)))))),
  });
  assert.fail("start-up should not have succeeded");
} catch (err) {
  console.log(`failed after ${Math.round((Date.now() - t0) / 1000)}s: [${err.code}] ${err.message} (stage ${err.stage})`);
  assert.equal(err.code, "download");
}
console.log("ALL OK");
process.exit(0);
