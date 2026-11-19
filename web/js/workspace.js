// The workspace: what opens when you tap an installed app. Every app gets the same
// three panes, filled in according to what the tool is:
//
//   Use     a tap-driven screen for the tool: a hand-written recipe where one exists
//           (see recipes.js), otherwise switches generated from the tool's own --help,
//           a skill list for skill repositories, or a start button for web apps
//   Files   files shared between the phone and the tool (upload, save back, delete)
//   Ask AI  describe what you want; Claude runs the tool for you (see assistant.js)

import { h, ICONS, appIcon, toast, notice, formatBytes, confirmSheet } from "./ui.js";
import { findRecipe, parseHelp, buildCommand, formatDuration, shellQuote } from "./recipes.js";
import { FILES_DIR, listFiles, uploadFile, readFile, deleteFile, saveToPhone, canShareFiles, fileKind } from "./files.js";
import { Assistant, buildSystemPrompt, describeError } from "./assistant.js";

const sessions = new Map(); // app id -> state kept while Dock is open
const decoder = new TextDecoder();
// append() that skips empty values (DOM append would print "null").
const put = (el, ...kids) => { for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid); };
const KIND_GLYPH = { video: "▶", audio: "♪", image: "◩", file: "≡" };

function cleanOutput(text) {
  // Drop colour codes; a carriage return means "overwrite this line" (progress bars).
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map(line => line.split("\r").filter(Boolean).pop() || "").join("\n");
}

/**
 * @param {object} ctx
 * @param {() => object|null} ctx.machine the running VM (has .agent and .bridge), or null
 * @param {object} ctx.settings
 * @param {(patch: object) => Promise<void>} ctx.saveSettings
 * @param {(app: object) => void} ctx.openTerminal
 * @param {(app: object) => void} ctx.startWebApp
 * @param {object} app
 */
