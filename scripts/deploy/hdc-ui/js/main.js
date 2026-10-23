// Shell: router, visibility-aware generation polling, connection state,
// navigation counts and language (definition §9, §11).
import { get } from "./api.js";
import { setLanguage, t, language } from "./i18n.js";
import { el, icon, formatRelative, loadingCard } from "./ui.js";
import { render as renderOverview, renderDecisions } from "./views/overview.js";
import { renderHistory, renderHistoryDetail, renderTraceability, renderProjectState, renderDiagnostics, renderDecisionDetail } from "./views/history.js";
import { render as renderWorkspace, lastWorkspaceHash } from "./views/workspace.js";

const view = document.getElementById("view");
const main = document.getElementById("main");
const POLL_MS = 2000;
let lastGeneration = null;
let pollTimer = null;
let connState = "init";
let lastSync = null;
let renderToken = 0;
let navigated = false; // the first load keeps the browser's focus start (skip link first)
let appVersion = null;

const RECORD_ID = /^(DEC|APR|RSK)-\d{4}$/;

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [route, ...rest] = hash.split("/");
  return { route: route || "overview", arg: decodeURIComponent(rest.join("/")) };
}

function railRoute(route, arg) {
  if (route === "sessions") return "decisions";
  if (route === "decisions" && arg) return "decisions";
  return route;
}

/**
 * Render the current route. `soft` re-renders (projection changes) keep the
 * scroll position and focus; navigations move focus to the page title.
 */
