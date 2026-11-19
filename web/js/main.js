// Dock: app controller. Wires the VM, the install pipeline and the views together.

import config from "../config.js";
import { h, ICONS, appIcon, openSheet, toast, confirmSheet, notice, formatBytes, timeAgo } from "./ui.js";
import { kv, apps as appStore, overlay, requestPersistence } from "./store.js";
import { createVm } from "./vm.js";
import { parseRepoUrl, fetchRepoFacts } from "./github.js";
import { buildPlan } from "./planner.js";
import { runInstall, runUninstall, writeAppRecord, readAppRecords, InstallCancelled } from "./installer.js";
import { TerminalManager, createScreen } from "./terminal.js";
import { Drive } from "./drive.js";
import { installPreviewBridge, probePort } from "./preview.js";
import { openWorkspace, forgetWorkspace } from "./workspace.js";
import { findRecipe } from "./recipes.js";

const $ = id => document.getElementById(id);
// append() that skips empty values and flattens lists (DOM append would print "null").
const put = (el, ...kids) => { for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid); };
const MIB = 1 << 20;
const SUGGESTIONS = [
  ["yt-dlp", "yt-dlp/yt-dlp"], ["cowsay", "piuccio/cowsay"], ["ripgrep", "BurntSushi/ripgrep"], ["Agent skills", "anthropics/skills"],
];
const RUNTIME_LABEL = { python: "Python", node: "Node.js", go: "Go", rust: "Rust", native: "C / C++", skill: "Skills", unknown: "Source" };
const KIND_LABEL = { cli: "Command-line tool", web: "Web app", skill: "Agent skills", mcp: "MCP server", source: "Source only" };

// iPadOS reports itself as a Mac; touch support gives it away.
const IS_PHONE = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
// Memory sizes Dock steps down through when a device can't allocate the one asked for.
const MEMORY_STEPS = [1024, 768, 512, 384, 256, 192, 128];
const STAGE_LABEL = { connect: "Connecting", download: "Downloading", kernel: "Starting kernel", disk: "Loading disk", services: "Almost ready", ready: "Linux ready" };

const state = {
  // Phones give a web page far less memory than a desktop browser does.
  settings: { relayBase: "", memoryMB: IS_PHONE ? 256 : 512, googleClientId: "", githubToken: "", anthropicKey: "" },
  apps: [],
  vm: { machine: null, disk: null, manifest: null, status: "off", error: null, bootLog: "", waiters: [] },
  installs: new Map(),
  frozen: false, // true while a backup reads the stored disk
  driveInfo: null,
  view: "dock",
};
let terminals;
let drive;

// ------------------------------------------------------------------ settings

function relayBase() {
  return (state.settings.relayBase || new URL("r/open", document.baseURI).href).replace(/\/+$/, "");
}

async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  await kv.set("settings", state.settings);
}

// ------------------------------------------------------------------ VM lifecycle

function setVmStatus(status, error = null) {
  state.vm.status = status;
  state.vm.error = error;
  const pill = $("vm-pill");
  pill.dataset.state = status;
  $("vm-pill-text").textContent = { off: "Off", booting: "Starting Linux", ready: "Linux ready", error: "Linux stopped" }[status];
  $("term-empty-text").textContent = status === "ready" ? "Tap + to open a terminal."
    : status === "error" ? `Linux couldn't start. ${(error && error.message) || ""} Tap the status button on the Dock tab for details.`
      : "Linux is starting…";
  if (status !== "booting") $("boot-log").textContent = status === "error" ? cleanLog(state.vm.machine ? state.vm.machine.progress.log : "").slice(-2500) : "";
  if (status === "ready" || status === "error") {
    const waiters = state.vm.waiters;
    state.vm.waiters = [];
    for (const w of waiters) status === "ready" ? w.resolve() : w.reject(error || new Error("Linux could not start."));
  }
  if (state.view === "settings") renderSettings();
}

const cleanLog = text => String(text || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

// Start-up progress, shown on the status button and in the Terminal tab.
function showBootProgress(progress) {
  if (state.vm.status !== "booting") return;
  const label = STAGE_LABEL[progress.stage] || "Starting Linux";
  const seconds = Math.round((Date.now() - progress.startedAt) / 1000);
  $("vm-pill-text").textContent = progress.percent !== null && progress.stage === "download" ? `${label} ${progress.percent}%` : label;
  $("term-empty-text").textContent = `${progress.detail || "Linux is starting"}${progress.percent !== null && progress.stage === "download" ? ` · ${progress.percent}%` : ""} · ${seconds}s`;
  $("boot-log").textContent = cleanLog(progress.log).split("\n").slice(-14).join("\n");
}

/** Everything useful for working out why Linux didn't start, as plain text to paste. */
function diagnostics() {
  const vm = state.vm;
  const p = vm.machine ? vm.machine.progress : null;
  const err = vm.error;
  let simd = "unknown";
  try {
    simd = String(WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])));
  } catch { simd = "no WebAssembly"; }
  const lines = [
    "Dock diagnostics",
    `time: ${new Date().toISOString()}`,
    `browser: ${navigator.userAgent}`,
    `home-screen app: ${!!(navigator.standalone || matchMedia("(display-mode: standalone)").matches)}`,
    `device memory hint: ${navigator.deviceMemory || "n/a"} GB · wasm simd: ${simd}`,
    `linux memory: ${state.settings.memoryMB} MB · status: ${vm.status}`,
    `image: ${vm.manifest ? vm.manifest.version : "?"}`,
  ];
  if (p) {
    lines.push(`stage: ${p.stage} (${p.detail || ""}${p.percent !== null ? ` ${p.percent}%` : ""})`);
    lines.push(`elapsed: ${Math.round(((p.readyAt || Date.now()) - p.startedAt) / 1000)}s`);
    if (vm.disk) lines.push(`disk: ${JSON.stringify(vm.disk.stats)}`);
    if (p.errors.length) lines.push(`page errors: ${p.errors.slice(-5).join(" | ")}`);
  }
  if (err) lines.push(`error: [${err.code || err.name}] ${err.message}${err.cause ? ` (cause: ${err.cause.message || err.cause})` : ""}`);
  lines.push("--- boot log ---", cleanLog(p ? p.log : vm.bootLog).slice(-3000));
  return lines.join("\n");
}

