// Copies the third-party runtime files the web app needs into web/vendor.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "web", "vendor");
fs.mkdirSync(out, { recursive: true });
const nm = (...p) => path.join(root, "node_modules", ...p);

const v86 = fs.readFileSync(nm("v86", "build", "libv86.mjs"), "utf8");
fs.writeFileSync(path.join(out, "libv86.mjs"), v86);

const copies = [
  [nm("v86", "build", "v86.wasm"), "v86.wasm"],
  [nm("v86", "LICENSE"), "v86.LICENSE.txt"],
  [nm("@xterm", "xterm", "lib", "xterm.mjs"), "xterm.mjs"],
  [nm("@xterm", "xterm", "css", "xterm.css"), "xterm.css"],
  [nm("@xterm", "xterm", "LICENSE"), "xterm.LICENSE.txt"],
  [nm("@xterm", "addon-fit", "lib", "addon-fit.mjs"), "addon-fit.mjs"],
];
for (const [from, to] of copies) fs.copyFileSync(from, path.join(out, to));
// The Anthropic SDK ships as many small modules; the app has no bundler, so pack it into one.
await build({
  entryPoints: [nm("@anthropic-ai", "sdk", "index.mjs")],
  bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "none",
  outfile: path.join(out, "anthropic.mjs"),
});
fs.copyFileSync(nm("@anthropic-ai", "sdk", "LICENSE"), path.join(out, "anthropic.LICENSE.txt"));
console.log("vendored:", fs.readdirSync(out).join(", "));
