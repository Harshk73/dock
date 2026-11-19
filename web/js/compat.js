// Decides, before anything is installed, whether a repository can work on Dock: a small
// 32-bit x86 Alpine Linux, emulated on a phone, with about 256 MB of memory, no GPU,
// no Docker, no screen and no desktop browser.
//
// Rule-based: it reads the README and the project's own files (see github.js) and the
// install plan (see planner.js). No AI and no network.

/** Paid AI services: a tool built on one of these is no use without a paid account. */
const PAID_AI = {
  OPENAI: "OpenAI", ANTHROPIC: "Anthropic", CLAUDE: "Anthropic", GEMINI: "Google Gemini", GOOGLE_AI: "Google Gemini",
  GROQ: "Groq", MISTRAL: "Mistral", DEEPSEEK: "DeepSeek", OPENROUTER: "OpenRouter", COHERE: "Cohere", PERPLEXITY: "Perplexity",
  REPLICATE: "Replicate", ELEVENLABS: "ElevenLabs", XAI: "xAI", TOGETHER: "Together AI", FIREWORKS: "Fireworks AI", AZURE_OPENAI: "Azure OpenAI",
};
const OTHER_SERVICES = {
  TELEGRAM: "Telegram", DISCORD: "Discord", SLACK: "Slack", GITHUB: "GitHub", SPOTIFY: "Spotify", NOTION: "Notion",
  TWITTER: "X/Twitter", REDDIT: "Reddit", YOUTUBE: "YouTube", HF: "Hugging Face", HUGGINGFACE: "Hugging Face", AWS: "AWS",
};
const BROWSER_PYTHON = ["selenium", "playwright", "pyppeteer", "undetected-chromedriver", "browser-use", "crawl4ai", "nodriver", "splinter", "helium"];
const NATIVE_NODE = ["sharp", "canvas", "better-sqlite3", "sqlite3", "bcrypt", "node-pty", "@tensorflow/tfjs-node", "onnxruntime-node", "node-sass", "re2", "cpu-features", "usb", "serialport", "robotjs", "@nut-tree/nut-js", "keytar"];
const LOCAL_AI = ["llama-cpp-python", "ollama", "vllm", "ctransformers", "gpt4all", "exllamav2", "mlx", "mlx-lm", "whisper", "openai-whisper", "faster-whisper", "TTS", "coqui-tts", "bark", "audiocraft"];
const DOCK = { node: 24, python: [3, 14], memoryMB: 256 };