function vmReady() {
  if (state.vm.status === "ready") return Promise.resolve();
  if (state.vm.status === "error" || state.vm.status === "off") return Promise.reject(state.vm.error || new Error("Linux is not running."));
  return new Promise((resolve, reject) => state.vm.waiters.push({ resolve, reject }));
}

const agent = () => (state.vm.status === "ready" && state.vm.machine ? state.vm.machine.agent : null);

async function bootVm() {
  setVmStatus("booting");
  state.vm.bootLog = "";
  const decoder = new TextDecoder();
  let machine = null;
  try {
    const created = await createVm({ relayBase: relayBase(), memoryMB: state.settings.memoryMB });
    machine = created.machine;
    Object.assign(state.vm, created);
    machine.on("console", bytes => {
      state.vm.bootLog = (state.vm.bootLog + decoder.decode(bytes)).slice(-20000);
    });
    let lastDraw = 0;
    machine.on("progress", progress => {
      if (Date.now() - lastDraw > 250) { lastDraw = Date.now(); showBootProgress(progress); }
    });
    machine.on("console", () => {
      if (Date.now() - lastDraw > 400) { lastDraw = Date.now(); showBootProgress(machine.progress); }
    });
    const ticker = setInterval(() => showBootProgress(machine.progress), 1000);
    try {
      await machine.boot();
    } finally {
      clearInterval(ticker);
    }
    machine.agent.onRestart = () => terminals.reset();
    setVmStatus("ready");
    const lowered = await kv.get("boot.lowered", null);
    if (lowered) {
      toast(`Linux now uses ${lowered.to} MB of memory so it fits on this device.`, 5000);
      await kv.delete("boot.lowered");
    }
    await kv.set("boot.everReady", true);
    reconcileApps().catch(() => {});
    updateStorage();
  } catch (err) {
    console.error(err);
    if (machine) await machine.discard();
    // Not enough memory: try again with less, in a fresh page so the failed attempt's
    // memory is really gone.
    const lower = MEMORY_STEPS.find(mb => mb < state.settings.memoryMB);
    if (err.code === "memory" && lower) {
      const lowered = await kv.get("boot.lowered", null);
      await kv.set("boot.lowered", { from: lowered ? lowered.from : state.settings.memoryMB, to: lower });
      await saveSettings({ memoryMB: lower });
      $("vm-pill-text").textContent = `Retrying with ${lower} MB`;
      setTimeout(() => location.reload(), 600);
      return;
    }
    if (err.code === "memory") {
      err.message = `This device couldn't give Linux enough memory, even at ${state.settings.memoryMB} MB. Close other Safari tabs and apps, then tap Try again.`;
    }
    setVmStatus("error", err);
    if (err.code === "base-changed") {
      const erase = await confirmSheet({
        title: "Dock's system was updated",
        text: "The saved disk on this phone was made for an older system image and can't be used with the new one. Erase it and start fresh? Installed apps will need to be installed again.",
        confirmLabel: "Erase and restart", danger: true,
      });
      if (erase) await eraseEverything();
    }
  }
}

async function stopVm({ save = true } = {}) {
  const { machine } = state.vm;
  if (!machine) return;
  terminals.reset();
  if (save) await machine.save().catch(() => {});
  clearInterval(machine.flowTimer);
  if (machine.emulator) await machine.emulator.destroy();
  machine.emulator = null;
  state.vm.machine = null;
  state.vm.disk = null;
  setVmStatus("off");
}

async function restartVm() {
  await stopVm();
  await bootVm();
}

// Persist written chunks every few seconds; the guest flushes its own buffers on a
// similar cadence (see rc.boot), so at most a few seconds of work is ever at risk.
function startAutosave() {
  setInterval(async () => {
    const { disk } = state.vm;
    if (!disk || state.frozen || !disk.dirtyCount) return;
    try {
      await disk.flush();
      updateStorage();
    } catch (err) {
      console.error("autosave failed", err);
      if (err && err.name === "QuotaExceededError") toast("This phone is out of storage space. Free some up to keep your changes.", 6000);
    }
  }, 3000);
  document.addEventListener("visibilitychange", () => {
    const { machine } = state.vm;
    if (document.visibilityState === "hidden" && machine && state.vm.status === "ready" && !state.frozen) {
      machine.save().catch(() => {});
    }
  });
}

// The disk is the source of truth for what's installed (it is what gets backed up).
async function reconcileApps() {
  const a = agent();
  if (!a) return;
  const records = await readAppRecords(a);
  const known = new Set(state.apps.map(app => app.id));
  let changed = false;
  for (const record of records) {
    if (!known.has(record.id)) {
      state.apps.push(record);
      await appStore.put(record);
      changed = true;
    }
  }
  if (changed) renderDock();
}

async function eraseEverything() {
  await stopVm({ save: false });
  await overlay.clear();
  await appStore.replaceAll([]);
  for (const key of ["disk.id", "disk.baseVersion", "backup.generation", "backup.last", "backup.chunks", "restore.inProgress"]) {
    await kv.delete(key);
  }
  location.reload();
}

// ------------------------------------------------------------------ dock view

async function upsertApp(app) {
  const index = state.apps.findIndex(a => a.id === app.id);
  if (index >= 0) state.apps[index] = app; else state.apps.push(app);
  await appStore.put(app);
  renderDock();
}

