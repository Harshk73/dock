// Offline unit tests: link parsing and install planning. Run with: node --test tests/unit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseRepoUrl, pythonProjectName } from "../web/js/github.js";
import { buildPlan, readmeCommands } from "../web/js/planner.js";
import { ChunkDisk, MemoryOverlay } from "../web/js/disk.js";

const facts = (files, extra = {}) => ({ owner: "acme", repo: "tool", ref: null, url: "https://github.com/acme/tool", files, meta: null, tree: null, npm: null, pypi: null, ...extra });

test("parseRepoUrl accepts the forms people paste", () => {
  const same = { owner: "yt-dlp", repo: "yt-dlp", ref: null };
  for (const input of ["https://github.com/yt-dlp/yt-dlp", "github.com/yt-dlp/yt-dlp", "yt-dlp/yt-dlp", "https://www.github.com/yt-dlp/yt-dlp.git",
    "git@github.com:yt-dlp/yt-dlp.git", "  https://github.com/yt-dlp/yt-dlp?tab=readme-ov-file#install ", "https://github.com/yt-dlp/yt-dlp/issues/12"]) {
    assert.deepEqual(parseRepoUrl(input), same, input);
  }
  assert.deepEqual(parseRepoUrl("https://github.com/acme/tool/tree/dev/src"), { owner: "acme", repo: "tool", ref: "dev" });
  for (const bad of ["", "hello", "https://gitlab.com/a/b", "https://github.com/onlyowner", "a b/c"]) assert.equal(parseRepoUrl(bad), null, bad);
});

test("python project published on PyPI installs the release, with a source fallback", () => {
  const plan = buildPlan(facts({
    "pyproject.toml": '[project]\nname = "acme-tool"\ndescription = "Does things"\ndependencies = [\n  "requests>=2",\n  "pydantic",\n]\n\n[project.scripts]\nacme = "acme.cli:main"\n',
    "README.md": "# Tool\n```bash\npip install acme-tool\n```\n",
  }, { pypi: { name: "acme-tool", version: "1.0", requires: [], matchesRepo: true } }));
  assert.equal(plan.runtime, "python");
  assert.equal(plan.method, "PyPI release");
  assert.equal(plan.launch, "acme");
  assert.equal(plan.description, "Does things");
  assert.ok(plan.steps.some(s => /install .*'acme-tool'/.test(s.cmd)));
  assert.ok(plan.steps[0].cmd.includes("py3-pydantic"), "prebuilt native libraries come from Alpine");
  assert.equal(plan.fallback.method, "Source build");
  assert.ok(plan.fallback.steps[0].cmd.includes("git clone --depth 1 https://github.com/acme/tool.git"));
});

test("python app without packaging runs from source and detects its web framework", () => {
  const plan = buildPlan(facts({ "requirements.txt": "flask==3.0\n# comment\n-r other.txt\n", "app.py": "", "README.md": "Run it:\n```\npython app.py\n```\nthen open http://localhost:5001\n" }));
  assert.equal(plan.kind, "web");
  assert.equal(plan.port, 5001);
  assert.equal(plan.launchLabel, "python app.py");
  assert.ok(plan.steps.some(s => s.cmd.includes('-r "$SRC/requirements.txt"')));
});

test("heavy ML and desktop GUI projects are flagged", () => {
  const ml = buildPlan(facts({ "requirements.txt": "torch\ntransformers\n" }));
  assert.ok(ml.warnings.some(w => w.level === "block" && /torch/.test(w.text)));
  const gui = buildPlan(facts({ "package.json": JSON.stringify({ name: "app", devDependencies: { electron: "30" }, scripts: { start: "electron ." } }) }));
  assert.ok(gui.warnings.some(w => w.level === "block" && /electron/.test(w.text)));
});

test("node CLI published on npm installs globally; unpublished builds from source", () => {
  const pkg = JSON.stringify({ name: "@acme/tool", bin: { tool: "cli.js" }, dependencies: { "@modelcontextprotocol/sdk": "1" } });
  const published = buildPlan(facts({ "package.json": pkg }, { npm: { name: "@acme/tool", bin: { tool: "cli.js" }, matchesRepo: true } }));
  assert.equal(published.method, "npm release");
  assert.match(published.steps[0].cmd, /npm install -g .*'@acme\/tool'/);
  assert.equal(published.launch, "tool");
  assert.equal(published.kind, "mcp");
  const local = buildPlan(facts({ "package.json": JSON.stringify({ name: "srv", scripts: { start: "node server.js", build: "tsc" }, dependencies: { express: "4" } }) }));
  assert.equal(local.method, "Source build");
  assert.equal(local.kind, "web");
  assert.equal(local.port, 3000);
  assert.deepEqual(local.steps.map(s => s.title), ["Download the source", "Install its Node.js packages", "Build it"]);
  assert.match(local.launch, /HOST=0\.0\.0\.0 PORT=3000 npm start/);
});

