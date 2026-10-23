// Overview + Decisions inbox (definition §11). Overview puts human needs first,
// separates service health from project integrity, links every indicator to
// its evidence and never turns missing data into zeros.
import { get } from "../api.js";
import { t } from "../i18n.js";
import {
  el, icon, card, callout, pageHeader, stateChip, riskChip, severityChip, idTag, hrefForId,
  emptyState, errorState, errorMessage, kv, timeTag, loopLabel, segmented, skeleton,
} from "../ui.js";

const LOOPS = [
  "functional_canon_loop", "technical_canon_loop", "implementation_loop",
  "drift_runtime_recovery_mode", "release_candidate", "cross_cutting",
];

function sessionTitle(session) {
  return session.title || session.session_label || session.question_session_id;
}

/**
 * §11: a PENDING session with a saved draft reads "In preparation". The list
 * API carries no draft flag, so pending rows ask their detail lazily.
 */
function preparingChip(session) {
  const chipNode = stateChip(session.effective_state);
  if (session.effective_state === "PENDING") {
    get(`/api/v1/sessions/${encodeURIComponent(session.question_session_id)}`)
      .then((detail) => { if (detail?.draft) chipNode.replaceWith(stateChip("PENDING", { preparing: true })); })
      .catch(() => { /* keep the plain state */ });
  }
  return chipNode;
}

/** One inbox row: the title link covers the row; chips sit on the right. */
function sessionItem(session, { cta = null, showAnswered = false } = {}) {
  const id = session.question_session_id;
  const diagnostics = session.diagnostic_ids?.length ?? 0;
  return el("li", { class: "item" },
    el("div", { class: "item-main" },
      el("a", { class: "item-title", href: `#/sessions/${id}`, text: sessionTitle(session) }),
      el("div", { class: "item-sub" },
        idTag(id),
        session.session_label && session.title ? el("span", { class: "truncate", text: session.session_label }) : null,
        el("span", { text: loopLabel(session.affected_loop) }),
        showAnswered && session.answered_at
          ? el("span", {}, `${t("col_answered")} `, timeTag(session.answered_at))
          : el("span", {}, `${t("col_date")} `, timeTag(session.generated_at)),
        diagnostics ? el("span", { class: "badge badge--warn", title: t("col_anomalies") }, icon("alert", { size: "sm" }), String(diagnostics)) : null)),
    el("div", { class: "item-aside" },
      riskChip(session.risk_tier),
      preparingChip(session),
      cta ? el("a", { class: "btn btn--primary btn--sm", href: `#/sessions/${id}`, tabindex: "-1", "aria-hidden": "true" }, cta, icon("arrow-right")) : icon("chevron-right")));
}

function kpi({ value, label, href, tone = "" }) {
  const known = value !== undefined && value !== null;
  return el("a", { class: ["kpi", known ? (value ? tone && `kpi--${tone}` : "") : "kpi--unknown"], href },
    el("span", { class: "kpi-value", text: known ? String(value) : t("none") }),
    el("span", { class: "kpi-label", text: label }));
}

