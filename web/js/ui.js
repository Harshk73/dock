// Small DOM helpers shared by the views.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "html") el.innerHTML = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

const svg = (paths, attrs = "") => `<svg viewBox="0 0 24 24" aria-hidden="true" ${attrs}>${paths}</svg>`;
export const ICONS = {
  terminal: svg('<path d="m6 8 4 4-4 4M12.5 16H18"/>'),
  web: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.8 2.6 14.2 0 17M12 3.500c-2.6 2.8-2.6 14.2 0 17"/>'),
  skill: svg('<path d="M12 3.500l2.2 5.3 5.3 2.2-5.3 2.200L12 18.500l-2.2-5.300L4.5 11l5.3-2.200z"/>'),
  mcp: svg('<path d="M9 3.500v5M15 3.500v5M6.5 8.500h11v3a5.5 5.5 0 0 1-11 0zM12 17v3.5"/>'),
  source: svg('<path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5"/>'),
  warn: svg('<path d="M12 4 2.8 19.500h18.400zM12 10v4.500M12 17.300v.2"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.500M12 7.500v.2"/>'),
  check: svg('<path d="m5 12.5 4.5 4.500L19 7.5"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  reload: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.300M19.5 4.500v4h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'),
};

function hash(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) n = (n * 31 + text.charCodeAt(i)) >>> 0;
  return n;
}

/** The rounded app icon: the owner's GitHub avatar over a generated gradient. */
export function appIcon(app) {
  const hue = hash(app.id) % 360;
  const el = h("div", { class: "tile-icon", style: `background: linear-gradient(140deg, hsl(${hue} 72% 58%), hsl(${(hue + 55) % 360} 70% 42%))` },
    (app.name || app.repo || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "?");
  if (app.owner) {
    const img = h("img", { src: `https://github.com/${encodeURIComponent(app.owner)}.png?size=128`, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.remove());
    el.append(img);
  }
  const kindIcon = { web: ICONS.web, skill: ICONS.skill, mcp: ICONS.mcp, source: ICONS.source }[app.kind] || ICONS.terminal;
  el.append(h("span", { class: "tile-badge", html: kindIcon }));
  return el;
}

const sheetRoot = () => document.getElementById("sheet-root");

/**
 * Bottom sheet. Returns {el, body, foot, close(), closed: Promise}.
 * @param {{full?: boolean, dismissible?: boolean, onClose?: () => void}} [options]
 */
export function openSheet(options = {}) {
  const dismissible = options.dismissible !== false;
  const body = h("div", { class: "sheet-body" });
  const foot = h("div", { class: "sheet-foot" });
  const grab = h("div", { class: "sheet-grab" });
  const sheet = h("div", { class: "sheet" + (options.full ? " full" : ""), role: "dialog", "aria-modal": "true" }, grab, body, foot);
  const backdrop = h("div", { class: "sheet-backdrop" }, sheet);
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let isClosed = false;
  const close = () => {
    if (isClosed) return;
    isClosed = true;
    backdrop.classList.remove("open");
    setTimeout(() => backdrop.remove(), 320);
    if (options.onClose) options.onClose();
    resolveClosed();
  };
  backdrop.addEventListener("click", e => { if (e.target === backdrop && dismissible) close(); });

  // Drag the handle down to dismiss.
  let startY = null;
  grab.addEventListener("pointerdown", e => { startY = e.clientY; grab.setPointerCapture(e.pointerId); });
  grab.addEventListener("pointermove", e => {
    if (startY === null) return;
    sheet.style.transition = "none";
    sheet.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
  });
  grab.addEventListener("pointerup", e => {
    if (startY === null) return;
    const moved = e.clientY - startY;
    startY = null;
    sheet.style.transition = "";
    sheet.style.transform = "";
    if (moved > 90 && dismissible) close();
  });

  sheetRoot().append(backdrop);
  requestAnimationFrame(() => requestAnimationFrame(() => backdrop.classList.add("open")));
  return { el: sheet, body, foot, close, closed };
}

export function toast(text, ms = 2600) {
  const el = h("div", { class: "toast" }, text);
  document.getElementById("toast-root").append(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, ms);
}

/** Resolves true if the user confirms. */
export function confirmSheet({ title, text, confirmLabel = "Continue", danger = false }) {
  return new Promise(resolve => {
    let answer = false;
    const sheet = openSheet({ onClose: () => resolve(answer) });
    sheet.body.append(h("h2", { style: "margin: 6px 0 8px" }, title), h("p", { class: "desc" }, text));
    sheet.foot.append(
      h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Cancel"),
      h("button", { class: "btn " + (danger ? "danger" : "primary"), type: "button", onclick: () => { answer = true; sheet.close(); } }, confirmLabel),
    );
  });
}

export function notice(level, text) {
  return h("div", { class: "notice " + (level === "block" ? "block" : level === "info" ? "info" : "") },
    h("span", { html: level === "info" ? ICONS.info : ICONS.warn }), h("span", {}, text));
}

export function formatBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + " GB";
  if (n >= 1e6) return Math.round(n / 1e6) + " MB";
  return Math.max(0, Math.round(n / 1e3)) + " KB";
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