test("skills, compiled and unknown repositories", () => {
  const skill = buildPlan(facts({ "SKILL.md": "---\nname: x\n---" }));
  assert.equal(skill.kind, "skill");
  assert.ok(skill.steps[1].cmd.includes("/root/.claude/skills"));
  const nested = buildPlan(facts({ "README.md": "x" }, { tree: ["skills/pdf/SKILL.md"] }));
  assert.equal(nested.kind, "skill");
  const rust = buildPlan(facts({ "Cargo.toml": "[package]" }));
  assert.equal(rust.method, "Alpine package");
  assert.match(rust.steps[0].cmd, /apk add --no-cache 'tool'/);
  assert.match(rust.fallback.steps[1].cmd, /cargo install/);
  const docker = buildPlan(facts({ Dockerfile: "FROM x", "README.md": "```\ndocker compose up\n```" }));
  assert.ok(docker.warnings.some(w => w.level === "block" && /Docker/.test(w.text)));
  assert.equal(docker.kind, "source");
});

test("shell quoting keeps odd names from breaking out of commands", () => {
  const plan = buildPlan(facts({ "package.json": JSON.stringify({ name: "x'; rm -rf /; '", bin: "a.js" }) }, { npm: { name: "x", bin: {}, matchesRepo: true } }));
  assert.ok(plan.steps[0].cmd.includes(`'x'\\''; rm -rf /; '\\'''`));
});

test("readme command extraction and project names", () => {
  assert.deepEqual(readmeCommands("```sh\n$ pip install x\n# note\nnpm i -g y\n```\n```python\nimport x\n```\nuse `uvx thing --help` now"), ["pip install x", "npm i -g y", "uvx thing --help"]);
  assert.equal(pythonProjectName({ "setup.py": "setup(\n  name='my-pkg',\n)" }), "my-pkg");
  assert.equal(pythonProjectName({ "pyproject.toml": "[tool.poetry]\nname = \"poet\"\n" }), "poet");
});

test("ChunkDisk: copy-on-write, partial writes, atomic flush, reload", async () => {
  const CS = 1024;
  const base = i => { const c = new Uint8Array(CS); c.fill(i + 1); return c; };
  const overlay = new MemoryOverlay();
  const make = () => new ChunkDisk({ size: 8 * CS, chunkSize: CS, basePresent: [0, 1, 2], loadBase: async i => base(i), overlay, maxCleanChunks: 2 });
  const load = d => new Promise(r => { d.onload = r; d.load(); });
  let disk = make();
  await load(disk);
  assert.deepEqual([...await disk.read(CS - 2, 4)], [1, 1, 2, 2], "read across a chunk boundary");
  assert.deepEqual([...await disk.read(5 * CS, 3)], [0, 0, 0], "holes read as zeros");
  await disk.write(CS - 1, new Uint8Array([9, 9]));        // partial, spans chunks 0 and 1
  await disk.write(6 * CS, new Uint8Array(CS).fill(7));    // whole chunk, never loaded
  assert.equal(disk.dirtyCount, 3);
  assert.equal(overlay.map.size, 0, "nothing is stored before flush");
  assert.deepEqual((await disk.flush()).sort(), [0, 1, 6]);
  assert.equal(disk.dirtyCount, 0);
  for (let i = 0; i < 6; i++) await disk.read(i * CS, 1);  // churn the cache
  assert.deepEqual([...await disk.read(CS - 2, 4)], [1, 9, 9, 2]);
  disk = make();                                           // "reload the page"
  await load(disk);
  assert.deepEqual([...await disk.read(CS - 2, 4)], [1, 9, 9, 2]);
  assert.equal((await disk.read(6 * CS, CS)).every(b => b === 7), true);
  assert.equal(disk.stats.overlayLoads > 0, true);
  // a write that lands while a flush is in flight stays dirty
  const slow = { ...overlay, keys: () => overlay.keys(), get: i => overlay.get(i), putMany: e => new Promise(r => setTimeout(() => r(overlay.putMany(e)), 20)) };
  disk.overlay = slow;
  await disk.write(0, new Uint8Array([5]));
  const flushing = disk.flush();
  await disk.write(0, new Uint8Array([6]));
  await flushing;
  assert.equal(disk.dirtyCount, 1);
  await disk.flush();
  assert.equal((await overlay.get(0))[0], 6);
});
