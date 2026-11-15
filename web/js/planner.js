// Turns facts about a repository (see github.js) into an install plan for the Dock VM.
// Pure functions: no network, no DOM.
//
// Step commands run in bash inside the VM with:
//   $APP  the app's directory  (/dock/apps/<id>)
//   $SRC  the source checkout  ($APP/src)

import { pythonProjectName } from "./github.js";

// Python packages that must be compiled on 32-bit Alpine if pip installs them, which
// is far too slow in the emulator. Alpine ships them prebuilt, so pull those instead.
const APK_PYTHON = {
  numpy: "py3-numpy", pandas: "py3-pandas", scipy: "py3-scipy", pillow: "py3-pillow",
  cryptography: "py3-cryptography", lxml: "py3-lxml", pyyaml: "py3-yaml", psutil: "py3-psutil",
  cffi: "py3-cffi", matplotlib: "py3-matplotlib", aiohttp: "py3-aiohttp", pydantic: "py3-pydantic",
  "pydantic-core": "py3-pydantic-core", orjson: "py3-orjson", grpcio: "py3-grpcio", regex: "py3-regex",
  msgpack: "py3-msgpack", greenlet: "py3-greenlet", sqlalchemy: "py3-sqlalchemy", bcrypt: "py3-bcrypt",
  pynacl: "py3-pynacl", multidict: "py3-multidict", yarl: "py3-yarl", frozenlist: "py3-frozenlist",
  markupsafe: "py3-markupsafe", "rpds-py": "py3-rpds-py", jiter: "py3-jiter", httptools: "py3-httptools",
  uvloop: "py3-uvloop", websockets: "py3-websockets", zstandard: "py3-zstandard", brotli: "py3-brotli",
  pycryptodome: "py3-pycryptodome", pycryptodomex: "py3-pycryptodomex", pyzmq: "py3-pyzmq",
  tornado: "py3-tornado", ujson: "py3-ujson", "ruamel-yaml": "py3-ruamel.yaml", wrapt: "py3-wrapt",
  curl_cffi: "py3-curl-cffi", "charset-normalizer": "py3-charset-normalizer",
};
// Packages whose own dependencies include compiled ones from the table above.
const IMPLIES = {
  openai: ["pydantic", "pydantic-core", "jiter"], anthropic: ["pydantic", "pydantic-core", "jiter"],
  fastapi: ["pydantic", "pydantic-core"], mcp: ["pydantic", "pydantic-core", "rpds-py"],
  fastmcp: ["pydantic", "pydantic-core", "rpds-py", "cryptography"], "pydantic-settings": ["pydantic", "pydantic-core"],
  langchain: ["pydantic", "pydantic-core", "sqlalchemy", "aiohttp", "pyyaml", "numpy"],
  "langchain-core": ["pydantic", "pydantic-core", "pyyaml"], litellm: ["pydantic", "pydantic-core", "aiohttp", "jiter"],
  uvicorn: ["httptools", "uvloop", "websockets", "pyyaml"], jsonschema: ["rpds-py"], requests: ["charset-normalizer"],
  httpx: [], typer: [], streamlit: ["numpy", "pandas", "pillow", "tornado"], gradio: ["numpy", "pandas", "pillow", "pydantic", "pydantic-core", "orjson", "pyyaml"],
  "google-genai": ["pydantic", "pydantic-core", "websockets"], instructor: ["pydantic", "pydantic-core", "jiter", "aiohttp"],
  paramiko: ["cryptography", "bcrypt", "pynacl"], aiohttp: ["multidict", "yarl", "frozenlist"],
};
const HEAVY_PYTHON = ["torch", "tensorflow", "jax", "opencv-python", "transformers", "onnxruntime", "diffusers",
  "llama-cpp-python", "faiss-cpu", "faiss-gpu", "numba", "cupy", "xformers", "torchvision", "torchaudio", "sentence-transformers"];