/** The README line containing a match, cleaned up for display. */
function quote(text, match) {
  if (!match) return null;
  const start = text.lastIndexOf("\n", match.index) + 1;
  const endAt = text.indexOf("\n", match.index);
  let line = text.slice(start, endAt < 0 ? undefined : endAt)
    .replace(/<[^>]+>/g, "").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`#>|]/g, "").replace(/\s+/g, " ").trim();
  if (line.length > 150) {
    const at = Math.max(0, line.toLowerCase().indexOf(match[0].toLowerCase().trim().slice(0, 20)) - 50);
    line = (at ? "…" : "") + line.slice(at, at + 140).trim() + "…";
  }
  return line || null;
}

function firstMatch(text, re) {
  re.lastIndex = 0;
  return re.exec(text);
}

function readmeOf(facts) {
  const f = facts.files || {};
  return f["README.md"] || f["readme.md"] || f["README.rst"] || f["README"] || "";
}

// Sections that describe other projects, not this one.
const OTHER_PROJECTS = /^#{1,4}\s*(?:community|integrations?|related|similar|alternatives|projects? (?:using|built)|built with|showcase|awesome|ecosystem|acknowledg|credits|thanks|sponsors?|backers|contributors?|see also|license)\b/im;

/** The README's own prose: no images, links, HTML, badges or third-party project lists. */
export function readmeProse(text) {
  const cut = text.search(OTHER_PROJECTS);
  return (cut > 0 ? text.slice(0, cut) : text).slice(0, 30000)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<img[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\.\. (?:image|figure)::.*$/gim, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

function installTime(plan) {
  if (plan.method === "Alpine package") return "installs in under a minute";
  if (plan.method === "PyPI release" || plan.method === "npm release") return "installs in about 1–3 minutes";
  if (plan.method === "Agent skills") return "installs in under a minute";
  return "installing can take several minutes";
}

/**
 * @param {object} facts from fetchRepoFacts
 * @param {object} plan from buildPlan
 * @param {{hasAiKey?: boolean}} [context]
 * @returns {{level: "good"|"maybe"|"no", headline: string, detail: string, reasons: Array<{level: string, text: string, quote?: string}>}}
 */
export function assessCompatibility(facts, plan, context = {}) {
  const text = readmeProse(readmeOf(facts));
  const files = facts.files || {};
  const tree = facts.tree || [];
  const signals = plan.signals || {};
  const pyDeps = new Set(signals.pythonDeps || []);
  const nodeDeps = new Set(signals.nodeDeps || []);
  const language = facts.meta ? facts.meta.language : "";
  const reasons = [];
  const seen = new Set();
  const add = (level, text, q = null) => {
    if (seen.has(text)) return;
    seen.add(text);
    reasons.push(q ? { level, text, quote: q } : { level, text });
  };

  // ---- what the plan itself found
  for (const w of plan.warnings || []) add(w.level === "block" ? "block" : w.level === "info" ? "info" : "warn", w.text);

  // ---- how it would be installed
  if (plan.method === "Alpine package" && plan.alpine) {
    add("good", `Alpine Linux has a ready-made build (${plan.alpine.name} ${plan.alpine.version}), so nothing needs compiling.`);
  } else if (plan.method === "PyPI release") {
    add("good", "It's published on PyPI, so Dock can install the release with pip.");
  } else if (plan.method === "npm release") {
    add("good", "It's published on npm, so Dock can install the release.");
  } else if (plan.kind === "skill") {
    if (context.hasAiKey) add("info", "Skills are instructions for an AI. On Dock they work through Ask AI, which uses your Anthropic API key.");
    else add("warn", "Skills are instructions for an AI. On Dock they only do something through Ask AI, which needs an Anthropic API key, paid separately (Claude Pro doesn't cover it).");
  } else if (plan.method === "README instructions" && plan.steps.length > 1) {
    add("warn", "Dock would follow the README's own commands, which are written for a regular computer and may not work here.");
  } else if (plan.method === "Source build" || plan.method === "Python app") {
    add("good", `Dock installs it from its source code with ${plan.runtime === "node" ? "npm" : "pip"}.`);
  } else if (plan.kind === "source") {
    add("block", "Dock couldn't find any way to install or run it: it would only download the source code.");
  }

  // ---- things that need a different kind of computer
  if (plan.runtime === "rust" && plan.method !== "Alpine package") {
    add("block", "It's written in Rust and Alpine has no ready-made build. Compiling Rust inside Dock would take hours and usually runs out of memory.");
  }
  if (plan.runtime === "go" && plan.method !== "Alpine package") {
    add("warn", "It's written in Go and Alpine has no ready-made build, so Dock has to compile it: slow (often 10–30 minutes) and it may run out of memory.");
  }
  if (plan.runtime === "shell") {
    add("warn", "Dock will run its Makefile. That works for tools made of shell scripts; if it compiles C code, it will fail.");
  }
  if (plan.runtime === "native" && plan.method !== "Alpine package") {
    add("block", "It's a C/C++ program and Alpine has no ready-made build of it. Compiling it inside Dock isn't practical.");
  }

  const lang = (language || "").toLowerCase();
  if (files["Package.swift"] || lang === "swift" || lang === "objective-c" || tree.some(p => /\.xcodeproj\//.test(p))) {
    add("block", "It's an Apple app (Swift / Xcode). Those are built on a Mac with Xcode, not run in Linux.");
  } else if (files["pubspec.yaml"] || lang === "dart") {
    add("block", "It's a Flutter app. It has to be built into a phone app on a computer; it can't run in Dock.");
  } else if (/com\.android\.(application|library)/.test((files["build.gradle"] || "") + (files["build.gradle.kts"] || "")) || lang === "kotlin") {
    add("block", "It's an Android app (Kotlin/Gradle). It has to be built on a computer; it can't run in Dock.");
  } else if (lang === "c#" || lang === "f#" || lang === "visual basic .net" || tree.some(p => /\.(csproj|sln|fsproj)$/.test(p))) {
    add("block", "It's a .NET program, and .NET has no version for Dock's 32-bit Linux.");
  } else if (files["pom.xml"] || ((files["build.gradle"] || files["build.gradle.kts"]) && lang === "java")) {
    add("warn", "It's a Java program. Dock can install Java, but builds are slow and heavy for a phone.");
  }

  let m;
  if ((m = firstMatch(text, /\b(?:requires?|required|needs?|must have|you(?:'ll)? need)\b[^.\n]{0,60}\b(?:nvidia|cuda|gpu|vram)\b|\b(?:nvidia gpu|cuda|gpu)\b[^.\n]{0,40}\b(?:required|is needed|only)\b|\b\d+\s?gb\s+(?:of\s+)?vram\b/i))) {
    add("block", "The README says it needs a graphics card (GPU). Phones can't lend one to Dock.", quote(text, m));
  } else if ((m = firstMatch(text, /\b(?:cuda|nvidia)\b/i))) {
    add("info", "The README mentions NVIDIA/CUDA; probably an optional extra, but parts of it may need a graphics card.", quote(text, m));
  }
  const ram = /\b(\d+(?:\.\d+)?)\s?(?:gb|gib)\s+(?:of\s+)?(?:ram|memory|system memory)\b/gi;
  while ((m = ram.exec(text))) {
    if (Number(m[1]) >= 1) {
      add("block", `The README asks for ${m[1]} GB of memory. Dock's Linux has about ${DOCK.memoryMB} MB.`, quote(text, m));
      break;
    }
  }
  // "Windows-only app" or "only works on macOS", but not "Windows only includes a pager".
  if ((m = firstMatch(text, /\b(?:macos|mac os x?|os x|windows|android|ios)[ -]only\b(?=\s*(?:[.,;:!]|$|app|application|tool|program|software|version|release|for now))|\bonly (?:works|runs|available|supported) (?:on|for) (?:macos|mac|windows|android|ios)\b/im))) {
    add("block", "The README says it only works on one operating system that isn't Linux.", quote(text, m));
  }
  const published = ["PyPI release", "npm release", "Alpine package"].includes(plan.method);
  const otherInstall = /^\s*\$?\s*(?:pip3?|pipx|uv(?: tool| pip)?|npm|npx|pnpm|yarn|brew|apt(?:-get)?|cargo|go|gem|conda|snap|winget|scoop) (?:install|i|add|run|exec|dlx)?\b|^\s*\$?\s*npx\b/im.test(text);
  const dockerFiles = !!files["docker-compose.yml"] || tree.some(p => /(^|\/)(?:docker-)?compose\.ya?ml$/.test(p));
  if (!published && (m = firstMatch(text, /docker[ -]compose|docker compose|docker run|requires? \[?docker\b/i)) && !otherInstall) {
    add("block", "It's made to run as a Docker container, and containers can't run inside Dock.", quote(text, m));
  } else if (!published && (m = firstMatch(text, /\bself[- ]host(?:ed|ing|able)?\b/i))) {
    const topics = (facts.meta && facts.meta.topics) || [];
    if (dockerFiles || files["Dockerfile"] || topics.some(t => /self-?host/.test(t))) add("block", "It's a self-hosted server app, made to run in Docker on a home server or in the cloud, not on a phone.", quote(text, m));
    else add("warn", "It describes itself as self-hosted: usually a server app meant for a home server or the cloud, heavy for a phone.", quote(text, m));
  }
  if (!published && (files["pnpm-workspace.yaml"] || /"workspaces"\s*:/.test(files["package.json"] || ""))) {
    add("warn", "It's a large project made of several separate parts, more like a full application than a single tool.");
  }
  if (!published && (m = firstMatch(text, /\bdownload\b[^.\n]{0,40}\bfor (?:macos|mac|windows)(?: (?:or|and) (?:macos|mac|windows|linux))?\b|\bdesktop app\b[^.\n]{0,40}\b(?:macos|windows)\b/i))) {
    add("block", "It's mainly a desktop app for Mac or Windows.", quote(text, m));
  }
  if ((plan.kind === "source" || plan.method === "README instructions") && (m = firstMatch(text, /\.(?:dmg|exe|msi|appimage|apk)\b|\b(?:download|install) the (?:desktop )?app\b/i))) {
    add("block", "It looks like a desktop or phone app you download, not something that runs in Linux.", quote(text, m));
  }
  if (files["deno.json"] || files["deno.jsonc"] || (m = firstMatch(text, /^\s*\$?\s*deno (?:run|install|task)\b/im))) {
    if (!(plan.method === "npm release" || plan.method === "PyPI release")) add("block", "It runs on Deno, which has no version for Dock's 32-bit Linux.", m ? quote(text, m) : null);
  }
  if ((m = firstMatch(text, /^\s*\$?\s*bunx? (?:run|install|add|i)\b/im)) && !files["package.json"]) {
    add("block", "It runs on Bun, which has no version for Dock's 32-bit Linux.", quote(text, m));
  }

  if ((m = firstMatch(text, /\banything a browser can draw\b|\brender(?:s|ed|ing)?\b[^.\n]{0,30}\b(?:in|with|using|through|via) (?:a |the )?(?:headless |real |web )?(?:browser|chrome|chromium)\b|\bheadless (?:chrome|chromium|browser)\b|\bbrowser automation\b|\bautomat(?:e|es|ing|ion)\b[^.\n]{0,30}\b(?:web )?browsers?\b|\bcontrol(?:s|ling)? (?:a|the|your) (?:web |real )?browser\b|\bdrives? (?:a|the) (?:real |web )?browser\b|^\s*\$?\s*(?:npx |uvx |python -m )?playwright install\b/im))) {
    add("block", "It needs a real web browser (Chrome) to render or control pages, which Dock's Linux can't run.", quote(text, m));
  }
  // A model runner says so in its tagline; elsewhere it's often an optional extra.
  const localAi = /\b(?:open(?:-weight)? models?|llms?|large language models?)\b[^.\n]{0,60}\blocally\b|\b(?:run|running|get up and running with)\b[^.\n]{0,40}\b(?:llms?|large language models?|ai models?|language models?)\b(?:[^.\n]{0,30}\b(?:locally|on your (?:own )?(?:machine|computer|device|hardware)|offline))?|\bllama\.cpp\b[^.\n]{0,40}\b(?:inference|models?)\b/i;
  // The project's tagline (first lines) says it runs models locally, and doesn't present
  // itself as a client for hosted AI services.
  const tagline = text.replace(/^\s*#.*$/gm, "").trim().slice(0, 500);
  const runsModels = /\b(?:open(?:-weight)?|local|large language|language|ai|llm) models?\b/i.test(tagline) && /\blocally\b|\bon your (?:own )?(?:machine|computer|device|hardware)\b|\boffline\b/i.test(tagline) && !/\b(?:openai|anthropic|gemini|claude|gpt|api)\b/i.test(tagline);
  if ((runsModels && (m = firstMatch(text, /\blocally\b|\bon your (?:own )?(?:machine|computer|device|hardware)\b|\boffline\b/i))) || ((m = firstMatch(text, localAi)) && !/\b(?:api key|openai|anthropic)\b/i.test(text))) {
    add("block", "It runs AI language models on the device itself, which needs far more memory and speed than a phone's emulated Linux has.", quote(text, m));
  }
  if (/[-_](?:ios|android|macos|windows|desktop)$/i.test(facts.repo)) {
    add("block", `From its name, it's a ${facts.repo.split(/[-_]/).pop()} app, which can't run inside Linux.`);
  }

  if (!published && (m = firstMatch(readmeOf(facts), /curl\s+-[a-z]*\s+https?:\/\/\S+\s*\|\s*(?:ba)?sh\b/i)) && !otherInstall) {
    add("warn", "Its installer downloads a ready-made program built for regular 64-bit computers, which usually won't run on Dock's 32-bit Linux.", quote(readmeOf(facts), m));
  }

  // ---- dependencies
  const browserPy = [...pyDeps].filter(d => BROWSER_PYTHON.includes(d));
  if (browserPy.length) add("block", `It drives a real web browser (${browserPy.join(", ")}), and Dock's Linux can't run Chrome or Firefox.`);
  const nativeNode = [...nodeDeps].filter(d => NATIVE_NODE.includes(d));
  if (nativeNode.length) add("warn", `It uses Node modules that must be compiled for the device (${nativeNode.slice(0, 4).join(", ")}); that usually fails on Dock.`);
  const localAiDeps = [...pyDeps].filter(d => LOCAL_AI.includes(d));
  if (localAiDeps.length) add("block", `It runs AI models on the device itself (${localAiDeps.join(", ")}), which is far too heavy for a phone's emulated Linux.`);
  else if ((m = firstMatch(text, /\b(?:ollama|llama\.cpp|gguf|lm studio)\b/i)) && !/\b(?:openai|api key)\b/i.test(text.slice(0, 3000))) {
    add("warn", "The README mentions running AI models locally (Ollama, llama.cpp…), which is too heavy for Dock.", quote(text, m));
  }
  if (signals.nodeEngine && signals.nodeEngine > DOCK.node) {
    add("block", `It needs Node.js ${signals.nodeEngine} or newer; Dock has Node.js ${DOCK.node}.`);
  }
  if (signals.requiresPython) {
    const [maj, min] = signals.requiresPython;
    if (maj > DOCK.python[0] || (maj === DOCK.python[0] && min > DOCK.python[1])) add("block", `It needs Python ${maj}.${min} or newer; Dock has Python ${DOCK.python.join(".")}.`);
  }
  if ((m = firstMatch(text, /\b(?:requires?|needs?|running|install)\b[^.\n]{0,40}\b(?:postgres(?:ql)?|mysql|mariadb|mongodb|elasticsearch|redis)\b/i))) {
    add("warn", "It needs a database server running alongside it, which is heavy for a phone.", quote(text, m));
  }

  // ---- accounts and keys
  const keys = new Map();
  for (const k of text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)_(?:API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET_KEY|BOT_TOKEN|TOKEN|KEY)\b/g)) {
    const prefix = k[1];
    const service = PAID_AI[prefix] || PAID_AI[prefix.split("_")[0]] || OTHER_SERVICES[prefix] || OTHER_SERVICES[prefix.split("_")[0]];
    if (service && !keys.has(service)) keys.set(service, { paid: !!(PAID_AI[prefix] || PAID_AI[prefix.split("_")[0]]), name: k[0], match: k });
  }
  const paid = [...keys].filter(([, v]) => v.paid);
  const free = [...keys].filter(([, v]) => !v.paid);
  if (paid.length) {
    add("warn", `It uses ${paid.map(([s]) => s).join(" / ")} (${paid.map(([, v]) => v.name).join(", ")}), which needs your own account and is usually paid.`, quote(text, paid[0][1].match));
  }
  if (free.length) add("info", `It needs your own ${free.map(([s]) => s).join(" / ")} key or token (${free.map(([, v]) => v.name).join(", ")}).`);

  if (plan.kind === "mcp") add("warn", "It's an add-on server for AI assistants (MCP). Dock can install it, but nothing on Dock can use it yet.");
  if (facts.meta && facts.meta.sizeKb > 500000) add("warn", `The repository is large (${Math.round(facts.meta.sizeKb / 1000)} MB), which takes a long time to download on a phone.`);

  // ---- verdict
  const blocks = reasons.filter(r => r.level === "block");
  const warns = reasons.filter(r => r.level === "warn");
  const level = blocks.length ? "no" : warns.length ? "maybe" : "good";
  const order = { block: 0, warn: 1, good: 2, info: 3 };
  reasons.sort((a, b) => order[a.level] - order[b.level]);
  // When it won't work, how it would have been installed is beside the point.
  if (level === "no") for (let i = reasons.length - 1; i >= 0; i--) if (reasons[i].level === "good") reasons.splice(i, 1);
  const headline = { good: "Should work on your phone", maybe: "Might work on your phone", no: "Won't work on a phone" }[level];
  const detail = level === "no"
    ? "Dock found something this project needs that a phone's emulated Linux can't provide."
    : level === "maybe"
      ? `Some things could get in the way; ${installTime(plan)} if it works.`
      : `Nothing in it needs more than Dock has; ${installTime(plan)}.`;
  return { level, headline, detail, reasons };
}
