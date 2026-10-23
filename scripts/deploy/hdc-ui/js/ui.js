// Shared DOM helpers and components for all views (design system in css/app.css).
// Governed content is always rendered as text: no helper accepts raw HTML.
import { t, has, language } from "./i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = Array.isArray(value) ? value.filter(Boolean).join(" ") : value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.textContent = ""; // governed content is never raw HTML
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
}

export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

// ------------------------------------------------------------------ icons
const ICONS = {
  check: [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]],
  "check-circle": [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M8 12.5l2.8 2.8L16.5 9.5" }]],
  circle: [["circle", { cx: 12, cy: 12, r: 8.5 }]],
  "circle-dashed": [["circle", { cx: 12, cy: 12, r: 8.5, "stroke-dasharray": "3 3" }]],
  alert: [["path", { d: "M12 3.8l9 15.7H3z" }], ["path", { d: "M12 10v4.2" }], ["path", { d: "M12 17.2v.1" }]],
  "alert-circle": [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 7.5v5.5" }], ["path", { d: "M12 16.4v.1" }]],
  info: [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M12 11v5.5" }], ["path", { d: "M12 7.6v.1" }]],
  x: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
  "chevron-right": [["path", { d: "M9.5 6l6 6-6 6" }]],
  "chevron-left": [["path", { d: "M14.5 6l-6 6 6 6" }]],
  "chevron-down": [["path", { d: "M6 9.5l6 6 6-6" }]],
  "arrow-up": [["path", { d: "M12 19V5M6.5 10.5L12 5l5.5 5.5" }]],
  "arrow-down": [["path", { d: "M12 5v14M6.5 13.5L12 19l5.5-5.5" }]],
  "arrow-right": [["path", { d: "M5 12h14M13.5 6.5L19 12l-5.5 5.5" }]],
  copy: [["rect", { x: 8.5, y: 8.5, width: 11, height: 11, rx: 2 }], ["path", { d: "M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" }]],
  search: [["circle", { cx: 11, cy: 11, r: 6.5 }], ["path", { d: "M16 16l4 4" }]],
  file: [["path", { d: "M7 3.5h7l4.5 4.5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z" }], ["path", { d: "M14 3.5V8h4.5" }]],
  clock: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 7.5V12l3 2" }]],
  lock: [["rect", { x: 5, y: 10.5, width: 14, height: 9.5, rx: 2 }], ["path", { d: "M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" }]],
  user: [["circle", { cx: 12, cy: 8.5, r: 3.5 }], ["path", { d: "M5 19.5a7 7 0 0 1 14 0" }]],
  shield: [["path", { d: "M12 3.5l7 3v5.2c0 4.3-3 7.6-7 8.8-4-1.2-7-4.5-7-8.8V6.5z" }]],
  inbox: [["path", { d: "M3.5 13.5l2.6-7.2A2 2 0 0 1 8 5h8a2 2 0 0 1 1.9 1.3l2.6 7.2V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z" }], ["path", { d: "M3.5 13.5h4.6l1.4 2.5h5l1.4-2.5h4.6" }]],
  refresh: [["path", { d: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3" }], ["path", { d: "M19.5 4.5v4h-4" }]],
  external: [["path", { d: "M13.5 4.5h6v6" }], ["path", { d: "M19.5 4.5l-8 8" }], ["path", { d: "M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4" }]],
  link: [["path", { d: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" }], ["path", { d: "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" }]],
  star: [["path", { d: "M12 4.5l2.3 4.7 5.2.8-3.8 3.6.9 5.1L12 16.3l-4.6 2.4.9-5.1-3.8-3.6 5.2-.8z" }]],
  send: [["path", { d: "M4.5 11.8L19.5 4.5l-4.3 15-3.4-6.2z" }], ["path", { d: "M11.8 13.3l7.7-8.8" }]],
  edit: [["path", { d: "M4.5 19.5l1-4L15.8 5.2a2 2 0 0 1 2.9 2.9L8.5 18.5z" }]],
  grid: [["rect", { x: 3.5, y: 3.5, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 13.5, y: 3.5, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 3.5, y: 13.5, width: 7, height: 7, rx: 1.5 }], ["rect", { x: 13.5, y: 13.5, width: 7, height: 7, rx: 1.5 }]],
  graph: [["circle", { cx: 6, cy: 6, r: 2.5 }], ["circle", { cx: 18, cy: 6, r: 2.5 }], ["circle", { cx: 12, cy: 18, r: 2.5 }], ["path", { d: "M8.5 6h7M7.3 8.2l3.5 7.6M16.7 8.2l-3.5 7.6" }]],
  layers: [["path", { d: "M12 3.5l8.5 4.5-8.5 4.5L3.5 8z" }], ["path", { d: "M3.5 12.5l8.5 4.5 8.5-4.5" }], ["path", { d: "M3.5 16.5l8.5 4.5 8.5-4.5" }]],
  activity: [["path", { d: "M3 12h4l2.5-6 5 12 2.5-6h4" }]],
  history: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 7.5V12l3 2" }]],
  list: [["path", { d: "M9 6.5h11M9 12h11M9 17.5h11" }], ["path", { d: "M4.5 6.5h.1M4.5 12h.1M4.5 17.5h.1" }]],
};

export function icon(name, { size, label } = {}) {
  const node = svgEl("svg", {
    class: ["icon", size ? `icon--${size}` : ""].filter(Boolean).join(" "),
    viewBox: "0 0 24 24", "aria-hidden": label ? null : "true", focusable: "false",
    role: label ? "img" : null, "aria-label": label ?? null,
  });
  for (const [tag, attrs] of ICONS[name] ?? ICONS.circle) node.append(svgEl(tag, attrs));
  return node;
}

// ------------------------------------------------------------------ chips
export function chip(text, { variant = "", size = "", dot = false, title = null } = {}) {
  return el("span", { class: ["chip", variant && `chip--${variant}`, size && `chip--${size}`], title },
    dot ? el("span", { class: "chip-dot", "aria-hidden": "true" }) : null, text);
}

export function stateChip(state, { preparing = false, size = "" } = {}) {
  const key = preparing && state === "PENDING" ? "PREPARING" : state;
  const label = t(`st_${key}`);
  return chip(label === `st_${key}` ? String(state ?? "—") : label, { variant: `state-${key}`, dot: true, size });
}

export function riskChip(tier, { size = "", short = false } = {}) {
  const value = Number.isInteger(tier) ? tier : null;
  if (value === null) return chip("T?", { variant: "outline", size, title: t("unknown") });
  const text = short ? `T${value}` : `T${value} · ${t(`risk_${value}`)}`;
  return chip(text, { variant: `risk-${value}`, size, title: t("risk_title", { n: value }) });
}

export function kindChip(kind, { size = "" } = {}) {
  return chip(t(`kind_${kind}`) === `kind_${kind}` ? String(kind ?? "—") : t(`kind_${kind}`), { variant: `kind-${kind}`, size });
}

export function severityChip(severity, { size = "" } = {}) {
  return chip(t(`sev_${severity}`) === `sev_${severity}` ? String(severity ?? "—") : t(`sev_${severity}`), { variant: `diag-${severity}`, size, dot: true });
}

export function idTag(id, href = null) {
  if (!id) return el("span", { class: "subtle", text: "—" });
  return href ? el("a", { class: "id", href, text: id }) : el("span", { class: "id", text: id });
}

/** Route for any governed ID: sessions open the workspace, records their detail. */
export function hrefForId(id) {
  if (/^QS-\d{4}$/.test(id ?? "")) return `#/sessions/${id}`;
  if (/^(DEC|APR|RSK)-\d{4}$/.test(id ?? "")) return `#/decisions/${id}`;
  return `#/traceability/${encodeURIComponent(id ?? "")}`;
}

// ------------------------------------------------------------------ layout
export function pageHeader({ crumbs = [], title, subtitle = null, meta = [], actions = [] }) {
  const h1 = el("h1", { class: "page-title", tabindex: "-1" }, title);
  const nav = crumbs.length ? el("nav", { class: "breadcrumbs", "aria-label": "Breadcrumb" },
    el("ol", {}, ...crumbs.map(([label, href], index) => el("li", {},
      href && index < crumbs.length - 1 ? el("a", { href, text: label })
        : el("span", { "aria-current": index === crumbs.length - 1 ? "page" : null, text: label }))))) : null;
  const metaNodes = meta.filter(Boolean);
  return el("header", { class: "page-header" },
    nav,
    el("div", { class: "page-title-row" }, h1,
      actions.filter(Boolean).length ? el("div", { class: "page-actions" }, ...actions) : null),
    subtitle ? el("p", { class: "page-subtitle", text: subtitle }) : null,
    metaNodes.length ? el("div", { class: "page-meta" }, ...metaNodes) : null);
}

/**
 * Card / section. Options: title, num (section number), count, sub, actions,
 * id, variant (flush|sunken|accent|attention), headingLevel (default 2).
 */
export function card(options = {}, ...children) {
  const { title = null, num = null, count = null, sub = null, actions = [], id = null, variant = "", headingLevel = 2, labelledby = true } = options;
  const headingId = id ? `${id}-title` : null;
  const variants = (Array.isArray(variant) ? variant : [variant]).filter(Boolean).map((v) => `card--${v}`);
  const heading = title ? el(`h${headingLevel}`, { class: "card-title", id: headingId },
    num !== null ? el("span", { class: "section-num", "aria-hidden": "true", text: String(num) }) : null,
    num !== null ? el("span", { class: "sr-only", text: `${num}. ` }) : null,
    title,
    count !== null && count !== undefined ? el("span", { class: "count", text: `(${count})` }) : null) : null;
  const header = heading || actions.length ? el("div", { class: "card-header" }, heading,
    actions.filter(Boolean).length ? el("div", { class: "card-actions" }, ...actions) : null) : null;
  return el("section", { class: ["card", ...variants], id, "aria-labelledby": headingId && heading && labelledby ? headingId : null },
    header, sub ? el("p", { class: "card-sub", text: sub }) : null, ...children);
}

export function callout(tone, { title = null, iconName = null } = {}, ...body) {
  const icons = { info: "info", warn: "alert", rec: "star", danger: "alert-circle", success: "check-circle" };
  return el("div", { class: `callout callout--${tone}`, role: tone === "danger" ? "alert" : null },
    icon(iconName ?? icons[tone] ?? "info"),
    el("div", { class: "callout-body" },
      title ? el("div", { class: "callout-title", text: title }) : null, ...body));
}

export function metaGrid(pairs) {
  return el("dl", { class: "meta-grid" },
    ...pairs.filter(Boolean).map(([label, value]) => el("div", {},
      el("dt", {}, label),
      el("dd", {}, value === null || value === undefined || value === "" ? t("none") : value))));
}

export function kv(pairs) {
  return el("dl", { class: "kv" },
    ...pairs.filter(Boolean).flatMap(([label, value]) => [
      el("dt", {}, label),
      el("dd", {}, value === null || value === undefined || value === "" ? t("none") : value),
    ]));
}

export function emptyState(message, { title = null, iconName = "inbox", compact = false } = {}) {
  return el("div", { class: ["empty", compact && "empty--compact"] },
    compact ? null : icon(iconName),
    title ? el("div", { class: "empty-title", text: title }) : null,
    message ? el("div", { class: "empty-text", text: message }) : null);
}

/** Error panel; when onRetry is given a retry button is rendered. */
export function errorState(message, { onRetry = null, title = null } = {}) {
  return el("div", { class: "error-panel" },
    callout("danger", { title }, el("p", { text: message || t("err_generic") })),
    onRetry ? el("button", { class: "btn btn--sm", type: "button", onclick: onRetry }, icon("refresh"), t("retry")) : null);
}

export function errorMessage(error) {
  if (!error) return t("err_generic");
  // A code-specific explanation (e.g. err_WRITES_DISABLED) is complete on its own.
  if (error.code && has(`err_${error.code}`)) return t(`err_${error.code}`);
  const known = error.status ? t(`err_${error.status}`) : null;
  const base = known && known !== `err_${error.status}` ? known : t("err_generic");
  return error.message && error.message !== base ? `${base} (${error.message})` : base;
}

export function skeleton({ blocks = 0, lines = 3 } = {}) {
  return el("div", { class: "skeleton", "aria-busy": "true", "aria-label": t("loading") },
    ...Array.from({ length: blocks }, () => el("div", { class: "skeleton-block" })),
    ...Array.from({ length: lines }, () => el("div", { class: "skeleton-line" })));
}

export function loadingCard() {
  return el("div", { class: "page-loading", role: "status" },
    el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text: t("loading") }));
}

export function disclosure(summary, body, { open = false, plain = false } = {}) {
  const details = el("details", { class: ["disclosure", plain && "disclosure--plain"] },
    el("summary", {}, summary), el("div", { class: "disclosure-body" }, body));
  details.open = open;
  return details;
}

export function codeBlock(text) {
  return el("pre", { class: "code-block", tabindex: "0", text });
}

export function progressBar(value, max, label) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  const bar = el("div", { class: "progress-bar" });
  bar.style.width = `${pct}%`; // CSSOM, allowed by the CSP (no inline style attribute)
  return el("div", { class: "progress", role: "progressbar", "aria-valuemin": "0",
    "aria-valuemax": String(max), "aria-valuenow": String(value), "aria-label": label ?? null }, bar);
}

export function setProgress(node, value, max) {
  if (!node) return;
  node.setAttribute("aria-valuemax", String(max));
  node.setAttribute("aria-valuenow", String(value));
  const bar = node.querySelector(".progress-bar");
  if (bar) bar.style.width = `${max > 0 ? Math.round((value / max) * 100) : 0}%`;
}

/** Segmented control (single choice, aria-pressed buttons). */
export function segmented({ label, options, value, onChange }) {
  const group = el("div", { class: "segmented", role: "group", "aria-label": label });
  const buttons = options.map(([optionValue, optionLabel, extra]) => {
    const button = el("button", { type: "button", "aria-pressed": String(optionValue === value) }, optionLabel, extra ?? null);
    button.addEventListener("click", () => {
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
      onChange(optionValue);
    });
    return button;
  });
  group.append(...buttons);
  return group;
}

export function copyButton(text, { label = null, size = "sm" } = {}) {
  const button = el("button", { class: ["btn", "btn--ghost", size && `btn--${size}`], type: "button" },
    icon("copy"), label ?? t("copy"));
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("copied"));
      announce(`${t("copied")}: ${text}`);
    } catch (_error) {
      toast(t("copy_failed"), { tone: "error" });
    }
  });
  return button;
}

// ------------------------------------------------------------ announcements
export function announce(message) {
  const box = document.getElementById("announcer");
  if (!box) return;
  box.textContent = "";
  setTimeout(() => { box.textContent = message; }, 30);
}

export function toast(message, { tone = "ok", timeout = 3600 } = {}) {
  const region = document.getElementById("toasts");
  if (!region) return;
  const node = el("div", { class: ["toast", tone === "error" && "toast--error"], role: tone === "error" ? "alert" : "status" },
    icon(tone === "error" ? "alert-circle" : "check-circle"), el("span", { text: message }));
  region.append(node);
  setTimeout(() => node.remove(), timeout);
}

// ------------------------------------------------------------------- dates
const MONTHS = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  es: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"],
};