async function renderRoute({ soft = false } = {}) {
  const token = ++renderToken;
  const { route, arg } = parseHash();
  const active = railRoute(route, arg);
  document.querySelectorAll(".rail-link").forEach((link) => {
    if (link.dataset.route === active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const scroll = window.scrollY;
  if (!soft) view.replaceChildren(loadingCard());
  // The route renders into a hidden container that is already in the document
  // (views such as the workspace rely on `isConnected` for draft autosave);
  // the previous content stays visible until the new one is complete.
  const target = el("div", { hidden: true });
  view.append(target);
  try {
    if (route === "overview") await renderOverview(target);
    else if (route === "decisions" && RECORD_ID.test(arg)) await renderDecisionDetail(target, arg);
    else if (route === "decisions") await renderDecisions(target, arg);
    else if (route === "history" && arg) await renderHistoryDetail(target, arg);
    else if (route === "history") await renderHistory(target);
    else if (route === "traceability") await renderTraceability(target, arg);
    else if (route === "project-state") await renderProjectState(target);
    else if (route === "diagnostics") await renderDiagnostics(target);
    else if (route === "sessions" && arg) await renderWorkspace(target, arg);
    else await renderOverview(target);
  } catch (error) {
    target.replaceChildren(el("p", { class: "field-error", role: "alert", text: error?.message || t("err_generic") }));
  }
  if (token !== renderToken) { target.remove(); return; } // a newer navigation won
  for (const child of [...view.childNodes]) if (child !== target) child.remove();
  target.replaceWith(...target.childNodes);
  const titleText = view.querySelector(".page-title")?.textContent?.trim();
  document.title = titleText ? `${titleText} · CanonFlow HDC` : "CanonFlow — Human Decision Console";
  if (soft) {
    window.scrollTo(0, scroll);
  } else {
    window.scrollTo(0, 0);
    // In-app navigations move focus to the new page title for screen readers.
    if (navigated) (view.querySelector(".page-title") ?? main).focus({ preventScroll: true });
    navigated = true;
  }
}

async function pollGeneration() {
  try {
    const payload = await get("/api/v1/ready");
    lastSync = new Date().toISOString();
    setConn(payload.stale ? "stale" : "ok");
    setWrites(payload.writes_enabled);
    updateGeneration(payload.generation);
    if (lastGeneration !== null && payload.generation !== lastGeneration) {
      refreshCounts();
      // §9/§11: a stable agent change is reflected in seconds — but an open
      // workspace whose QS content hash is unchanged must NOT be re-rendered
      // (in-progress answers are never wiped by an unrelated projection bump).
      const { route, arg } = parseHash();
      if (route === "sessions" && arg && lastWorkspaceHash()) {
        try {
          const detail = await get(`/api/v1/sessions/${encodeURIComponent(arg)}`);
          if (detail.qs_sha256 === lastWorkspaceHash()) {
            lastGeneration = payload.generation ?? null;
            return; // nothing relevant changed for this form
          }
        } catch (_error) { /* fall through to a full re-render */ }
      }
      lastGeneration = payload.generation ?? null;
      await renderRoute({ soft: true });
      return;
    }
    lastGeneration = payload.generation ?? null;
  } catch (_error) {
    setConn("down");
  }
  renderRailFoot();
}

function setConn(state) {
  if (state === connState) return;
  connState = state;
  const pill = document.getElementById("conn-status");
  pill.dataset.state = state;
  pill.querySelector(".status-text").textContent =
    state === "ok" ? t("conn_ok") : state === "stale" ? t("conn_stale") : state === "down" ? t("conn_down") : t("conn_init");
  pill.title = pill.querySelector(".status-text").textContent;
  renderBanner();
}

/**
 * Read-only service (writes_enabled=false): drafts and answers cannot be saved.
 * Exposed to views via html[data-writes] and the `hdc:writes` event so the
 * workspace can explain it before the human sends.
 */
function setWrites(enabled) {
  const value = enabled === false ? "false" : enabled === true ? "true" : "unknown";
  if (document.documentElement.dataset.writes === value) return;
  document.documentElement.dataset.writes = value;
  document.dispatchEvent(new CustomEvent("hdc:writes", { detail: value }));
  renderBanner();
}

function renderBanner() {
  const banner = document.getElementById("conn-banner");
  const blocks = [];
  if (connState === "down" || connState === "stale") {
    blocks.push(el("div", { class: `banner banner--${connState}`, role: connState === "down" ? "alert" : "status" },
      icon(connState === "down" ? "alert-circle" : "refresh"),
      el("span", { text: t(connState === "down" ? "banner_down" : "banner_stale") }),
      connState === "down" ? el("button", { class: "btn btn--sm", type: "button", onclick: () => pollGeneration() },
        icon("refresh"), t("retry")) : null));
  }
  if (connState !== "down" && document.documentElement.dataset.writes === "false") {
    blocks.push(el("div", { class: "banner banner--down", role: "alert" },
      icon("lock"), el("span", { text: t("banner_readonly") })));
  }
  banner.replaceChildren(...blocks);
  banner.hidden = blocks.length === 0;
}

function updateGeneration(generation) {
  const chip = document.getElementById("generation-chip");
  if (generation === undefined || generation === null) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.textContent = t("gen_label", { n: generation });
  chip.title = t("gen_title", { n: generation });
}

function renderRailFoot() {
  const foot = document.getElementById("rail-foot");
  if (!foot) return;
  foot.replaceChildren(el("dl", {},
    el("dt", { text: t("rail_version") }), el("dd", { text: appVersion ?? "—" }),
    el("dt", { text: t("rail_generation") }), el("dd", { text: lastGeneration ?? "—" }),
    el("dt", { text: t("rail_synced") }), el("dd", { text: lastSync ? formatRelative(lastSync) : "—" })));
}

async function refreshCounts() {
  try {
    const data = await get("/api/v1/project/overview");
    const counts = data.counts ?? {};
    setCount("decisions", counts.answerable, "");
    if (counts.blocks) setCount("diagnostics", counts.blocks, "block");
    else setCount("diagnostics", counts.warnings, "warn");
  } catch (_error) { /* counts are decorative; the views show their own errors */ }
}

function setCount(name, value, tone) {
  const badge = document.querySelector(`.rail-count[data-count="${name}"]`);
  if (!badge) return;
  if (!value) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.textContent = String(value);
  badge.className = `rail-count${tone ? ` rail-count--${tone}` : ""}`;
}

async function loadIdentity() {
  try {
    const version = await get("/api/v1/version");
    appVersion = version.app_version ?? null;
  } catch (_error) { appVersion = null; }
  try {
    const state = await get("/api/v1/project/state");
    const pointers = state.pointers ?? {};
    const method = Object.entries(pointers).find(([path, info]) => path.endsWith("method-state.yaml") && info.available);
    const project = method?.[1]?.document?.project;
    const label = document.getElementById("project-name");
    if (typeof project === "string" && project.trim()) {
      label.textContent = project;
      label.title = `${t("project_label")}: ${project}`;
      label.hidden = false;
    }
  } catch (_error) { /* the project label is optional chrome */ }
  renderRailFoot();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollGeneration, POLL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ------------------------------------------------------------------ language
function syncLanguageToggle(lang) {
  document.querySelectorAll(".lang-option").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
  });
}

document.addEventListener("hdc:language", (event) => {
  syncLanguageToggle(event.detail);
  const pill = document.getElementById("conn-status");
  const state = connState;
  connState = null;
  setConn(state);
  pill.dataset.state = state;
  updateGeneration(lastGeneration);
  renderRailFoot();
});

document.querySelectorAll(".lang-option").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.lang === language()) return;
    localStorage.setItem("hdc-lang", button.dataset.lang);
    setLanguage(button.dataset.lang);
    renderRoute({ soft: true });
  });
});

// ------------------------------------------------------------------ wiring
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else { lastGeneration = null; startPolling(); pollGeneration(); refreshCounts(); } // refresh on return
});

document.querySelector(".skip-link")?.addEventListener("click", (event) => {
  event.preventDefault(); // the hash is the router; never navigate to "#main"
  main.focus();
  main.scrollIntoView();
});

window.addEventListener("hashchange", () => renderRoute());

const savedLang = localStorage.getItem("hdc-lang");
setLanguage(savedLang === "es" || savedLang === "en" ? savedLang : "en");
startPolling();
pollGeneration();
refreshCounts();
loadIdentity();
renderRoute();
