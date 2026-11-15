// Terminal tabs: each one is an xterm.js screen attached to a session in the VM.

import { Terminal } from "../vendor/xterm.mjs";
import { FitAddon } from "../vendor/addon-fit.mjs";
import { h } from "./ui.js";

export const TERMINAL_THEME = {
  background: "#07080c", foreground: "#e6e8f0", cursor: "#8b7bff", cursorAccent: "#07080c",
  selectionBackground: "rgba(139,123,255,0.35)",
  black: "#1b1d27", red: "#ff6b7a", green: "#3ddc97", yellow: "#ffb84d", blue: "#6ea8ff",
  magenta: "#b99cff", cyan: "#4fc3ff", white: "#d7dae5",
  brightBlack: "#5c6175", brightRed: "#ff8b97", brightGreen: "#6ff0b6", brightYellow: "#ffd08a",
  brightBlue: "#93c0ff", brightMagenta: "#d0bbff", brightCyan: "#86d8ff", brightWhite: "#ffffff",
};

export function createScreen(container, { fontSize = 13, input = true } = {}) {
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
    fontSize, lineHeight: 1.15, cursorBlink: input, disableStdin: !input, scrollback: 4000,
    theme: TERMINAL_THEME, allowTransparency: true, macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  if (term.textarea) {
    for (const [k, v] of Object.entries({ autocapitalize: "off", autocorrect: "off", autocomplete: "off", spellcheck: "false" })) {
      term.textarea.setAttribute(k, v);
    }
  }
  const refit = () => {
    if (!container.offsetWidth || !container.offsetHeight) return false;
    try { fit.fit(); } catch { return false; }
    return true;
  };
  refit();
  return { term, refit };
}

const KEYS = [
  ["esc", "\x1b"], ["tab", "\t"], ["ctrl", null], ["^C", "\x03"], ["↑", "\x1b[A"], ["↓", "\x1b[B"],
  ["←", "\x1b[D"], ["→", "\x1b[C"], ["/", "/"], ["-", "-"], ["|", "|"], ["~", "~"], ["paste", "paste"],
];

export class TerminalManager {
  /**
   * @param {object} o
   * @param {HTMLElement} o.stack o.tabs o.keybar o.empty
   * @param {() => import("./agent.js").GuestAgent|null} o.getAgent
   */
  constructor(o) {
    this.o = o;
    this.tabs = [];
    this.activeId = null;
    this.nextId = 1;
    this.ctrl = false;
    this.buildKeybar();
  }

  buildKeybar() {
    for (const [label, seq] of KEYS) {
      const key = h("button", { class: "key", type: "button" }, label);
      // pointerdown + preventDefault keeps the on-screen keyboard up.
      key.addEventListener("pointerdown", async e => {
        e.preventDefault();
        const tab = this.active();
        if (label === "ctrl") {
          this.ctrl = !this.ctrl;
          key.classList.toggle("on", this.ctrl);
          this.ctrlKey = key;
          return;
        }
        if (!tab) return;
        if (seq === "paste") {
          try {
            const text = await navigator.clipboard.readText();
            if (text) tab.session.write(text);
          } catch { /* clipboard not permitted */ }
          return;
        }
        tab.session.write(seq);
      });
      this.o.keybar.append(key);
    }
  }

  active() { return this.tabs.find(t => t.id === this.activeId) || null; }

  /**
   * Opens a terminal tab.
   * @param {{title: string, script?: string, pretype?: string}} spec
   *   script: run this instead of an interactive shell. pretype: text typed at the prompt.
   */
  open(spec) {
    const agent = this.o.getAgent();
    if (!agent) return null;
    const pane = h("div", { class: "term-pane" });
    this.o.stack.append(pane);
    pane.classList.add("active"); // must be visible to measure
    const { term, refit } = createScreen(pane);
    const session = agent.open({ script: spec.script, rows: term.rows, cols: term.cols });
    const tab = { id: this.nextId++, title: spec.title, pane, term, refit, session, exited: false };
    session.onData = bytes => term.write(bytes);
    term.onData(data => {
      if (tab.exited) return;
      if (this.ctrl && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
        this.ctrl = false;
        if (this.ctrlKey) this.ctrlKey.classList.remove("on");
      }
      session.write(data);
    });
    term.onResize(({ rows, cols }) => session.resize(rows, cols));
    session.exited.then(code => {
      tab.exited = true;
      if (!spec.script && code === 0) return this.close(tab.id);
      term.write(`\r\n\x1b[38;5;245m[finished with exit code ${code}]\x1b[0m\r\n`);
      this.renderTabs();
    });
    if (spec.pretype) {
      // Wait for the shell prompt before typing.
      let typed = false;
      const original = session.onData;
      session.onData = bytes => {
        original(bytes);
        if (!typed && /[#$] $/.test(new TextDecoder().decode(bytes))) {
          typed = true;
          session.write(spec.pretype);
        }
      };
    }
    this.tabs.push(tab);
    this.select(tab.id);
    return tab;
  }

  select(id) {
    this.activeId = id;
    for (const tab of this.tabs) tab.pane.classList.toggle("active", tab.id === id);
    this.renderTabs();
    this.refit();
  }

  close(id) {
    const index = this.tabs.findIndex(t => t.id === id);
    if (index < 0) return;
    const [tab] = this.tabs.splice(index, 1);
    tab.session.close();
    tab.term.dispose();
    tab.pane.remove();
    if (this.activeId === id) {
      const next = this.tabs[Math.max(0, index - 1)];
      this.activeId = next ? next.id : null;
      if (next) next.pane.classList.add("active");
    }
    this.renderTabs();
    this.refit();
  }

  /** The VM went away: drop every tab. */
  reset() {
    for (const tab of [...this.tabs]) {
      tab.term.dispose();
      tab.pane.remove();
    }
    this.tabs = [];
    this.activeId = null;
    this.renderTabs();
  }

  renderTabs() {
    const bar = this.o.tabs;
    bar.textContent = "";
    for (const tab of this.tabs) {
      const el = h("div", { class: "term-tab" + (tab.id === this.activeId ? " active" : ""), role: "tab" },
        h("span", { onclick: () => this.select(tab.id) }, tab.title + (tab.exited ? " ✓" : "")),
        h("button", { class: "x", type: "button", "aria-label": `Close ${tab.title}`, onclick: () => this.close(tab.id) }, "×"));
      bar.append(el);
    }
    this.o.empty.hidden = this.tabs.length > 0;
  }

  refit() {
    const tab = this.active();
    if (tab) tab.refit();
  }

  focus() {
    const tab = this.active();
    if (tab) tab.term.focus();
  }
}