const GUI_PYTHON = ["pyqt5", "pyqt6", "pyside2", "pyside6", "pygame", "kivy", "wxpython", "customtkinter", "pyautogui"];
const PYTHON_WEB = { streamlit: 8501, gradio: 7860, flask: 5000, fastapi: 8000, uvicorn: 8000, django: 8000, dash: 8050, nicegui: 8080, chainlit: 8000, bottle: 8080, sanic: 8000 };
const NODE_WEB = { next: 3000, vite: 5173, express: 3000, fastify: 3000, koa: 3000, nuxt: 3000, hono: 3000, astro: 4321, "@sveltejs/kit": 5173, "react-scripts": 3000, "http-server": 8080, "socket.io": 3000 };
const GUI_NODE = ["electron", "@tauri-apps/api", "@tauri-apps/cli", "nw", "react-native", "expo"];
const NEEDS_WEBSOCKET = ["streamlit", "gradio", "chainlit", "nicegui", "socket.io", "vite", "next"];

const normalize = name => name.toLowerCase().replace(/[._]+/g, "-");
const q = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

function readme(facts) {
  const f = facts.files;
  return f["README.md"] || f["readme.md"] || f["README.rst"] || f["README"] || "";
}

/** Shell command lines found in the README's code blocks. */
export function readmeCommands(text) {
  const lines = [];
  const blocks = text.match(/```[^\n]*\n[\s\S]*?```/g) || [];
  for (const block of blocks) {
    const lang = block.match(/^```([^\n]*)/)[1].trim().toLowerCase();
    if (lang && !/^(bash|sh|shell|zsh|console|terminal|text|cmd|powershell)?$/.test(lang)) continue;
    for (let line of block.split("\n").slice(1, -1)) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue; // shell comment
      line = line.replace(/^[$>]\s+/, ""); // prompt marker
      if (line) lines.push(line);
    }
  }
  for (const m of text.matchAll(/`([^`\n]{6,120})`/g)) lines.push(m[1].trim());
  return lines;
}

function firstMatch(lines, re) {
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m;
  }
  return null;
}

/** Tiny TOML reader: enough for the tables and string arrays in pyproject.toml. */
function tomlTable(text, table) {
  const out = {};
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`^\\[${escaped}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"));
  if (!m) return out;
  const body = m[1];
  const re = /^\s*([A-Za-z0-9_."'-]+)\s*=\s*(\[[\s\S]*?\]|"[^"\n]*"|'[^'\n]*'|[^\n#]+)/gm;
  for (const entry of body.matchAll(re)) {
    const key = entry[1].replace(/^["']|["']$/g, "");
    let value = entry[2].trim();
    if (value.startsWith("[")) {
      value = [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map(s => s[1] ?? s[2]);
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }
    out[key] = value;
  }
  return out;
}

function requirementName(spec) {
  const m = String(spec).trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m ? normalize(m[1]) : null;
}

function pythonDependencies(facts) {
  const names = new Set();
  const add = spec => { const n = requirementName(spec); if (n) names.add(n); };
  const req = facts.files["requirements.txt"];
  if (req) {
    for (const line of req.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#") && !t.startsWith("-")) add(t);
    }
  }
  const py = facts.files["pyproject.toml"];
  if (py) {
    const project = tomlTable(py, "project");
    if (Array.isArray(project.dependencies)) project.dependencies.forEach(add);
    Object.keys(tomlTable(py, "tool.poetry.dependencies")).forEach(k => { if (k !== "python") add(k); });
  }
  const setup = facts.files["setup.py"];
  if (setup) {
    const m = setup.match(/install_requires\s*=\s*\[([\s\S]*?)\]/);
    if (m) [...m[1].matchAll(/["']([^"']+)["']/g)].forEach(s => add(s[1]));
  }
  if (facts.pypi) facts.pypi.requires.filter(r => !/;\s*.*extra\s*==/.test(r)).forEach(add);
  return names;
}

function apkForPython(deps) {
  const wanted = new Set();
  const consider = name => { if (APK_PYTHON[name]) wanted.add(APK_PYTHON[name]); };
  for (const dep of deps) {
    consider(dep);
    (IMPLIES[dep] || []).forEach(consider);
  }
  return [...wanted].sort();
}

function cloneStep(facts) {
  const branch = facts.ref ? ` --branch ${q(facts.ref)}` : "";
  return {
    title: "Download the source",
    cmd: `rm -rf "$SRC" && git clone --depth 1${branch} https://github.com/${facts.owner}/${facts.repo}.git "$SRC"`,
  };
}