export async function render(root) {
  root.append(pageHeader({ title: t("ov_title"), subtitle: t("ov_subtitle") }));
  let overview, answerable, waiting, ready, sessions;
  try {
    [overview, answerable, waiting, ready, sessions] = await Promise.all([
      get("/api/v1/project/overview"),
      get("/api/v1/sessions?condition=answerable&limit=100"),
      get("/api/v1/sessions?condition=waiting_agent&limit=20"),
      get("/api/v1/ready"),
      get("/api/v1/sessions?limit=100"),
    ]);
  } catch (error) {
    root.append(card({ title: t("ov_counts") }, errorState(errorMessage(error), {
      onRetry: () => { root.replaceChildren(); render(root); },
    })));
    return;
  }
  const counts = overview.counts ?? {};

  // 1 — human needs first
  const todo = answerable.sessions ?? [];
  const attention = card({
    title: t("ov_attention_title"), count: todo.length, id: "ov-attention",
    variant: ["flush", todo.length ? "accent" : ""],
    actions: todo.length ? [el("a", { class: "btn btn--ghost btn--sm", href: "#/decisions/answerable" }, t("view_all"), icon("chevron-right"))] : [],
  });
  if (!todo.length) {
    attention.append(emptyState(t("ov_attention_empty_text"), { title: t("ov_attention_empty_title"), iconName: "check-circle" }));
  } else {
    attention.append(el("ul", { class: "item-list" }, ...todo.map((session) => sessionItem(session, { cta: t("btn_answer") }))));
  }
  root.append(attention);

  const waitingRows = waiting.sessions ?? [];
  if (waitingRows.length) {
    root.append(card({ title: t("ov_waiting_title"), count: waitingRows.length, variant: "flush", sub: null },
      el("p", { class: "card-sub muted small", text: t("ov_waiting_text") }),
      el("ul", { class: "item-list" }, ...waitingRows.map((session) => sessionItem(session, { showAnswered: true })))));
  }

  // 2 — every indicator links to its evidence; unknown stays unknown
  root.append(card({ title: t("ov_counts") },
    el("div", { class: "kpis" },
      kpi({ value: counts.answerable, label: t("ov_answerable"), href: "#/decisions/answerable", tone: "attention" }),
      kpi({ value: counts.waiting_agent, label: t("ov_waiting"), href: "#/decisions/waiting_agent", tone: "attention" }),
      kpi({ value: counts.ingested, label: t("ov_ingested"), href: "#/history" }),
      kpi({ value: counts.archived, label: t("ov_archived"), href: "#/history" }),
      kpi({ value: counts.cancelled_expired, label: t("ov_closed"), href: "#/history" }),
      kpi({ value: counts.records, label: t("ov_records"), href: "#/history" }),
      kpi({ value: counts.blocks, label: t("ov_blocks"), href: "#/diagnostics", tone: "danger" }),
      kpi({ value: counts.warnings, label: t("ov_warnings"), href: "#/diagnostics", tone: "attention" }))));

  // 3 — service health is not project integrity
  const yesNo = (value) => (value === undefined || value === null ? t("unknown") : value ? t("yes") : t("no"));
  const blocks = counts.blocks;
  root.append(el("div", { class: "grid-2" },
    card({ title: t("ov_service_title") },
      kv([
        [t("dg_ready"), yesNo(ready.ready)],
        [t("dg_stale"), yesNo(ready.stale)],
        [t("dg_generation"), ready.generation ?? t("unknown")],
        [t("dg_write"), yesNo(ready.writes_enabled)],
      ])),
    card({ title: t("ov_integrity_title") },
      blocks === undefined || blocks === null
        ? callout("warn", {}, el("p", { text: t("unknown") }))
        : blocks
          ? callout("danger", {}, el("p", { text: t("ov_integrity_blocked") }))
          : callout("success", {}, el("p", { text: t("ov_integrity_clean") })),
      el("p", { class: "small muted", text: t("ov_note_health") }))));

  // 4 — recent sessions (titles joined from the session list)
  const byId = new Map((sessions.sessions ?? []).map((session) => [session.question_session_id, session]));
  const recent = overview.recent_sessions ?? [];
  const recentCard = card({ title: t("ov_recent"), variant: "flush",
    actions: [el("a", { class: "btn btn--ghost btn--sm", href: "#/decisions" }, t("view_all"), icon("chevron-right"))] });
  if (!recent.length) recentCard.append(emptyState(t("empty_sessions")));
  else {
    recentCard.append(el("ul", { class: "item-list" }, ...recent.map((row) => sessionItem(byId.get(row.qs_id) ?? {
      question_session_id: row.qs_id, effective_state: row.effective_state, generated_at: row.generated_at,
    }))));
  }
  root.append(recentCard);

  // 5 — notable diagnostics
  const diags = overview.notable_diagnostics ?? [];
  const diagCard = card({ title: t("ov_notable"), count: diags.length, variant: "flush",
    actions: [el("a", { class: "btn btn--ghost btn--sm", href: "#/diagnostics" }, t("view_all"), icon("chevron-right"))] });
  if (!diags.length) diagCard.append(emptyState(t("empty_diags"), { iconName: "check-circle" }));
  else {
    diagCard.append(el("ul", { class: "item-list" }, ...diags.map((diag) => el("li", { class: "item" },
      el("div", { class: "item-main" },
        el("div", { class: "cluster" }, severityChip(diag.severity, { size: "sm" }), el("code", { class: "small strong", text: diag.code })),
        el("div", { class: "item-sub" }, el("span", { text: diag.message }))),
      el("div", { class: "item-aside" }, diag.scope ? idTag(diag.scope, hrefForId(diag.scope)) : null)))));
  }
  root.append(diagCard);
}