function renderDock() {
  const grid = $("grid");
  grid.textContent = "";
  const sorted = [...state.apps].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  for (const app of sorted) {
    const busy = app.status === "installing";
    const tile = h("button", {
      class: "tile" + (busy ? " busy" : "") + (app.status === "failed" ? " failed" : ""), type: "button",
      "aria-label": app.name, onclick: () => onTile(app),
    }, appIcon(app), h("span", { class: "tile-name" }, app.name));
    put(grid, tile);
  }
  $("apps-head").hidden = !sorted.length;
  $("apps-count").textContent = sorted.length ? `${sorted.length} app${sorted.length === 1 ? "" : "s"}` : "";
  $("empty").hidden = sorted.length > 0;
}

function onTile(app) {
  const install = state.installs.get(app.id);
  if (install && (install.status === "running" || install.status === "waiting")) openInstallSheet(install);
  else openAppSheet(app);
}

async function updateStorage() {
  const chunks = await overlay.count();
  const pending = (await kv.get("backup.pending", [])).length;
  const last = await kv.get("backup.last", 0);
  const local = chunks * MIB;
  let sub;
  let percent = Math.min(100, (local / (state.vm.manifest ? state.vm.manifest.size : 10 * 1024 * MIB)) * 100);
  let ringText = formatBytes(local).replace(" ", "");
  if (!drive.configured) sub = `${formatBytes(local)} on this phone · Drive backup not set up`;
  else if (drive.expired) sub = "Google Drive needs reconnecting";
  else if (!drive.connected) sub = `${formatBytes(local)} on this phone · Drive not connected`;
  else if (pending) sub = `${formatBytes(pending * MIB)} waiting to back up`;
  else sub = last ? `Backed up to Google Drive ${timeAgo(last)}` : "Connected to Google Drive";
  if (state.driveInfo && state.driveInfo.limit) {
    percent = Math.min(100, (state.driveInfo.usage / state.driveInfo.limit) * 100);
    ringText = Math.round(percent) + "%";
    $("storage-title").textContent = `${formatBytes(state.driveInfo.usage)} of ${formatBytes(state.driveInfo.limit)} used`;
  } else {
    $("storage-title").textContent = "Storage";
  }
  $("storage-ring").style.setProperty("--p", percent.toFixed(1));
  $("storage-ring-text").textContent = ringText;
  $("storage-sub").textContent = sub;
}

// ------------------------------------------------------------------ add from GitHub

function planTags(plan) {
  const tags = [h("span", { class: "tag accent" }, KIND_LABEL[plan.kind] || plan.kind), h("span", { class: "tag" }, RUNTIME_LABEL[plan.runtime] || plan.runtime)];
  if (plan.method) tags.push(h("span", { class: "tag" }, plan.method));
  for (const badge of plan.badges) tags.push(h("span", { class: "tag" }, badge));
  if (plan.stars) tags.push(h("span", { class: "tag" }, `★ ${plan.stars >= 1000 ? (plan.stars / 1000).toFixed(plan.stars >= 10000 ? 0 : 1) + "k" : plan.stars}`));
  return h("div", { class: "tags" }, tags);
}

function stepList(steps) {
  return h("ol", { class: "steps" }, steps.map((step, i) =>
    h("li", { class: "step", dataset: { state: step.state || "pending" } },
      h("span", { class: "step-mark" }, step.state === "done" ? "✓" : step.state === "failed" ? "!" : String(i + 1)),
      h("div", { class: "step-text" }, h("div", { class: "step-title" }, step.title), h("div", { class: "step-cmd" }, step.cmd)))));
}

async function analyze(input) {
  const target = parseRepoUrl(input);
  if (!target) {
    toast("That doesn't look like a GitHub repository link.");
    return;
  }
  const sheet = openSheet();
  const pseudo = { id: `${target.owner}--${target.repo}`.toLowerCase(), owner: target.owner, name: target.repo, kind: "cli" };
  put(sheet.body, 
    h("div", { class: "sheet-title" }, appIcon(pseudo), h("div", {}, h("h2", {}, target.repo), h("p", { class: "muted" }, `${target.owner}/${target.repo}`))),
    h("p", { class: "muted", style: "margin-bottom:12px" }, "Reading the repository…"),
    h("div", { class: "skeleton", style: "height:18px;width:85%;margin-bottom:10px" }),
    h("div", { class: "skeleton", style: "height:18px;width:60%;margin-bottom:18px" }),
    h("div", { class: "skeleton", style: "height:150px" }),
  );
  put(sheet.foot, h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Cancel"));
  let plan;
  try {
    plan = buildPlan(await fetchRepoFacts(target, { token: state.settings.githubToken }));
  } catch (err) {
    sheet.body.textContent = "";
    put(sheet.body, h("h2", { style: "margin:6px 0 10px" }, "Couldn't read that repository"),
      notice("block", err.code === "not-found" ? err.message : "Check your connection and try again."));
    return;
  }
  $("add-input").value = "";
  renderPlan(sheet, plan);
}

function renderPlan(sheet, plan) {
  const existing = state.apps.find(a => a.id === plan.id && a.status === "installed");
  const blocked = plan.warnings.some(w => w.level === "block");
  sheet.body.textContent = "";
  sheet.foot.textContent = "";
  const steps = stepList(plan.steps);
  const toggle = h("button", { class: "link", type: "button", onclick: () => {
    const on = steps.classList.toggle("show-cmds");
    toggle.textContent = on ? "Hide commands" : "Show commands";
  } }, "Show commands");
  put(sheet.body, 
    h("div", { class: "sheet-title" }, appIcon({ ...plan }), h("div", {}, h("h2", {}, plan.name), h("p", { class: "muted" }, `${plan.owner}/${plan.repo}`))),
    plan.description ? h("p", { class: "desc" }, plan.description) : null,
    planTags(plan),
    plan.warnings.map(w => notice(w.level, w.text)),
    state.vm.status === "booting" ? notice("info", "Linux is still starting. The install begins as soon as it's ready.") : null,
    h("div", { class: "section-head", style: "margin:14px 2px 10px" }, h("h3", { style: "font-size:16px" }, "What Dock will do"), toggle),
    steps,
    plan.fallback ? h("p", { class: "muted small", style: "margin:-4px 4px 10px" }, `If that fails, Dock tries: ${plan.fallback.method.toLowerCase()}.`) : null,
  );
  put(sheet.foot, 
    h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Cancel"),
    h("button", { class: "btn primary", type: "button", id: "install-go", onclick: () => { sheet.close(); startInstall(plan); } },
      existing ? "Reinstall" : blocked ? "Try anyway" : "Install"),
  );
}

function pickLaunch(bins, name) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return bins.find(b => norm(b) === norm(name)) || bins[0] || null;
}