function parseDate(value) {
  if (!value || typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Absolute UTC timestamp, e.g. "21 Oct 2026, 18:54 UTC". Unparseable values are shown verbatim. */
export function formatDate(value) {
  const date = parseDate(value);
  if (!date) return value ? String(value) : t("none");
  const pad = (n) => String(n).padStart(2, "0");
  const month = MONTHS[language()][date.getUTCMonth()];
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function formatRelative(value) {
  const date = parseDate(value);
  if (!date) return t("none");
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return t("rel_now");
  if (seconds < 3600) return t("rel_min", { n: Math.max(1, Math.round(seconds / 60)) });
  if (seconds < 86400) return t("rel_hour", { n: Math.round(seconds / 3600) });
  if (seconds < 86400 * 14) return t("rel_day", { n: Math.round(seconds / 86400) });
  return formatDate(value);
}

/** <time> showing the relative time, with the absolute UTC value as tooltip. */
export function timeTag(value) {
  if (!parseDate(value)) return el("span", { class: "subtle", text: value ? String(value) : t("none") });
  return el("time", { datetime: value, title: formatDate(value), text: formatRelative(value) });
}

// ------------------------------------------------------------------ labels
export function loopLabel(loop) {
  if (!loop) return t("none");
  const label = t(`loop_${loop}`);
  return label === `loop_${loop}` ? loop : label;
}

export function typeLabel(type) {
  const label = t(`type_${type}`);
  return label === `type_${type}` ? String(type ?? "") : label;
}

export function artifactPath(path) {
  return String(path ?? "").split("/").map(encodeURIComponent).join("/");
}