const VENV_STEP = {
  title: "Create a Python environment",
  cmd: `python3 -m venv --without-pip --system-site-packages "$APP/venv"`,
};
// --no-compile: byte-compiling every module up front is slow here; Python does it on first use.
const PIP = `pip --python "$APP/venv/bin/python" install --no-compile --no-warn-script-location`;
const LINK_VENV_STEP = {
  title: "Add its commands to Dock",
  // Scripts pip installed are regular files; the interpreter aliases are symlinks.
  cmd: `for f in "$APP"/venv/bin/*; do n=$(basename "$f"); case "$n" in [Aa]ctivate*|pip*) continue;; esac; [ -f "$f" ] && [ ! -L "$f" ] && [ -x "$f" ] && ln -sf "$f" "/dock/bin/$n"; done; true`,
};

function apkStep(packages) {
  return {
    title: "Install prebuilt libraries",
    // Individually, so one package Alpine doesn't carry cannot fail the rest.
    cmd: `for p in ${packages.join(" ")}; do apk add --no-cache "$p" || echo "(no prebuilt $p; pip will handle it)"; done`,
  };
}

function planPython(facts, plan, cmds) {
  const files = facts.files;
  const deps = pythonDependencies(facts);
  const declared = pythonProjectName(files);
  const project = files["pyproject.toml"] ? tomlTable(files["pyproject.toml"], "project") : {};
  const scripts = files["pyproject.toml"]
    ? { ...tomlTable(files["pyproject.toml"], "project.scripts"), ...tomlTable(files["pyproject.toml"], "tool.poetry.scripts") }
    : {};
  const packaged = !!(files["pyproject.toml"] && (declared || /\[build-system\]/.test(files["pyproject.toml"]))) || !!files["setup.py"] || !!files["setup.cfg"];
  plan.runtime = "python";
  plan.name = declared || facts.repo;
  if (project.description && !plan.description) plan.description = project.description;

  const heavy = [...deps].filter(d => HEAVY_PYTHON.includes(d));
  const gui = [...deps].filter(d => GUI_PYTHON.includes(d));
  if (heavy.length) plan.warnings.push({ level: "block", text: `Needs ${heavy.join(", ")}: large machine-learning libraries that have no build for this environment. It is very unlikely to install.` });
  if (gui.length) plan.warnings.push({ level: "block", text: `Uses a desktop window toolkit (${gui.join(", ")}), which can't display here.` });

  const apk = apkForPython(deps);
  const pre = apk.length ? [apkStep(apk)] : [];

  // Published on PyPI under this repo's name: install the release.
  const mention = firstMatch(cmds, /\b(?:pip3?|python3? -m pip|pipx|uv tool|uv pip) install\s+(?:-U\s+|--upgrade\s+|--user\s+)*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/)
    || firstMatch(cmds, /\b(?:uvx|pipx run)\s+([A-Za-z0-9][A-Za-z0-9._-]*)/);
  const pypiName = facts.pypi && facts.pypi.matchesRepo ? facts.pypi.name
    : mention && declared && normalize(mention[1]) === normalize(declared) ? declared
      : mention && normalize(mention[1]) === normalize(facts.repo) ? mention[1] : null;

  const fromSource = [cloneStep(facts), ...pre, VENV_STEP];
  if (files["requirements.txt"]) fromSource.push({ title: "Install its Python requirements", cmd: `${PIP} -r "$SRC/requirements.txt"` });
  if (packaged) fromSource.push({ title: `Install ${plan.name}`, cmd: `${PIP} "$SRC"` });
  fromSource.push(LINK_VENV_STEP);

  if (pypiName) {
    plan.method = "PyPI release";
    plan.steps = [...pre, VENV_STEP, { title: `Install ${pypiName} from PyPI`, cmd: `${PIP} ${q(pypiName)}` }, LINK_VENV_STEP];
    plan.fallback = { method: "Source build", steps: fromSource };
  } else {
    plan.method = packaged ? "Source build" : "Python app";
    plan.steps = fromSource;
  }

  // How to start it.
  const scriptNames = Object.keys(scripts);
  const web = Object.keys(PYTHON_WEB).find(f => deps.has(f));
  const runLine = firstMatch(cmds, /^(streamlit run \S+|uvicorn \S+(?: --\S+ \S+)*|flask (?:--app \S+ )?run\b.*|gunicorn \S+|python3? manage\.py runserver\b.*|chainlit run \S+|python3? -m [\w.]+.*|python3? [\w./-]+\.py\b.*)$/);
  if (scriptNames.length) {
    plan.bins = scriptNames;
    plan.launch = scriptNames.find(n => normalize(n) === normalize(plan.name)) || scriptNames[0];
  } else if (!packaged || web) {
    const entry = ["main.py", "app.py"].find(f => files[f]);
    let run = runLine ? runLine[1].replace(/^python3?\b/, "python") : null;
    if (run && /^streamlit run/.test(run) && !/headless/.test(run)) run += " --server.headless true";
    if (!run && web === "streamlit") run = `streamlit run "$(grep -ls streamlit *.py | head -1)" --server.headless true`;
    if (!run && files["manage.py"]) run = "python manage.py runserver";
    if (!run && entry) run = `python ${entry}`;
    if (run && !pypiName) {
      plan.launch = `cd "$SRC" && PATH="$APP/venv/bin:$PATH" ${run}`;
      plan.launchLabel = run;
    }
  }
  if (web) {
    plan.kind = "web";
    plan.port = portFromReadme(readme(facts)) || PYTHON_WEB[web];
    plan.badges.push(web[0].toUpperCase() + web.slice(1));
    if (NEEDS_WEBSOCKET.includes(web)) plan.warnings.push({ level: "warn", text: `${web} pages rely on WebSockets, which Dock's preview can't carry yet, so the page may load but stay blank.` });
  }
  if (deps.has("mcp") || deps.has("fastmcp") || /\bmcp\b/i.test(plan.name)) {
    plan.badges.push("MCP server");
    if (plan.kind === "cli") plan.kind = "mcp";
  }
}