function startInstall(plan) {
  const app = {
    id: plan.id, owner: plan.owner, repo: plan.repo, url: plan.url, name: plan.name, description: plan.description,
    kind: plan.kind, runtime: plan.runtime, method: plan.method, badges: plan.badges, port: plan.port,
    launch: plan.launch, launchLabel: plan.launchLabel, bins: [], uninstall: plan.uninstall,
    status: "installing", error: null, addedAt: (state.apps.find(a => a.id === plan.id) || {}).addedAt || Date.now(),
  };
  const install = {
    app, plan, method: plan.method, status: "waiting", error: null,
    steps: plan.steps.map(s => ({ ...s, state: "pending" })),
    log: [], logBytes: 0, control: { cancelled: false, session: null }, listeners: new Set(), cols: 80, rows: 24,
  };
  const emit = event => { for (const fn of install.listeners) fn(event); };
  state.installs.set(app.id, install);
  upsertApp(app);
  openInstallSheet(install);

  (async () => {
    await vmReady();
    const a = agent();
    install.status = "running";
    emit({ type: "status" });
    const result = await runInstall({
      agent: a, plan, control: install.control, size: install,
      onEvent: event => {
        if (event.type === "steps") {
          install.steps = event.steps.map(s => ({ ...s, state: "pending" }));
          install.method = event.method;
        } else if (event.type === "step") {
          install.steps[event.index].state = event.state;
        } else if (event.type === "output") {
          install.log.push(event.bytes);
          install.logBytes += event.bytes.length;
          while (install.logBytes > 400000 && install.log.length > 1) install.logBytes -= install.log.shift().length;
        }
        emit(event);
      },
    });
    app.status = "installed";
    app.bins = result.bins;
    app.method = result.method;
    app.installedAt = Date.now();
    if (!app.launch) app.launch = pickLaunch(result.bins, app.name);
    if (app.kind === "cli" && !app.launch && plan.runtime !== "skill") app.kind = "source";
    await writeAppRecord(a, app);
    await state.vm.machine.save();
    install.status = "done";
    toast(`${app.name} is installed`);
    autoBackup();
  })().catch(async err => {
    if (err instanceof InstallCancelled) {
      install.status = "cancelled";
      const a = agent();
      if (a) await runUninstall(a, app).catch(() => {});
      state.apps = state.apps.filter(x => x.id !== app.id);
      await appStore.delete(app.id);
      renderDock();
      return;
    }
    console.error(err);
    install.status = "failed";
    install.error = err.message;
    app.status = "failed";
    app.error = err.message;
  }).finally(async () => {
    if (install.status !== "cancelled") await upsertApp(app);
    updateStorage();
    emit({ type: "status" });
  });
}

function openInstallSheet(install) {
  const { app } = install;
  let screen = null;
  const listener = event => {
    if (event.type === "output" && screen) screen.term.write(event.bytes);
    else if (event.type !== "output") render();
  };
  const sheet = openSheet({ full: true, onClose: () => { install.listeners.delete(listener); if (screen) screen.term.dispose(); } });
  const head = h("div", {});
  const logEl = h("div", { class: "log tall" });
  put(sheet.body, head, logEl);
  screen = createScreen(logEl, { fontSize: 11, input: false });
  install.cols = screen.term.cols;
  install.rows = screen.term.rows;
  for (const chunk of install.log) screen.term.write(chunk);

  function render() {
    head.textContent = "";
    sheet.foot.textContent = "";
    const title = { waiting: "Waiting for Linux…", running: `Installing ${app.name}`, done: `${app.name} is ready`, failed: "Install failed", cancelled: "Install cancelled" }[install.status];
    put(head, 
      h("div", { class: "sheet-title" }, appIcon(app), h("div", {}, h("h2", {}, title), h("p", { class: "muted" }, `${install.method} · ${app.owner}/${app.repo}`))),
      install.status === "failed" ? notice("block", install.error || "Something went wrong.") : null,
      install.status === "done" && findRecipe(app) && findRecipe(app).sites ? notice("info", `Works with ${findRecipe(app).sites.map(site => site.name).join(", ")}${findRecipe(app).sitesNote ? " " + findRecipe(app).sitesNote : ""}.`) : null,
      install.status === "running" ? h("p", { class: "muted small", style: "margin:-4px 2px 12px" }, "This runs inside an emulated computer, so it's slower than a laptop. You can hide this and keep using Dock.") : null,
      stepList(install.steps),
    );
    if (install.status === "running" || install.status === "waiting") {
      put(sheet.foot, 
        h("button", { class: "btn danger", type: "button", onclick: () => {
          install.control.cancelled = true;
          if (install.control.session) install.control.session.close();
          toast("Cancelling…");
        } }, "Cancel"),
        h("button", { class: "btn primary", type: "button", onclick: () => sheet.close() }, "Hide"),
      );
    } else if (install.status === "done") {
      put(sheet.foot, 
        h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Done"),
        h("button", { class: "btn primary", type: "button", onclick: () => { sheet.close(); openApp(app); } }, openLabel(app)),
      );
    } else {
      put(sheet.foot, 
        h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Close"),
        install.status === "failed" ? h("button", { class: "btn primary", type: "button", onclick: () => { sheet.close(); startInstall(install.plan); } }, "Try again") : null,
      );
    }
  }
  install.listeners.add(listener);
  render();
}