export function openWorkspace(ctx, app) {
  const vm = ctx.machine();
  if (!vm) {
    toast("Linux is still starting. Try again in a moment.");
    return;
  }
  let state = sessions.get(app.id);
  if (!state) {
    state = { pane: "use", recipe: findRecipe(app), chat: [], assistant: null, use: {} };
    sessions.set(app.id, state);
  }
  const agent = vm.agent;
  const recipe = state.recipe;

  const body = h("div", { class: "ws-body" });
  const tabs = h("div", { class: "segmented", role: "tablist" });
  const view = h("div", { class: "workspace" },
    h("div", { class: "ws-head" },
      h("button", { class: "icon-btn", type: "button", "aria-label": "Close", html: ICONS.close, onclick: () => close() }),
      appIcon(app),
      h("div", { class: "ws-title" }, h("strong", {}, app.name), h("span", { class: "muted" }, recipe ? recipe.title : app.kind === "skill" ? "Agent skills" : `${app.owner}/${app.repo}`)),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Open in Terminal", html: ICONS.terminal, onclick: () => { close(); ctx.openTerminal(app); } })),
    tabs, body);
  let alive = true;
  const close = () => { alive = false; view.remove(); };

  const PANES = [["use", "Use"], ["files", "Files"], ["ai", "Ask AI"]];
  function show(pane) {
    state.pane = pane;
    tabs.textContent = "";
    for (const [id, label] of PANES) {
      put(tabs, h("button", { class: id === pane ? "on" : "", type: "button", role: "tab", onclick: () => show(id) }, label));
    }
    body.textContent = "";
    body.className = "ws-body" + (pane === "ai" ? " chat" : "");
    ({ use: renderUse, files: renderFiles, ai: renderAi })[pane]();
  }

  // ---------------------------------------------------------------- jobs

  /** Makes sure optional helpers a recipe action needs are installed (one time). */
  async function ensureExtras(names, card) {
    for (const name of names) {
      const extra = recipe.extras[name];
      const { code } = await agent.capture(extra.check);
      if (code === 0) continue;
      card.setStatus(`Adding ${extra.label} (one time): it ${extra.why}…`);
      const result = await agent.capture(extra.install);
      if (result.code !== 0) throw new Error(`${extra.label} could not be installed.`);
    }
  }

  /** A card showing one running command: status, progress, output, resulting files. */
  function jobCard(title, { showOutput = false } = {}) {
    const status = h("span", { class: "muted" }, "Starting…");
    const bar = h("i", {});
    const meter = h("div", { class: "meter indeterminate" }, bar);
    const output = h("pre", { class: "job-output" + (showOutput ? "" : " collapsed") });
    const toggle = h("button", { class: "link", type: "button", onclick: () => {
      toggle.textContent = output.classList.toggle("collapsed") ? "Show details" : "Hide details";
    } }, showOutput ? "Hide details" : "Show details");
    const stop = h("button", { class: "link danger", type: "button" }, "Stop");
    const results = h("div", { class: "job-results" });
    const el = h("div", { class: "job" }, h("div", { class: "job-head" }, h("strong", {}, title), stop), status, meter, results, output, toggle);
    return {
      el, stop, results,
      setStatus(text) { status.textContent = text; },
      setProgress(percent) {
        meter.classList.remove("indeterminate");
        bar.style.width = `${Math.max(2, Math.min(100, percent))}%`;
      },
      setOutput(text) {
        output.textContent = text.slice(-6000);
        output.scrollTop = output.scrollHeight;
      },
      finish(ok, text) {
        meter.remove();
        stop.remove();
        status.textContent = text;
        status.className = ok ? "good" : "bad";
        if (!ok) { output.classList.remove("collapsed"); toggle.textContent = "Hide details"; }
      },
    };
  }

  /**
   * Runs a shell command in the shared folder and shows it as a job card.
   * @returns {Promise<{code: number, files: object[], output: string}>}
   */
  async function runJob(container, { title, script, needs = [], showOutput = false, doneText }) {
    const card = jobCard(title, { showOutput });
    container.prepend(card.el);
    let session = null;
    let stopped = false;
    card.stop.addEventListener("click", () => { stopped = true; if (session) session.close(); });
    try {
      if (needs.length) await ensureExtras(needs, card);
      const before = new Map((await listFiles(agent)).map(f => [f.name, `${f.size}:${f.mtime}`]));
      card.setStatus("Working…");
      let raw = "";
      session = agent.open({ script: `mkdir -p ${FILES_DIR} && cd ${FILES_DIR} && { ${script}\n}`, rows: 30, cols: 110 });
      session.onData = bytes => {
        raw = (raw + decoder.decode(bytes, { stream: true })).slice(-60000);
        const text = cleanOutput(raw);
        card.setOutput(text);
        const percents = text.match(/(\d{1,3}(?:\.\d+)?)%/g);
        if (percents) card.setProgress(parseFloat(percents[percents.length - 1]));
      };
      const code = await session.exited;
      const output = cleanOutput(raw);
      const files = (await listFiles(agent)).filter(f => before.get(f.name) !== `${f.size}:${f.mtime}` && !f.name.endsWith(".part"));
      if (stopped) card.finish(false, "Stopped.");
      else if (code !== 0) card.finish(false, (output.match(/ERROR:? (.*)/) || [])[1] || "That didn't work. Details below.");
      else card.finish(true, doneText || (files.length ? "Done." : "Finished."));
      for (const file of files) put(card.results, fileRow(file, { compact: true }));
      return { code, files, output };
    } catch (err) {
      card.finish(false, err.message || "That didn't work.");
      return { code: -1, files: [], output: "" };
    }
  }

  // ---------------------------------------------------------------- files

  /** One file with Save / Delete. Saving is two taps for big files: iOS only allows
   *  its share sheet to open directly from a tap, and fetching the file takes a while. */
  function fileRow(file, { compact = false, onPick = null, onChange = null } = {}) {
    const kind = fileKind(file.name);
    const save = h("button", { class: "btn slim primary", type: "button" }, "Save");
    let bytes = null;
    save.addEventListener("click", async () => {
      if (bytes) {
        const how = await saveToPhone(file.name, bytes);
        if (how === "downloaded") toast("Saved to your downloads");
        return;
      }
      save.disabled = true;
      try {
        bytes = await readFile(vm, file.path, (done, total) => {
          save.textContent = `${Math.round((done / (total || file.size || 1)) * 100)}%`;
        }, file.size);
      } catch (err) {
        toast(err.message);
        save.textContent = "Save";
        save.disabled = false;
        return;
      }
      save.disabled = false;
      if (canShareFiles(file.name)) {
        save.textContent = "Save now";
      } else {
        save.textContent = "Save";
        await saveToPhone(file.name, bytes);
        toast("Saved to your downloads");
      }
    });
    const row = h("div", { class: "file-row" },
      h("span", { class: `file-glyph ${kind}` }, KIND_GLYPH[kind]),
      h("div", { class: "row-main" }, h("span", {}, file.name), h("span", { class: "muted" }, formatBytes(file.size))),
      onPick ? h("button", { class: "btn slim", type: "button", onclick: () => onPick(file) }, "Use") : save,
      compact || onPick ? null : h("button", { class: "icon-btn", type: "button", "aria-label": `Delete ${file.name}`, html: ICONS.close, onclick: async () => {
        if (!await confirmSheet({ title: "Delete this file?", text: `${file.name} is removed from Dock. Copies saved to your phone are not affected.`, confirmLabel: "Delete", danger: true })) return;
        await deleteFile(agent, file.path);
        if (onChange) onChange();
      } }));
    return row;
  }

  /** "Add from phone" button; calls done(paths) after the upload. */
  function uploadButton(label, accept, done) {
    const input = h("input", { type: "file", accept: accept || "", multiple: true, hidden: true });
    const button = h("button", { class: "btn primary", type: "button", onclick: () => input.click() }, label);
    input.addEventListener("change", async () => {
      const picked = [...input.files];
      input.value = "";
      if (!picked.length) return;
      button.disabled = true;
      const paths = [];
      try {
        for (const [i, file] of picked.entries()) {
          const prefix = picked.length > 1 ? `${i + 1}/${picked.length} · ` : "";
          paths.push(await uploadFile(vm, file, FILES_DIR, (n, total) => { button.textContent = `${prefix}Copying ${Math.round((n / (total || 1)) * 100)}%`; }));
        }
      } catch (err) {
        toast(err.message || "Upload failed");
      }
      button.textContent = label;
      button.disabled = false;
      if (paths.length) done(paths);
    });
    return h("div", { class: "upload" }, input, button);
  }

  async function renderFiles() {
    const list = h("div", { class: "rows" }, h("div", { class: "row" }, h("span", { class: "muted" }, "Loading…")));
    const refresh = async () => {
      const files = await listFiles(agent);
      if (!alive || state.pane !== "files") return;
      list.textContent = "";
      if (!files.length) put(list, h("div", { class: "row" }, h("span", { class: "muted" }, "Nothing here yet. Add a file from your phone, or make one with the tool.")));
      for (const file of files) put(list, fileRow(file, { onChange: refresh }));
    };
    put(body, 
      h("p", { class: "ws-lead" }, "Files here are shared with every tool in Dock."),
      uploadButton("Add from phone", "", refresh),
      h("div", { class: "group", style: "margin-top:18px" }, list));
    refresh();
  }

  // ---------------------------------------------------------------- use

  function actionList(container, jobs, context) {
    const rows = h("div", { class: "rows" });
    for (const action of recipe.actions) {
      const values = {};
      const form = h("div", { class: "action-form", hidden: true });
      for (const field of action.fields || []) {
        values[field.name] = field.default || "";
        let control;
        if (field.type === "choice") {
          control = h("div", { class: "choices" }, field.options.map(([value, label]) => {
            const b = h("button", { type: "button", class: value === values[field.name] ? "on" : "" }, label);
            b.addEventListener("click", () => {
              values[field.name] = value;
              for (const sibling of control.children) sibling.classList.toggle("on", sibling === b);
            });
            return b;
          }));
        } else {
          control = h("input", { type: "text", value: values[field.name], placeholder: field.placeholder || "", inputmode: "text", autocapitalize: "off", autocorrect: "off" });
          control.addEventListener("input", () => { values[field.name] = control.value; });
        }
        put(form, h("label", { class: "field" }, h("span", {}, field.label), control));
      }
      if (action.slow) put(form, notice("warn", action.slow));
      put(form, h("button", { class: "btn primary", type: "button", onclick: () => {
        form.hidden = true;
        const ctxNow = context();
        if (!ctxNow) return;
        runJob(jobs, {
          title: action.label,
          script: action.command({ ...ctxNow, f: values }),
          needs: action.needs ? action.needs(values) : [],
        });
        jobs.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } }, action.label));
      const head = h("button", { class: "row action-row", type: "button", onclick: () => {
        const open = form.hidden;
        for (const other of rows.querySelectorAll(".action-form")) other.hidden = true;
        form.hidden = !open;
      } }, h("div", { class: "row-main" }, h("span", {}, action.label), h("span", { class: "muted" }, action.detail || "")), h("span", { class: "chev-text" }, "›"));
      put(rows, h("div", { class: "action" }, head, form));
    }
    put(container, rows);
  }

  // A tool that takes a link: search or paste, pick an item, choose what to do with it.
  function renderLinkRecipe() {
    const use = state.use;
    const input = h("input", { type: "search", placeholder: recipe.placeholder, enterkeyhint: "search", autocapitalize: "off", autocorrect: "off", spellcheck: "false", value: use.query || "" });
    const area = h("div", {});
    const jobs = h("div", { class: "jobs" });
    const form = h("form", { class: "addbar ws-search", onsubmit: e => { e.preventDefault(); go(input.value); } }, input,
      h("button", { type: "submit", class: "addbar-go", "aria-label": "Go", html: '<svg viewBox="0 0 24 24"><path d="M5 12h13m-5-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' }));
    put(body, 
      h("div", { class: "sites" }, h("span", { class: "muted" }, "Works with"),
        recipe.sites.map(site => h("span", { class: "tag" + (site.searchable ? " accent" : "") }, site.name)),
        recipe.sitesNote ? h("span", { class: "muted" }, recipe.sitesNote) : null),
      form, area, jobs,
      recipe.notice ? h("p", { class: "group-note", style: "margin-top:16px" }, recipe.notice) : null);

    const loading = text => { area.textContent = ""; put(area, h("div", { class: "ws-wait" }, h("div", { class: "spinner" }), h("p", { class: "muted" }, text))); };
    const thumb = item => {
      const box = h("div", { class: "thumb" }, item.duration ? h("span", { class: "thumb-time" }, formatDuration(item.duration)) : null);
      if (item.thumbnail) {
        const img = h("img", { src: item.thumbnail, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
        img.addEventListener("error", () => img.remove());
        box.prepend(img);
      }
      return box;
    };

    function showResults(items) {
      area.textContent = "";
      if (!items.length) return put(area, h("p", { class: "muted ws-lead" }, "Nothing found."));
      put(area, h("div", { class: "results" }, items.map(item =>
        h("button", { class: "result", type: "button", onclick: () => inspect(item.url, item) }, thumb(item),
          h("div", { class: "result-text" }, h("strong", {}, item.title), h("span", { class: "muted" }, [item.by, item.views ? `${Intl.NumberFormat("en", { notation: "compact" }).format(item.views)} views` : ""].filter(Boolean).join(" · ")))))));
    }

    function showItem(item) {
      use.item = item;
      area.textContent = "";
      const media = item.embed
        ? h("div", { class: "player" }, thumb(item), h("iframe", { src: item.embed, title: item.title, allow: "encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true, loading: "lazy", referrerpolicy: "strict-origin-when-cross-origin" }))
        : h("div", { class: "player" }, thumb(item));
      const actions = h("div", {});
      put(area, 
        use.results ? h("button", { class: "link", type: "button", onclick: () => { use.item = null; showResults(use.results); } }, "‹ Back to results") : null,
        media,
        h("h3", { class: "item-title" }, item.title),
        h("p", { class: "muted", style: "margin-bottom:14px" }, [item.by, item.site, item.duration ? formatDuration(item.duration) : ""].filter(Boolean).join(" · ")),
        h("div", { class: "section-head", style: "margin:0 2px 10px" }, h("h3", { style: "font-size:16px" }, `What ${app.name} can do with this`)),
        actions);
      actionList(actions, jobs, () => ({ url: item.url }));
    }

    async function inspect(url, known) {
      if (known) showItem({ ...known, embed: recipe.inspect.parse(JSON.stringify({ webpage_url: known.url, title: known.title }), known.url).embed, site: recipe.search.label });
      else loading("Reading that link… this takes about 20 seconds.");
      if (known) return; // search results already carry what the screen needs
      const { text } = await agent.capture(recipe.inspect.command(url));
      if (!alive) return;
      try {
        showItem(recipe.inspect.parse(text, url));
      } catch (err) {
        area.textContent = "";
        put(area, notice("block", err.message || "Couldn't read that link."));
      }
    }

    async function go(text) {
      const query = text.trim();
      if (!query) return;
      use.query = query;
      input.blur();
      if (recipe.isLink(query)) {
        use.results = null;
        return inspect(query);
      }
      loading(`Searching ${recipe.search.label}… this takes about 20 seconds.`);
      const { text: out } = await agent.capture(recipe.search.command(query));
      if (!alive) return;
      try {
        use.results = recipe.search.parse(out);
        showResults(use.results);
      } catch {
        area.textContent = "";
        put(area, notice("block", "The search didn't return anything. Check that Dock is online and try again."));
      }
    }

    if (use.item) showItem(use.item);
    else if (use.results) showResults(use.results);
  }

  // A tool that works on a file from the phone.
  function renderFileRecipe() {
    const use = state.use;
    const chosen = h("div", {});
    const actions = h("div", {});
    const jobs = h("div", { class: "jobs" });
    put(body, chosen, actions, jobs);

    async function pick(path) {
      use.file = path;
      const name = path.split("/").pop();
      actions.textContent = "";
      chosen.textContent = "";
      const summary = h("span", { class: "muted" }, "Reading…");
      put(chosen, h("div", { class: "picked" },
        h("span", { class: `file-glyph ${fileKind(name)}` }, KIND_GLYPH[fileKind(name)]),
        h("div", { class: "row-main" }, h("strong", {}, name), summary),
        h("button", { class: "link", type: "button", onclick: () => { use.file = null; choose(); } }, "Change")));
      actionList(actions, jobs, () => ({ file: use.file }));
      try {
        const info = recipe.inspect.parse((await agent.capture(recipe.inspect.command(path))).text);
        summary.textContent = [info.duration ? formatDuration(info.duration) : "", info.summary].filter(Boolean).join(" · ") || "Ready";
      } catch {
        summary.textContent = "Ready";
      }
    }

    async function choose() {
      chosen.textContent = "";
      actions.textContent = "";
      const list = h("div", { class: "rows" });
      put(chosen, 
        h("p", { class: "ws-lead" }, recipe.placeholder + "."),
        uploadButton("Choose from phone", recipe.accept, paths => pick(paths[0])),
        h("div", { class: "group", style: "margin-top:18px" }, h("h3", {}, "Already in Dock"), list));
      const files = (await listFiles(agent)).filter(f => ["video", "audio"].includes(fileKind(f.name)));
      if (!files.length) put(list, h("div", { class: "row" }, h("span", { class: "muted" }, "No video or audio files yet.")));
      for (const file of files) put(list, fileRow(file, { onPick: f => pick(f.path) }));
    }

    if (use.file) pick(use.file); else choose();
  }

  // Any other command-line tool: build the screen from its --help.
  async function renderAutoFeatures() {
    const use = state.use;
    const bins = app.bins && app.bins.length ? app.bins : app.launch && !app.launchLabel ? [app.launch] : [];
    if (!bins.length) {
      put(body, h("p", { class: "ws-lead" }, "This project didn't add a command Dock can make buttons for. You can still look through its files and run it yourself in the Terminal."),
        h("button", { class: "btn primary", type: "button", style: "width:100%", onclick: () => { close(); ctx.openTerminal(app); } }, "Open in Terminal"),
        ctx.settings.anthropicKey ? h("button", { class: "btn", type: "button", style: "width:100%;margin-top:10px", onclick: () => show("ai") }, "Ask AI") : null);
      return;
    }
    use.bin = use.bin || (bins.includes(app.launch) ? app.launch : bins[0]);
    use.chosen = use.chosen || new Map();
    const wait = h("div", { class: "ws-wait" }, h("div", { class: "spinner" }), h("p", { class: "muted" }, `Asking ${use.bin} what it can do…`));
    put(body, wait);
    if (!use.help || use.helpFor !== use.bin) {
      const { text } = await agent.capture(`${shellQuote(use.bin)} --help 2>&1 | head -c 80000 || ${shellQuote(use.bin)} -h 2>&1 | head -c 80000`);
      use.help = parseHelp(text);
      use.helpText = cleanOutput(text).trim();
      use.helpFor = use.bin;
    }
    if (!alive || state.pane !== "use") return;
    wait.remove();
    const { options, usage } = use.help;
    const jobs = h("div", { class: "jobs" });
    const extra = h("input", { type: "text", placeholder: usage ? usage.replace(/^\S+\s*/, "").slice(0, 60) || "text or arguments" : "text or arguments", value: use.extra || "", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
    extra.addEventListener("input", () => { use.extra = extra.value; });
    const fileLabel = h("span", { class: "muted" }, use.file ? use.file.split("/").pop() : "None");
    const count = h("span", { class: "muted" });
    const optionRows = h("div", { class: "rows options" });
    const filter = h("input", { type: "search", placeholder: `Search ${options.length} options`, autocapitalize: "off", autocorrect: "off" });

    const drawOptions = () => {
      const needle = filter.value.trim().toLowerCase();
      optionRows.textContent = "";
      const shown = options.filter(o => !needle || o.flag.includes(needle) || o.description.toLowerCase().includes(needle)).slice(0, needle ? 60 : 25);
      for (const option of shown) {
        const on = use.chosen.has(option.flag);
        const value = h("input", { type: "text", placeholder: option.arg || "", value: use.chosen.get(option.flag) || "", hidden: !(on && option.arg), autocapitalize: "off", autocorrect: "off" });
        value.addEventListener("input", () => use.chosen.set(option.flag, value.value));
        const toggle = h("button", { class: "switch" + (on ? " on" : ""), type: "button", role: "switch", "aria-checked": String(on), "aria-label": option.flag });
        toggle.addEventListener("click", () => {
          if (use.chosen.has(option.flag)) use.chosen.delete(option.flag); else use.chosen.set(option.flag, "");
          drawOptions();
        });
        put(optionRows, h("div", { class: "row option" }, h("div", { class: "row-main" }, h("span", { class: "mono" }, option.flag + (option.arg ? ` ${option.arg}` : "")), h("span", { class: "muted" }, option.description.slice(0, 140)), value), toggle));
      }
      if (!shown.length) put(optionRows, h("div", { class: "row" }, h("span", { class: "muted" }, options.length ? "No option matches." : "This tool didn't list its options in a form Dock can read. Type what you'd put after its name above.")));
      count.textContent = use.chosen.size ? `${use.chosen.size} on` : "";
    };
    filter.addEventListener("input", drawOptions);

    const pickFile = async () => {
      const files = await listFiles(agent);
      const sheetBody = h("div", { class: "rows" });
      const overlay = h("div", { class: "ws-pick" }, h("div", { class: "section-head" }, h("h3", {}, "Use a file"), h("button", { class: "link", type: "button", onclick: () => overlay.remove() }, "Cancel")),
        uploadButton("Add from phone", "", paths => { use.file = paths[0]; fileLabel.textContent = paths[0].split("/").pop(); overlay.remove(); }), sheetBody);
      put(sheetBody, h("button", { class: "row", type: "button", onclick: () => { use.file = null; fileLabel.textContent = "None"; overlay.remove(); } }, h("span", {}, "No file")));
      for (const file of files) put(sheetBody, fileRow(file, { onPick: f => { use.file = f.path; fileLabel.textContent = f.name; overlay.remove(); } }));
      body.prepend(overlay);
    };

    put(body, 
      bins.length > 1 ? h("div", { class: "choices", style: "margin-bottom:14px" }, bins.slice(0, 6).map(bin => h("button", { type: "button", class: bin === use.bin ? "on" : "", onclick: () => { use.bin = bin; use.chosen = new Map(); show("use"); } }, bin))) : null,
      h("div", { class: "rows", style: "margin-bottom:14px" },
        h("label", { class: "row" }, h("div", { class: "row-main" }, h("span", {}, `What to give ${use.bin}`), extra)),
        h("button", { class: "row", type: "button", onclick: pickFile }, h("div", { class: "row-main" }, h("span", {}, "File")), fileLabel, h("span", { class: "chev-text" }, "›"))),
      h("button", { class: "btn primary", type: "button", style: "width:100%;margin-bottom:16px", onclick: () => {
        const chosen = [...use.chosen].map(([flag, value]) => ({ flag, value }));
        runJob(jobs, { title: `${use.bin}`, script: buildCommand(use.bin, chosen, { extra: use.extra || "", file: use.file || "" }), showOutput: true, doneText: "Finished." });
      } }, `Run ${use.bin}`),
      jobs,
      h("div", { class: "section-head", style: "margin:18px 2px 10px" }, h("h3", { style: "font-size:16px" }, "Options"), count),
      options.length > 8 ? h("div", { class: "addbar ws-search", style: "margin-bottom:10px" }, filter) : null,
      optionRows,
      use.helpText ? h("details", { class: "help-text" }, h("summary", {}, "Full help text"), h("pre", {}, use.helpText.slice(0, 20000))) : null);
    drawOptions();
  }

  async function loadSkills() {
    if (state.skills) return state.skills;
    const { text } = await agent.capture(`cd /dock/apps/${app.id}/skills 2>/dev/null && for d in */; do n=\${d%/}; desc=$(sed -n 's/^description: *//p' "$n/SKILL.md" | head -1); printf '%s\\t%s\\n' "$n" "$desc"; done; true`);
    state.skills = text.split("\n").filter(Boolean).map(line => {
      const [name, description] = line.split("\t");
      return { name, description: (description || "").replace(/^["']|["']$/g, ""), path: `/dock/apps/${app.id}/skills/${name}` };
    });
    return state.skills;
  }

  async function renderSkills() {
    const list = h("div", { class: "rows" }, h("div", { class: "row" }, h("span", { class: "muted" }, "Loading…")));
    put(body, 
      h("p", { class: "ws-lead" }, ctx.settings.anthropicKey
        ? "Skills are instructions an AI follows to do a kind of task. Add your files, then tell Ask AI what you want and it uses these."
        : "Skills are instructions an AI follows to do a kind of task. On Dock they only do something through Ask AI, which needs an Anthropic API key (paid separately; Claude Pro doesn't cover it). You can still read each skill below."),
      ctx.settings.anthropicKey ? h("button", { class: "btn primary", type: "button", style: "width:100%;margin-bottom:18px", onclick: () => show("ai") }, "Ask AI to use these skills") : null,
      h("div", { class: "group" }, h("h3", {}, "Installed skills"), list));
    const skills = await loadSkills();
    if (!alive || state.pane !== "use") return;
    list.textContent = "";
    if (!skills.length) put(list, h("div", { class: "row" }, h("span", { class: "muted" }, "No skills were found in this repository.")));
    for (const skill of skills) {
      const detail = h("pre", { class: "job-output", hidden: true });
      put(list, h("div", { class: "action" },
        h("button", { class: "row", type: "button", onclick: async () => {
          detail.hidden = !detail.hidden;
          if (!detail.hidden && !detail.textContent) detail.textContent = (await agent.capture(`head -c 12000 ${shellQuote(skill.path + "/SKILL.md")}`)).text;
        } }, h("div", { class: "row-main" }, h("span", {}, skill.name), h("span", { class: "muted" }, skill.description.slice(0, 120))), h("span", { class: "chev-text" }, "›")),
        detail));
    }
  }

  function renderUse() {
    if (recipe && recipe.input === "link") return renderLinkRecipe();
    if (recipe && recipe.input === "file") return renderFileRecipe();
    if (app.kind === "skill") return renderSkills();
    if (app.kind === "web" && app.launch) {
      put(body, h("p", { class: "ws-lead" }, `${app.name} has its own web page. Dock starts it inside Linux and shows the page here.`),
        h("button", { class: "btn primary", type: "button", onclick: () => { close(); ctx.startWebApp(app); } }, "Start and open"));
      return;
    }
    return renderAutoFeatures();
  }

  // ---------------------------------------------------------------- ask AI

  function renderAi() {
    const key = ctx.settings.anthropicKey;
    if (!key) {
      const input = h("input", { type: "password", placeholder: "sk-ant-…", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
      body.classList.remove("chat");
      put(body, 
        h("p", { class: "ws-lead" }, `Optional. Describe what you want in plain words and an AI runs ${app.name} for you: it types the commands, reads the results and hands you the files.`),
        notice("info", "This needs an Anthropic API key, which is billed separately from a Claude Pro or Max subscription. Everything else in Dock works without it."),
        h("div", { class: "rows", style: "margin-bottom:12px" }, h("label", { class: "row" }, h("div", { class: "row-main" }, h("span", {}, "Anthropic API key"), h("span", { class: "muted" }, "Stored on this phone only. You pay Anthropic for what the AI uses."), input))),
        h("button", { class: "btn primary", type: "button", style: "width:100%", onclick: async () => {
          if (!input.value.trim()) return toast("Paste your API key first.");
          await ctx.saveSettings({ anthropicKey: input.value.trim() });
          show("ai");
        } }, "Turn on Ask AI"),
        h("p", { class: "group-note", style: "margin-top:12px" }, "Get a key at console.anthropic.com. What you type, the commands that run and their output are sent to Anthropic to produce the answers."));
      return;
    }
    const log = h("div", { class: "chat-log" });
    const input = h("textarea", { rows: "1", placeholder: `Ask ${app.name} to do something…`, autocapitalize: "sentences" });
    const send = h("button", { class: "addbar-go", type: "submit", "aria-label": "Send", html: '<svg viewBox="0 0 24 24"><path d="M12 19V6m-6 6 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' });
    const form = h("form", { class: "chat-bar" }, input, send);
    put(body, log, form);

    const draw = entry => {
      let el;
      if (entry.type === "user") el = h("div", { class: "bubble user" }, entry.text);
      else if (entry.type === "text") el = h("div", { class: "bubble ai" }, entry.text);
      else if (entry.type === "notice") el = h("div", { class: "chat-note" }, entry.text);
      else {
        const out = h("pre", { class: "job-output", hidden: true }, entry.output || "");
        const mark = h("span", { class: "cmd-mark" }, entry.code === undefined ? "…" : entry.code === 0 ? "✓" : "!");
        el = h("div", { class: "cmd" + (entry.code === undefined ? " running" : entry.code === 0 ? "" : " failed") },
          h("button", { type: "button", class: "cmd-head", onclick: () => { out.hidden = !out.hidden; } }, mark, h("code", {}, entry.command.split("\n")[0].slice(0, 200))), out);
        entry.el = { out, mark, root: el };
      }
      put(log, el);
      log.scrollTop = log.scrollHeight;
    };
    if (!state.chat.length) {
      put(log, h("div", { class: "chat-note" }, app.kind === "skill"
        ? "Add files in the Files tab, then say what you want made or changed."
        : `Say what you want ${app.name} to do. Files you add in the Files tab are available to it.`));
    }
    for (const entry of state.chat) draw(entry);

    const setBusy = busy => {
      send.innerHTML = busy
        ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M12 19V6m-6 6 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      send.setAttribute("aria-label", busy ? "Stop" : "Send");
    };
    const add = entry => { state.chat.push(entry); if (alive && state.pane === "ai") draw(entry); return entry; };

    async function ask(text) {
      if (!state.assistant) {
        const skills = app.kind === "skill" ? await loadSkills() : [];
        let endpoints;
        try { endpoints = JSON.parse(localStorage.getItem("dock.dev.anthropic") || "null"); } catch { endpoints = null; }
        state.assistant = new Assistant({
          apiKey: key,
          baseURL: endpoints ? endpoints.baseURL : undefined,
          system: buildSystemPrompt({ app, skills, commands: app.bins || [] }),
          runCommand: (command, signal) => new Promise(resolve => {
            const parts = [];
            const session = agent.open({ script: command, pty: false, cwd: FILES_DIR });
            session.onData = bytes => parts.push(decoder.decode(bytes, { stream: true }));
            signal.addEventListener("abort", () => session.close());
            session.exited.then(code => resolve({ code, text: cleanOutput(parts.join("")) }));
          }),
        });
        await agent.capture(`mkdir -p ${FILES_DIR}`);
      }
      add({ type: "user", text });
      setBusy(true);
      const running = new Map();
      try {
        await state.assistant.send(text, {
          text: t => add({ type: "text", text: t }),
          notice: t => add({ type: "notice", text: t }),
          command: c => running.set(c.id, add({ type: "command", command: c.command })),
          result: r => {
            const entry = running.get(r.id);
            if (!entry) return;
            entry.code = r.code;
            entry.output = r.text.slice(-4000);
            if (entry.el) {
              entry.el.out.textContent = entry.output;
              entry.el.mark.textContent = r.code === 0 ? "✓" : "!";
              entry.el.root.className = "cmd" + (r.code === 0 ? "" : " failed");
            }
          },
        });
      } catch (err) {
        add({ type: "notice", text: describeError(err) });
        if (/API key was not accepted/.test(describeError(err))) {
          await ctx.saveSettings({ anthropicKey: "" });
          state.assistant = null;
        }
      }
      for (const entry of running.values()) {
        if (entry.code === undefined) { entry.code = -1; if (entry.el) { entry.el.mark.textContent = "!"; entry.el.root.className = "cmd failed"; } }
      }
      setBusy(false);
    }

    form.addEventListener("submit", e => {
      e.preventDefault();
      if (state.assistant && state.assistant.busy) return state.assistant.stop();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      input.style.height = "";
      ask(text);
    });
    input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(120, input.scrollHeight)}px`; });
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); form.requestSubmit(); } });
    setBusy(!!(state.assistant && state.assistant.busy));
  }

  document.getElementById("app").append(view);
  show(state.pane);
  return { close, show };
}

/** Forget everything kept for an app (after it is removed). */
export function forgetWorkspace(id) {
  sessions.delete(id);
}