function portFromReadme(text) {
  const m = text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})/);
  return m ? Number(m[1]) : null;
}

// npm itself runs noticeably faster in the emulator with V8's interpreter only.
const NPM = "NODE_OPTIONS=--jitless npm";

function planNode(facts, plan, cmds) {
  let pkg;
  try {
    pkg = JSON.parse(facts.files["package.json"]);
  } catch {
    plan.warnings.push({ level: "warn", text: "package.json could not be read." });
    pkg = {};
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const bins = typeof pkg.bin === "string" ? [String(pkg.name || facts.repo).replace(/^@[^/]+\//, "")]
    : pkg.bin ? Object.keys(pkg.bin) : [];
  plan.runtime = "node";
  plan.name = String(pkg.name || facts.repo).replace(/^@[^/]+\//, "");
  if (pkg.description && !plan.description) plan.description = pkg.description;
  plan.bins = bins;

  const gui = GUI_NODE.filter(d => deps[d]);
  if (gui.length) plan.warnings.push({ level: "block", text: `This is a desktop or mobile app (${gui.join(", ")}), which can't display here.` });
  if (pkg.workspaces) plan.warnings.push({ level: "warn", text: "This repository holds several packages; Dock installs the top-level one only." });

  const source = [cloneStep(facts), { title: "Install its Node.js packages", cmd: `cd "$SRC" && ${NPM} install --no-audit --no-fund${scripts.build ? "" : " --omit=dev"}` }];
  if (scripts.build) source.push({ title: "Build it", cmd: `cd "$SRC" && npm run build` });
  if (bins.length) source.push({ title: "Add its commands to Dock", cmd: `cd "$SRC" && ${NPM} link --no-audit --no-fund` });

  const published = facts.npm && facts.npm.matchesRepo && facts.npm.bin;
  const mention = pkg.name && firstMatch(cmds, new RegExp(`\\b(?:npm (?:install|i|add) (?:-g|--global)|npx(?: -y)?|pnpm (?:add -g|dlx)|yarn global add|bunx)\\s+${pkg.name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:@\\S+)?\\b`));
  if (!pkg.private && bins.length && (published || (facts.npm && mention))) {
    plan.method = "npm release";
    plan.steps = [{ title: `Install ${pkg.name} from npm`, cmd: `${NPM} install -g --no-audit --no-fund ${q(pkg.name)}` }];
    plan.fallback = { method: "Source build", steps: source };
    plan.uninstall = `npm uninstall -g ${q(pkg.name)}`;
  } else {
    plan.method = "Source build";
    plan.steps = source;
    plan.uninstall = bins.length ? `npm uninstall -g ${q(pkg.name || facts.repo)}` : "true";
  }

  const web = Object.keys(NODE_WEB).find(f => deps[f]);
  if (bins.length) {
    plan.launch = bins.find(b => b === plan.name) || bins[0];
  } else if (scripts.start || scripts.dev || pkg.main) {
    const run = scripts.start ? "npm start" : scripts.dev ? "npm run dev" : `node ${pkg.main}`;
    plan.launch = `cd "$SRC" && ${run}`;
    plan.launchLabel = run;
  }
  if (web && !bins.length) {
    plan.kind = "web";
    plan.port = portFromReadme(readme(facts)) || NODE_WEB[web];
    plan.badges.push(web.replace(/^@.*\//, ""));
    if (plan.launch) plan.launch = plan.launch.replace("&& ", `&& HOST=0.0.0.0 PORT=${plan.port} `);
    if (NEEDS_WEBSOCKET.includes(web)) plan.warnings.push({ level: "warn", text: `${web} dev servers use WebSockets for live reload, which Dock's preview can't carry yet. Pages still load.` });
  }
  if (deps["@modelcontextprotocol/sdk"] || /\bmcp\b/i.test(plan.name)) {
    plan.badges.push("MCP server");
    if (plan.kind === "cli") plan.kind = "mcp";
  }
}

function planCompiled(facts, plan, language) {
  const name = facts.repo.toLowerCase();
  plan.runtime = language;
  plan.name = facts.repo;
  plan.method = "Alpine package";
  // Popular Go and Rust tools are packaged by Alpine; compiling them in the emulator
  // would take a very long time, so try the prebuilt package first.
  plan.steps = [{ title: `Install the prebuilt ${name} package`, cmd: `apk add --no-cache ${q(name)}` }];
  plan.uninstall = `apk del ${q(name)} 2>/dev/null; true`;
  const build = language === "go"
    ? { title: "Compile it (slow)", cmd: `apk add --no-cache go && cd "$SRC" && GOBIN=/dock/bin GOFLAGS=-buildvcs=false go install ./...` }
    : { title: "Compile it (very slow)", cmd: `apk add --no-cache cargo && cargo install --path "$SRC" --root /dock --locked` };
  plan.fallback = { method: "Compile from source", steps: [cloneStep(facts), build] };
  // The package name is not always the command name (ripgrep installs "rg").
  plan.discover = `apk info -qL ${q(name)} 2>/dev/null | grep -E '^usr/(local/)?s?bin/' | xargs -rn1 basename`;
  plan.warnings.push({ level: "warn", text: `${language === "go" ? "Go" : "Rust"} projects must be compiled. Dock first looks for a ready-made Alpine package; if there isn't one, compiling on the phone can take a very long time.` });
}

function planSkill(facts, plan) {
  plan.runtime = "skill";
  plan.kind = "skill";
  plan.method = "Agent skills";
  plan.name = facts.repo;
  plan.badges.push("Agent skill");
  plan.steps = [
    cloneStep(facts),
    {
      title: "Register the skills",
      cmd: `mkdir -p /root/.claude/skills /dock/skills "$APP/skills"
find "$SRC" -name SKILL.md -not -path '*/node_modules/*' | while read -r f; do
  d=$(dirname "$f"); n=$(basename "$d"); [ "$d" = "$SRC" ] && n=${q(facts.repo)}
  ln -sfn "$d" "/root/.claude/skills/$n"; ln -sfn "$d" "/dock/skills/$n"; ln -sfn "$d" "$APP/skills/$n"
  echo "skill: $n"
done`,
    },
  ];
}

/**
 * @param {object} facts from fetchRepoFacts
 * @returns {object} plan
 */
export function buildPlan(facts) {
  const files = facts.files;
  const text = readme(facts);
  const cmds = readmeCommands(text);
  const id = `${facts.owner}--${facts.repo}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  const plan = {
    id, owner: facts.owner, repo: facts.repo, url: facts.url, ref: facts.ref,
    name: facts.repo,
    description: facts.meta ? facts.meta.description : "",
    stars: facts.meta ? facts.meta.stars : null,
    runtime: "unknown",
    kind: "cli", // cli | web | skill | mcp | source
    method: "",
    badges: [],
    steps: [],
    fallback: null,
    launch: null,
    launchLabel: null,
    port: null,
    bins: [],
    discover: null, // optional command that prints the names of the commands it installed
    uninstall: "true",
    warnings: [],
  };

  const tree = facts.tree || [];
  const hasSkills = !!files["SKILL.md"] || !!files[".claude-plugin/plugin.json"] || !!files[".claude-plugin/marketplace.json"]
    || tree.some(p => /(^|\/)SKILL\.md$/.test(p));
  const nodeBin = (() => { try { return !!JSON.parse(files["package.json"] || "{}").bin; } catch { return false; } })();
  const pythonPackaged = !!(files["pyproject.toml"] || files["setup.py"] || files["setup.cfg"]);
  const looksLikeSkillRepo = /\bskills?\b/i.test(facts.repo) || /agent skills?|claude (code )?skills?|SKILL\.md/i.test(text.slice(0, 4000));

  if (hasSkills && !nodeBin && !pythonPackaged) {
    planSkill(facts, plan);
  } else if (!files["package.json"] && !pythonPackaged && !files["requirements.txt"] && !files["go.mod"] && !files["Cargo.toml"] && looksLikeSkillRepo && !facts.tree) {
    // No file listing (GitHub API unavailable) but everything says "skills".
    planSkill(facts, plan);
  } else if (pythonPackaged || files["requirements.txt"]) {
    planPython(facts, plan, cmds);
  } else if (files["package.json"]) {
    planNode(facts, plan, cmds);
  } else if (files["go.mod"]) {
    planCompiled(facts, plan, "go");
  } else if (files["Cargo.toml"]) {
    planCompiled(facts, plan, "rust");
  } else {
    planFromReadme(facts, plan, cmds);
  }

  if (!plan.description) {
    const line = text.split("\n").map(l => l.trim()).find(l => l && !/^[#<>!\[=|-]/.test(l) && l.length > 20);
    if (line) plan.description = line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").slice(0, 160);
  }
  if ((files["Dockerfile"] || files["docker-compose.yml"]) && plan.runtime === "unknown") {
    plan.warnings.push({ level: "block", text: "This project is distributed as a Docker container. Containers can't run inside Dock." });
  }
  if (facts.meta && facts.meta.archived) plan.warnings.push({ level: "warn", text: "This repository is archived and no longer maintained." });
  return plan;
}

function planFromReadme(facts, plan, cmds) {
  const files = facts.files;
  plan.method = "README instructions";
  plan.steps = [cloneStep(facts)];
  const seen = new Set();
  const usable = cmds.filter(c => /^(pip3? install|python3? -m pip install|npm (install|i)\b|make\b|sh |bash |\.\/|chmod \+x)/.test(c) && !/sudo|brew |apt(-get)? |docker /.test(c));
  for (const cmd of usable.slice(0, 6)) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    plan.steps.push({ title: `Run: ${cmd.slice(0, 60)}`, cmd: `cd "$SRC" && ${cmd.replace(/^pip3? install/, "pip install --break-system-packages")}` });
  }
  if (plan.steps.length === 1 && files["install.sh"]) {
    plan.steps.push({ title: "Run its install script", cmd: `cd "$SRC" && sh ./install.sh` });
  }
  if (plan.steps.length === 1) {
    plan.kind = "source";
    plan.warnings.push({ level: "warn", text: "Dock couldn't find install instructions it understands. It will download the source so you can explore it in the terminal." });
  }
  plan.uninstall = "true";
}