// ------------------------------------------------------------------ installed apps

function openLabel(app) {
  const recipe = findRecipe(app);
  if (recipe && recipe.sites && recipe.sites[0]) return `Open ${recipe.sites[0].name}`;
  return "Open";
}

const workspaceContext = {
  machine: () => (state.vm.status === "ready" ? state.vm.machine : null),
  get settings() { return state.settings; },
  saveSettings,
  openTerminal: app => openInTerminal(app),
  startWebApp: app => startWebApp(app),
};

function openAppSheet(app) {
  const sheet = openSheet();
  const install = state.installs.get(app.id);
  put(sheet.body, 
    h("div", { class: "sheet-title" }, appIcon(app), h("div", {}, h("h2", {}, app.name), h("p", { class: "muted" }, `${app.owner}/${app.repo}`))),
    app.description ? h("p", { class: "desc" }, app.description) : null,
    h("div", { class: "tags" },
      h("span", { class: "tag accent" }, KIND_LABEL[app.kind] || app.kind),
      h("span", { class: "tag" }, RUNTIME_LABEL[app.runtime] || app.runtime),
      (app.badges || []).map(b => h("span", { class: "tag" }, b))),
    app.status === "failed" ? notice("block", app.error || "The install did not finish.") : null,
    h("div", { class: "rows", style: "margin-bottom:14px" },
      app.bins && app.bins.length ? h("div", { class: "row" }, h("div", { class: "row-main" }, h("span", {}, "Commands"), h("span", { class: "muted mono" }, app.bins.join("  ")))) : null,
      app.port ? h("div", { class: "row" }, h("div", { class: "row-main" }, h("span", {}, "Web page"), h("span", { class: "muted" }, `Port ${app.port} inside Linux`))) : null,
      h("div", { class: "row" }, h("div", { class: "row-main" }, h("span", {}, "Location"), h("span", { class: "muted mono" }, `/dock/apps/${app.id}`))),
      h("a", { class: "row action", href: app.url, target: "_blank", rel: "noopener" }, h("div", { class: "row-main" }, h("span", {}, "View on GitHub"))),
    ),
  );
  put(sheet.foot, 
    h("button", { class: "btn danger", type: "button", onclick: async () => { sheet.close(); removeApp(app); } }, "Remove"),
    app.status === "failed"
      ? h("button", { class: "btn primary", type: "button", onclick: () => {
        sheet.close();
        if (install && install.log.length) openInstallSheet(install); else analyze(app.url);
      } }, install && install.log.length ? "View log" : "Try again")
      : h("button", { class: "btn primary", type: "button", onclick: () => { sheet.close(); openApp(app); } }, openLabel(app)),
  );
}

async function removeApp(app) {
  const ok = await confirmSheet({ title: `Remove ${app.name}?`, text: "Its files are deleted from Dock's Linux. You can install it again later.", confirmLabel: "Remove", danger: true });
  if (!ok) return;
  const a = agent();
  if (!a && app.status === "installed") {
    toast("Linux is still starting. Try again in a moment.");
    return;
  }
  if (a) await runUninstall(a, app).catch(() => {});
  state.apps = state.apps.filter(x => x.id !== app.id);
  state.installs.delete(app.id);
  forgetWorkspace(app.id);
  await appStore.delete(app.id);
  renderDock();
  if (state.vm.machine) await state.vm.machine.save().catch(() => {});
  updateStorage();
  toast(`${app.name} removed`);
}

function appEnv(app) {
  return `export APP=/dock/apps/${app.id} SRC=/dock/apps/${app.id}/src\n`;
}

function openApp(app) {
  openWorkspace(workspaceContext, app);
}

function openInTerminal(app) {
  const a = agent();
  if (!a) {
    toast(state.vm.status === "booting" ? "Linux is still starting. Try again in a moment." : "Linux isn't running.");
    return;
  }
  if (app.launchLabel && app.launch) {
    terminals.open({ title: app.name, script: appEnv(app) + app.launch });
  } else if (app.launch) {
    terminals.open({ title: app.name, pretype: app.launch + " " });
  } else {
    terminals.open({ title: app.name, pretype: `cd /dock/apps/${app.id}${app.kind === "skill" ? "/skills" : "/src"} && ls\n` });
  }
  switchView("terminal");
}