const CONDITIONS = [
  ["", "cond_all"],
  ["answerable", "filter_answerable"],
  ["waiting_agent", "filter_waiting"],
  ["blocked", "cond_blocked"],
];

export async function renderDecisions(root, initialCondition = "") {
  const filters = {
    condition: CONDITIONS.some(([value]) => value === initialCondition) ? initialCondition : "",
    q: "",
    risk: "",
    loop: "",
  };
  root.append(pageHeader({ crumbs: [], title: t("dec_title"), subtitle: t("dec_subtitle") }));

  let counts = {};
  try { counts = (await get("/api/v1/project/overview")).counts ?? {}; } catch (_error) { counts = {}; }
  const countFor = { answerable: counts.answerable, waiting_agent: counts.waiting_agent };

  const search = el("input", {
    class: "input", type: "search", placeholder: t("search_placeholder"), "aria-label": t("search_label"),
    maxlength: "200", autocomplete: "off",
  });
  const riskSelect = el("select", { class: "select input--sm", "aria-label": t("col_risk") },
    el("option", { value: "", text: t("filter_risk_any") }),
    ...[0, 1, 2, 3, 4].map((tier) => el("option", { value: String(tier), text: `T${tier} · ${t(`risk_${tier}`)}` })));
  const loopSelect = el("select", { class: "select input--sm", "aria-label": t("col_loop") },
    el("option", { value: "", text: t("filter_loop_any") }),
    ...LOOPS.map((loop) => el("option", { value: loop, text: loopLabel(loop) })));
  const conditionControl = segmented({
    label: t("col_state"),
    value: filters.condition,
    options: CONDITIONS.map(([value, key]) => [value, t(key),
      countFor[value] ? el("span", { class: "badge badge--warn", text: String(countFor[value]) }) : null]),
    onChange: (value) => {
      filters.condition = value;
      history.replaceState(null, "", value ? `#/decisions/${value}` : "#/decisions");
      load();
    },
  });

  const results = el("div", {});
  const countLabel = el("span", { class: "count" });
  const listCard = card({ variant: "flush" },
    el("div", { class: "inbox-controls" },
      conditionControl,
      el("div", { class: "toolbar toolbar--filters" },
        el("div", { class: "search" }, icon("search"), search), riskSelect, loopSelect)),
    el("div", { class: "results-meta small muted", role: "status", "aria-live": "polite" }, countLabel),
    results);
  root.append(listCard);

  let timer = null;
  let token = 0;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { filters.q = search.value.trim(); load(); }, 250);
  });
  riskSelect.addEventListener("change", () => { filters.risk = riskSelect.value; load(); });
  loopSelect.addEventListener("change", () => { filters.loop = loopSelect.value; load(); });

  async function load() {
    const mine = ++token;
    results.replaceChildren(el("div", { class: "pad" }, skeleton({ lines: 3 })));
    const params = new URLSearchParams({ limit: "100" });
    if (filters.condition) params.set("condition", filters.condition);
    if (filters.q) params.set("q", filters.q);
    if (filters.risk) params.set("risk_tier", filters.risk);
    if (filters.loop) params.set("loop", filters.loop);
    let payload;
    try {
      payload = await get(`/api/v1/sessions?${params}`);
    } catch (error) {
      if (mine !== token) return;
      results.replaceChildren(el("div", { class: "pad" }, errorState(errorMessage(error), { onRetry: load })));
      countLabel.textContent = "";
      return;
    }
    if (mine !== token) return;
    const sessions = payload.sessions ?? [];
    countLabel.textContent = t("results_count", { n: payload.total ?? sessions.length });
    if (!sessions.length) {
      results.replaceChildren(emptyState(t("empty_sessions_hint"), { title: t("empty_sessions"), iconName: "search" }));
      return;
    }
    results.replaceChildren(el("ul", { class: "item-list" }, ...sessions.map((session) => sessionItem(session, {
      cta: session.can_answer ? t("btn_answer") : null,
      showAnswered: Boolean(session.answered_at),
    }))));
  }
  await load();
}