async function startWebApp(app) {
  const a = agent();
  let tab = terminals.tabs.find(t => t.appId === app.id && !t.exited);
  if (!tab) {
    tab = terminals.open({ title: app.name, script: appEnv(app) + app.launch });
    tab.appId = app.id;
  }
  let stop = false;
  const sheet = openSheet({ onClose: () => { stop = true; } });
  const status = h("p", { class: "desc" }, `Starting… waiting for it to answer on port ${app.port}.`);
  const openBtn = h("button", { class: "btn primary", type: "button", disabled: true, onclick: () => { sheet.close(); openPreview(app); } }, "Open page");
  put(sheet.body, h("div", { class: "sheet-title" }, appIcon(app), h("div", {}, h("h2", {}, app.name), h("p", { class: "muted" }, app.launchLabel || app.launch))), status);
  put(sheet.foot, h("button", { class: "btn", type: "button", onclick: () => { sheet.close(); switchView("terminal"); } }, "Show terminal"), openBtn);
  for (let i = 0; i < 150 && !stop; i++) {
    if (tab.exited) {
      status.textContent = "The app stopped. Open the terminal to see why.";
      return;
    }
    if (await probePort(a, app.port)) {
      status.textContent = "It's running.";
      openBtn.disabled = false;
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

function openPreview(app) {
  const frame = h("iframe", { src: `preview/${app.port}/`, title: app.name });
  const view = h("div", { class: "preview" },
    h("div", { class: "preview-bar" },
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close", html: ICONS.close, onclick: () => view.remove() }),
      h("strong", {}, app.name),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Reload", html: ICONS.reload, onclick: () => { frame.src = frame.src; } })),
    frame);
  put($("app"), view);
}

// ------------------------------------------------------------------ Google Drive

async function refreshDriveInfo() {
  if (!drive.connected) {
    state.driveInfo = null;
    return;
  }
  try { state.driveInfo = await drive.about(); } catch { state.driveInfo = null; }
  updateStorage();
}

async function runBackup({ force = false, quiet = false } = {}) {
  let sheet = null;
  let bar = null;
  let label = null;
  if (!quiet) {
    sheet = openSheet({ dismissible: false });
    bar = h("i", {});
    label = h("p", { class: "muted", style: "margin-top:10px" }, "Preparing…");
    put(sheet.body, h("h2", { style: "margin:6px 0 12px" }, "Backing up to Google Drive"), h("div", { class: "meter" }, bar), label);
  }
  try {
    const result = await drive.backup({
      force,
      onProgress: (n, total) => {
        if (!bar) return;
        bar.style.width = total ? `${(n / total) * 100}%` : "100%";
        label.textContent = total ? `${n} of ${total} MB uploaded` : "Nothing new to upload";
      },
    });
    if (sheet) sheet.close();
    if (!quiet) toast(result.uploaded ? "Backup complete" : "Already up to date");
  } catch (err) {
    if (sheet) sheet.close();
    if (err.code === "conflict" && !quiet) {
      const replace = await confirmSheet({
        title: "Replace the backup in Drive?",
        text: "Google Drive holds a Dock backup from another phone, or from before this phone was reset. Backing up now replaces it with what's on this phone.",
        confirmLabel: "Replace backup", danger: true,
      });
      if (replace) return runBackup({ force: true });
    } else if (!quiet) {
      toast(err.message || "Backup failed", 4500);
    }
  }
  await refreshDriveInfo();
  updateStorage();
  if (state.view === "settings") renderSettings();
}

function autoBackup() {
  if (drive.connected && !drive.busy) runBackup({ quiet: true });
}

async function runRestore() {
  const ok = await confirmSheet({
    title: "Restore from Google Drive?",
    text: "Everything in Dock's Linux on this phone is replaced with the backup in your Drive.",
    confirmLabel: "Restore", danger: true,
  });
  if (!ok) return;
  const manifest = state.vm.manifest || await (await fetch("vm/disk/manifest.json", { cache: "no-cache" })).json();
  const sheet = openSheet({ dismissible: false });
  const bar = h("i", {});
  const label = h("p", { class: "muted", style: "margin-top:10px" }, "Stopping Linux…");
  put(sheet.body, h("h2", { style: "margin:6px 0 12px" }, "Restoring from Google Drive"), h("div", { class: "meter" }, bar), label);
  try {
    await stopVm({ save: false });
    await drive.restore({
      expectedBaseVersion: manifest.version,
      onProgress: (n, total) => {
        bar.style.width = total ? `${(n / total) * 100}%` : "100%";
        label.textContent = `${n} of ${total} MB downloaded`;
      },
    });
    location.reload();
  } catch (err) {
    sheet.close();
    toast(err.message || "Restore failed", 5000);
    if (!await kv.get("restore.inProgress", false)) bootVm();
    else renderSettings();
  }
}

// ------------------------------------------------------------------ settings view

function row(main, sub, value) {
  return h("div", { class: "row" }, h("div", { class: "row-main" }, h("span", {}, main), sub ? h("span", { class: "muted" }, sub) : null), value ? h("span", { class: "row-value" }, value) : null);
}

function actionRow(label, onclick, { danger = false, sub = null } = {}) {
  return h("button", { class: "row action" + (danger ? " danger" : ""), type: "button", onclick }, h("div", { class: "row-main" }, h("span", {}, label), sub ? h("span", { class: "muted" }, sub) : null));
}

function inputRow(label, sub, value, { type = "text", placeholder = "", onchange }) {
  const input = h("input", { type, value: value || "", placeholder, autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  input.addEventListener("change", () => onchange(input.value.trim()));
  return h("label", { class: "row" }, h("div", { class: "row-main" }, h("span", {}, label), sub ? h("span", { class: "muted" }, sub) : null, input));
}

async function renderSettings() {
  const body = $("settings-body");
  const chunks = await overlay.count();
  const pending = (await kv.get("backup.pending", [])).length;
  const last = await kv.get("backup.last", 0);
  const restoreStuck = await kv.get("restore.inProgress", false);
  const info = state.driveInfo;
  const vm = state.vm;

  const driveRows = [];
  if (drive.connected) {
    driveRows.push(h("div", { class: "row" }, h("div", { class: "row-main" },
      h("span", {}, info && info.email ? info.email : "Connected"),
      h("span", { class: "muted" }, info ? `${formatBytes(info.usage)} of ${formatBytes(info.limit)} used in this Google account` : "Google Drive"),
      info && info.limit ? h("div", { class: "meter" }, h("i", { style: `width:${Math.min(100, (info.usage / info.limit) * 100)}%` })) : null)));
    driveRows.push(row("Last backup", null, last ? timeAgo(last) : "Never"));
    driveRows.push(actionRow("Back up now", () => runBackup(), { sub: pending ? `${formatBytes(pending * MIB)} changed since the last backup` : "Everything is backed up" }));
    driveRows.push(actionRow("Restore from Drive", () => runRestore()));
    driveRows.push(actionRow("Disconnect", async () => { await drive.disconnect(); state.driveInfo = null; renderSettings(); updateStorage(); }, { danger: true }));
  } else {
    driveRows.push(row(drive.expired ? "Session expired" : "Not connected", drive.expired ? "Google signs browser apps out after an hour." : "Back up Dock's Linux disk to your own Google Drive."));
    if (!config.googleClientId) {
      driveRows.push(inputRow("Google client ID", "From Google Cloud console → Credentials → OAuth client ID (Web application).", state.settings.googleClientId,
        { placeholder: "1234-abc.apps.googleusercontent.com", onchange: async v => { await saveSettings({ googleClientId: v }); renderSettings(); updateStorage(); } }));
    }
    driveRows.push(actionRow(drive.expired ? "Reconnect Google Drive" : "Connect Google Drive", async () => {
      if (!drive.configured) return toast("Enter a Google client ID first.");
      if (vm.machine && vm.status === "ready") await vm.machine.save().catch(() => {});
      drive.connect().catch(err => toast(err.message));
    }));
  }

  body.textContent = "";
  put(body, 
    h("header", { class: "hero" }, h("div", {}, h("p", { class: "eyebrow" }, "Dock"), h("h1", {}, "Settings"))),
    restoreStuck ? notice("block", "A restore from Google Drive was interrupted, so the disk on this phone is incomplete. Restore again, or erase Dock's data below.") : null,
    h("div", { class: "group" }, h("h3", {}, "Google Drive backup"), h("div", { class: "rows" }, driveRows),
      h("p", { class: "group-note" }, "Backups go into a “Dock” folder in your Drive. Google's free 15 GB is shared with Gmail and Photos, and Dock can only see the files it created.")),
    h("div", { class: "group" }, h("h3", {}, "Linux"), h("div", { class: "rows" },
      row("Status", vm.status === "error" && vm.error ? vm.error.message : null, { off: "Off", booting: "Starting…", ready: "Running", error: "Stopped" }[vm.status]),
      row("Disk used on this phone", null, formatBytes(chunks * MIB)),
      h("div", { class: "row" }, h("div", { class: "row-main" }, h("span", {}, "Memory"), h("span", { class: "muted" }, "Takes effect when Linux restarts")),
        (() => {
          const select = h("select", { "aria-label": "Memory" }, [...MEMORY_STEPS].reverse().map(mb => h("option", { value: mb, selected: mb === state.settings.memoryMB }, `${mb} MB`)));
          select.addEventListener("change", () => saveSettings({ memoryMB: Number(select.value) }));
          return select;
        })()),
      actionRow("Restart Linux", async () => { toast("Restarting Linux…"); await restartVm(); }),
      actionRow("Erase Dock's data", async () => {
        const ok = await confirmSheet({ title: "Erase everything?", text: "Deletes Dock's Linux disk and every installed app from this phone. A backup in Google Drive is not touched.", confirmLabel: "Erase", danger: true });
        if (ok) eraseEverything();
      }, { danger: true }),
    )),
    h("div", { class: "group" }, h("h3", {}, "Connections"), h("div", { class: "rows" },
      inputRow("Network relay", "Linux reaches the internet through this server. Leave empty to use the one this app came from.", state.settings.relayBase,
        { type: "url", placeholder: new URL("r/open", document.baseURI).href, onchange: v => { saveSettings({ relayBase: v }); toast("Restart Linux to use the new relay."); } }),
      inputRow("GitHub token (optional)", "Only needed for private repositories or if GitHub limits how often you can look up repositories.", state.settings.githubToken,
        { type: "password", placeholder: "github_pat_…", onchange: v => saveSettings({ githubToken: v }) }),
    )),
    h("div", { class: "group" }, h("h3", {}, "Ask AI"), h("div", { class: "rows" },
      inputRow("Anthropic API key", "Lets an AI run your installed tools and skills for you. Stored on this phone only; you pay Anthropic for usage.", state.settings.anthropicKey,
        { type: "password", placeholder: "sk-ant-…", onchange: v => saveSettings({ anthropicKey: v }) }),
    )),
    h("div", { class: "group" }, h("h3", {}, "About"), h("div", { class: "rows" },
      row("How it works", "Dock runs a small 32-bit Alpine Linux in an emulator on this phone. Tools that install with pip, npm or apk generally work; things that need Docker, a GPU, a desktop window or lots of compiling don't."),
      row("Speed", "Everything is emulated, so installs take minutes rather than seconds."),
    )),
  );
}

function openVmSheet() {
  const vm = state.vm;
  let timer = null;
  const sheet = openSheet({ onClose: () => clearInterval(timer) });
  const titles = { off: "Linux is off", booting: "Linux is starting", ready: "Linux is running", error: "Linux couldn't start" };
  const desc = h("p", { class: "desc" });
  const log = h("pre", { class: "mono log", style: "white-space:pre-wrap;font-size:11px;color:#9498a8;overflow:auto;margin:0 0 12px" });
  const draw = () => {
    const p = vm.machine ? vm.machine.progress : null;
    desc.textContent = vm.status === "error" ? (vm.error && vm.error.message) || "Something went wrong while starting."
      : vm.status === "booting" ? `${p && p.detail ? p.detail : "Starting"}${p && p.percent !== null && p.stage === "download" ? ` · ${p.percent}%` : ""}${p && p.startedAt ? ` · ${Math.round((Date.now() - p.startedAt) / 1000)}s` : ""}. A small Linux computer is booting inside this app; on a phone this usually takes one to three minutes.`
        : `Alpine Linux${vm.machine && vm.machine.agent && vm.machine.agent.info ? ` · kernel ${vm.machine.agent.info.kernel}` : ""} · ${state.settings.memoryMB} MB memory`;
    log.textContent = cleanLog(p ? p.log : vm.bootLog).slice(-3000) || "(no messages from Linux yet)";
  };
  draw();
  if (vm.status === "booting") timer = setInterval(draw, 1000);
  put(sheet.body, h("h2", { style: "margin:6px 0 8px" }, titles[vm.status]), desc, log,
    vm.status === "error" ? h("p", { class: "muted small", style: "margin:-4px 2px 10px" }, "If trying again doesn't help, tap Copy details and send the text to whoever is helping you.") : null);
  put(sheet.foot,
    h("button", { class: "btn", type: "button", onclick: async () => {
      try {
        await navigator.clipboard.writeText(diagnostics());
        toast("Details copied");
      } catch {
        // Clipboard refused: show the text so it can be selected by hand.
        log.textContent = diagnostics();
        log.style.userSelect = "text";
        clearInterval(timer);
      }
    } }, "Copy details"),
    h("button", { class: "btn primary", type: "button", onclick: async () => { sheet.close(); toast("Restarting Linux…"); await restartVm(); } }, vm.status === "ready" ? "Restart" : "Try again"),
  );
}

// ------------------------------------------------------------------ navigation and startup

function switchView(name) {
  state.view = name;
  for (const view of document.querySelectorAll(".view")) view.classList.toggle("active", view.id === `view-${name}`);
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.view === name);
  if (name === "terminal") {
    if (!terminals.tabs.length && agent()) terminals.open({ title: "Shell" });
    requestAnimationFrame(() => terminals.refit());
  }
  if (name === "settings") {
    renderSettings();
    refreshDriveInfo().then(() => { if (state.view === "settings") renderSettings(); });
  }
}

function trackViewport() {
  const vv = window.visualViewport;
  const apply = () => {
    const height = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--vvh", `${height}px`);
    document.body.classList.toggle("keyboard-open", window.innerHeight - height > 120);
    window.scrollTo(0, 0);
    if (terminals) terminals.refit();
  };
  if (vv) {
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
  }
  window.addEventListener("resize", apply);
  apply();
}

async function init() {
  const saved = await kv.get("settings", {});
  Object.assign(state.settings, Object.fromEntries(Object.entries(config).filter(([, v]) => v)), saved);
  if (!await kv.get("disk.id")) await kv.set("disk.id", crypto.randomUUID());
  // Earlier versions asked phones for more memory than many can give. Until Linux has
  // started once on this device, use the phone default.
  if (IS_PHONE && state.settings.memoryMB > 256 && !await kv.get("boot.everReady", false)) state.settings.memoryMB = 256;

  terminals = new TerminalManager({ stack: $("term-stack"), tabs: $("term-tabs"), keybar: $("keybar"), empty: $("term-empty"), getAgent: agent });
  let endpoints;
  try { endpoints = JSON.parse(localStorage.getItem("dock.dev.google") || "null") || undefined; } catch { endpoints = undefined; }
  drive = new Drive({
    clientId: () => config.googleClientId || state.settings.googleClientId,
    freeze: async () => {
      if (state.vm.machine && state.vm.status === "ready") await state.vm.machine.save();
      state.frozen = true;
    },
    unfreeze: () => { state.frozen = false; },
    endpoints,
  });
  let driveError = null;
  try { await drive.init(); } catch (err) { driveError = err; }

  state.apps = await appStore.all();
  for (const app of state.apps) {
    if (app.status === "installing") {
      app.status = "failed";
      app.error = "The install was interrupted when Dock closed.";
      await appStore.put(app);
    }
  }

  // Events
  $("add-form").addEventListener("submit", e => { e.preventDefault(); analyze($("add-input").value); });
  $("add-paste").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        $("add-input").value = text.trim();
        analyze(text);
        return;
      }
    } catch { /* clipboard access was refused */ }
    $("add-input").focus();
  });
  for (const [label, repo] of SUGGESTIONS) {
    put($("suggestions"), h("button", { class: "chip", type: "button", onclick: () => analyze(repo) }, label));
  }
  $("tabbar").addEventListener("click", e => {
    const tab = e.target.closest(".tab");
    if (tab) switchView(tab.dataset.view);
  });
  $("term-new").addEventListener("click", () => {
    if (!agent()) return toast("Linux is still starting.");
    terminals.open({ title: `Shell ${terminals.nextId}` });
    terminals.focus();
  });
  $("vm-pill").addEventListener("click", openVmSheet);
  $("storage-card").addEventListener("click", () => switchView("settings"));

  renderDock();
  trackViewport();
  updateStorage();
  startAutosave();
  requestPersistence();
  installPreviewBridge(agent);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  if (driveError) toast(driveError.message, 4500);
  if (drive.justConnected) {
    toast("Google Drive connected");
    refreshDriveInfo();
  }

  if (await kv.get("restore.inProgress", false)) {
    setVmStatus("error", new Error("A restore from Google Drive was interrupted."));
    switchView("settings");
  } else {
    bootVm();
  }

  // Deep link: /?repo=<github link> (used by the share shortcut).
  const params = new URLSearchParams(location.search);
  const shared = params.get("repo") || params.get("url") || params.get("text");
  if (shared) {
    history.replaceState(null, "", location.pathname);
    analyze(shared);
  }
}

window.dock = { state, openApp, diagnostics, get drive() { return drive; }, get terminals() { return terminals; }, runBackup, analyze, openPreview };
init().catch(err => {
  console.error(err);
  toast("Dock could not start: " + err.message, 8000);
});
