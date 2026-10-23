// History (read-only detail), decision records, Traceability, Project state and
// Diagnostics (definition §8, §11). Human acceptance, ingestion and effects on
// artifacts are shown as distinct events; options are "rejected" only when a
// record declares it; links are labelled declared/inferred.
import { get } from "../api.js";
import { t } from "../i18n.js";
import {
  el, svgEl, icon, card, callout, pageHeader, stateChip, riskChip, kindChip, severityChip, chip,
  idTag, hrefForId, emptyState, errorState, errorMessage, metaGrid, kv, timeTag, formatDate,
  loopLabel, disclosure, codeBlock, copyButton, segmented, artifactPath,
} from "../ui.js";

const ID_PATTERN = /^[A-Z]{2,4}-\d{4}$/;
const recordCache = new Map();

async function artifactJson(path) {
  if (!path) return null;
  try {
    const artifact = await get(`/api/v1/artifacts/${artifactPath(path)}`);
    return JSON.parse(artifact.content);
  } catch (_error) {
    return null;
  }
}

async function recordDoc(recordId, recordPath) {
  const path = recordPath ?? `.canonflow/decision-records/${recordId}.json`;
  if (recordCache.has(path)) return recordCache.get(path);
  const doc = await artifactJson(path);
  if (doc) recordCache.set(path, doc); // records are immutable artifacts
  return doc;
}

function sessionTitle(session) {
  return session.title || session.session_label || session.question_session_id;
}

function failure(root, title, error, retry) {
  root.append(card({ title }, errorState(errorMessage(error), { onRetry: retry })));
}

/** Renders an ID as a link when it is a governed ID, otherwise as plain text. */
function idOrText(value) {
  const text = String(value ?? "");
  const match = text.match(/^([A-Z]{2,4}-\d{4})\b(.*)$/s);
  if (match && ID_PATTERN.test(match[1])) {
    // Only HDC-inventoried IDs are navigable; canon/drift IDs stay text (§11).
    const navigable = /^(QS|ANS|DEC|APR|RSK)-/.test(match[1]);
    return el("span", {}, idTag(match[1], navigable ? hrefForId(match[1]) : null), match[2] ? el("span", { text: match[2] }) : null);
  }
  return el("span", { text });
}

// ================================================================== history
export async function renderHistory(root) {
  root.append(pageHeader({ title: t("hist_title"), subtitle: t("hist_subtitle") }));
  let sessions, decisions;
  try {
    [sessions, decisions] = await Promise.all([get("/api/v1/sessions?limit=100"), get("/api/v1/decisions?limit=100")]);
  } catch (error) {
    failure(root, t("hist_title"), error, () => { root.replaceChildren(); renderHistory(root); });
    return;
  }
  const rows = sessions.sessions ?? [];
  const sessionsCard = card({ title: t("hist_sessions"), count: rows.length, variant: "flush" });
  if (!rows.length) sessionsCard.append(emptyState(t("empty_sessions")));
  else {
    const tbody = el("tbody", {});
    for (const session of rows) {
      const id = session.question_session_id;
      const href = `#/history/${id}`;
      const tr = el("tr", { class: "is-clickable" },
        el("td", {},
          el("div", { class: "cell-title" }, el("a", { href, text: sessionTitle(session) })),
          el("div", { class: "cluster small muted" }, idTag(id), session.session_label && session.title ? el("span", { class: "truncate", text: session.session_label }) : null)),
        el("td", {}, stateChip(session.effective_state, { size: "sm" })),
        el("td", {}, riskChip(session.risk_tier, { short: true, size: "sm" })),
        el("td", { class: "num" }, String(session.record_ids?.length ?? 0)),
        el("td", { class: "nowrap" }, timeTag(session.generated_at)),
        el("td", { class: "nowrap" }, session.answered_at ? timeTag(session.answered_at) : el("span", { class: "subtle", text: t("none") })));
      tr.addEventListener("click", (event) => { if (!event.target.closest("a")) location.hash = href; });
      tbody.append(tr);
    }
    sessionsCard.append(el("div", { class: "table-wrap" }, el("table", { class: "table" },
      el("thead", {}, el("tr", {},
        el("th", { scope: "col", text: t("col_session") }), el("th", { scope: "col", text: t("col_state") }),
        el("th", { scope: "col", text: t("col_risk") }), el("th", { scope: "col", class: "num", text: t("col_records") }),
        el("th", { scope: "col", text: t("col_date") }), el("th", { scope: "col", text: t("col_answered") }))),
      tbody)));
  }
  root.append(sessionsCard);

  const records = decisions.decisions ?? [];
  const recordsCard = card({ title: t("rec_list"), count: records.length, variant: "flush" });
  if (!records.length) recordsCard.append(emptyState(t("empty_decisions")));
  else {
    const tbody = el("tbody", {});
    for (const record of records) {
      const href = `#/decisions/${record.record_id}`;
      const titleCell = el("span", { class: "subtle", text: t("loading") });
      const tr = el("tr", { class: "is-clickable" },
        el("td", { class: "nowrap" }, idTag(record.record_id, href)),
        el("td", {}, el("div", { class: "cell-title" }, titleCell), el("div", { class: "small muted", text: record.source ?? "" })),
        el("td", {}, kindChip(record.kind, { size: "sm" })),
        el("td", { class: "nowrap" }, record.owner ?? t("none")),
        el("td", { class: "nowrap" }, timeTag(record.decided_at)));
      tr.addEventListener("click", (event) => { if (!event.target.closest("a")) location.hash = href; });
      tbody.append(tr);
      recordDoc(record.record_id, record.record_path).then((doc) => {
        titleCell.className = "";
        titleCell.textContent = doc?.title ?? record.record_id;
      });
    }
    recordsCard.append(el("div", { class: "table-wrap" }, el("table", { class: "table" },
      el("thead", {}, el("tr", {},
        el("th", { scope: "col", text: "ID" }), el("th", { scope: "col", text: t("rec_decision") }),
        el("th", { scope: "col", text: t("col_kind") }),
        el("th", { scope: "col", text: t("rec_owner") }), el("th", { scope: "col", text: t("rec_decided_at") }))),
      tbody)));
  }
  root.append(recordsCard);
}

function lifecycleTimeline(session, answers) {
  const items = [];
  items.push(el("li", { class: "timeline-item", "data-tone": "rec" },
    el("span", { class: "timeline-dot", "aria-hidden": "true" }),
    el("div", { class: "timeline-title" }, t("hist_ev_generated"), idTag(session.question_session_id)),
    el("div", { class: "timeline-meta", text: formatDate(session.generated_at) })));
  if (session.answered_at || session.answer_session_id) {
    items.push(el("li", { class: "timeline-item", "data-tone": "info" },
      el("span", { class: "timeline-dot", "aria-hidden": "true" }),
      el("div", { class: "timeline-title" }, t("hist_ev_answered"), session.answer_session_id ? idTag(session.answer_session_id) : null),
      el("div", { class: "timeline-meta", text: [
        formatDate(session.answered_at),
        answers?.answered_by ? t("hist_by", { actor: answers.answered_by }) : null,
      ].filter(Boolean).join(" · ") })));
  }
  const tones = { INGESTED: "seal", ARCHIVED: "muted", CANCELLED: "danger", EXPIRED: "danger" };
  for (const event of [...(session.events ?? [])].sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const label = t(`hist_ev_${event.state}`);
    items.push(el("li", { class: "timeline-item", "data-tone": tones[event.state] ?? "muted" },
      el("span", { class: "timeline-dot", "aria-hidden": "true" }),
      el("div", { class: "timeline-title" }, label === `hist_ev_${event.state}` ? event.state : label),
      el("div", { class: "timeline-meta", text: [formatDate(event.at), event.actor ? t("hist_by", { actor: event.actor }) : null].filter(Boolean).join(" · ") }),
      event.reason ? el("div", { class: "timeline-meta", text: event.reason }) : null));
  }
  return el("ol", { class: "timeline" }, ...items);
}

export async function renderHistoryDetail(root, qsId) {
  let session;
  try {
    session = await get(`/api/v1/sessions/${encodeURIComponent(qsId)}`);
  } catch (error) {
    root.append(pageHeader({ crumbs: [[t("hist_title"), "#/history"], [qsId, null]], title: qsId }));
    failure(root, t("hist_title"), error, () => { root.replaceChildren(); renderHistoryDetail(root, qsId); });
    return;
  }
  const [qsDoc, answers, trace] = await Promise.all([
    artifactJson(session.qs_path),
    session.answers_path ? artifactJson(session.answers_path) : Promise.resolve(null),
    get(`/api/v1/traceability?${new URLSearchParams({ node: qsId, direction: "both", depth: "1" })}`).catch(() => null),
  ]);
  const records = session.records ?? [];
  const docs = await Promise.all(records.map((record) => recordDoc(record.record_id, record.record_path)));

  root.append(pageHeader({
    crumbs: [[t("hist_title"), "#/history"], [qsId, null]],
    title: sessionTitle(session),
    subtitle: session.title ? session.session_label : null,
    meta: [idTag(qsId), stateChip(session.effective_state), riskChip(session.risk_tier),
      el("span", { text: loopLabel(session.affected_loop) })],
    actions: [
      el("a", { class: "btn btn--primary btn--sm", href: `#/sessions/${qsId}` }, icon("file"), t("hist_open_answers")),
      el("a", { class: "btn btn--sm", href: `#/traceability/${qsId}` }, icon("graph"), t("rec_open_trace")),
    ],
  }));

  const main = el("div", { class: "stack" });
  const aside = el("div", { class: "stack" });
  root.append(el("div", { class: "detail-layout" }, main, aside));

  main.append(card({ title: t("sec1") },
    qsDoc?.intervention_reason ? el("p", { class: "prose", text: qsDoc.intervention_reason }) : null,
    qsDoc?.decision_impact ? callout("info", { title: t("sec2") }, el("p", { class: "prose", text: qsDoc.decision_impact })) : null,
    metaGrid([
      [t("col_state"), stateChip(session.effective_state, { size: "sm" })],
      [t("col_evidence"), session.evidence_status],
      [t("col_loop"), loopLabel(session.affected_loop)],
      [t("col_date"), formatDate(session.generated_at)],
      [t("col_answered"), session.answered_at ? formatDate(session.answered_at) : null],
      [t("col_questions"), qsDoc?.questions?.length ?? null],
    ])));

  const recordsCard = card({ title: t("hist_records"), count: records.length, variant: "flush" });
  if (!records.length) recordsCard.append(emptyState(null, { title: t("empty_decisions"), compact: false }));
  else {
    recordsCard.append(el("ul", { class: "item-list" }, ...records.map((record, index) => el("li", { class: "item" },
      el("div", { class: "item-main" },
        el("a", { class: "item-title", href: `#/decisions/${record.record_id}`, text: docs[index]?.title ?? record.record_id }),
        el("div", { class: "item-sub" }, idTag(record.record_id), el("span", { text: record.source ?? "" }), timeTag(record.decided_at))),
      el("div", { class: "item-aside" }, kindChip(record.kind, { size: "sm" }), icon("chevron-right"))))));
  }
  main.append(recordsCard);

  const rejected = records.flatMap((record, index) => (docs[index]?.options_rejected ?? record.options_rejected ?? [])
    .map((option) => ({ record: record.record_id, option })));
  const rejectedCard = card({ title: t("hist_rejected"), count: rejected.length });
  rejectedCard.append(el("p", { class: "small muted", text: t("hist_rejected_note") }));
  if (!rejected.length) rejectedCard.append(emptyState(t("none"), { compact: true }));
  else {
    rejectedCard.append(el("ul", { class: "plain-list" }, ...rejected.map(({ record, option }) => el("li", {},
      idTag(record, `#/decisions/${record}`), el("span", { text: option })))));
  }
  main.append(rejectedCard);

  const artifacts = session.artifacts ?? [];
  const artifactsCard = card({ title: t("hist_artifacts"), count: artifacts.length, variant: "flush" });
  if (!artifacts.length) artifactsCard.append(emptyState(t("none"), { compact: true }));
  else {
    artifactsCard.append(el("div", { class: "table-wrap" }, el("table", { class: "table" },
      el("thead", {}, el("tr", {},
        el("th", { scope: "col", text: t("approval_path") }), el("th", { scope: "col", text: t("col_profile") }),
        el("th", { scope: "col", text: t("approval_hash") }))),
      el("tbody", {}, ...artifacts.map((artifact) => el("tr", {},
        el("td", {}, el("div", { class: "path", text: artifact.relative_path }),
          el("div", { class: "cluster xsmall" }, chip(artifact.kind ?? "", { size: "sm", variant: "outline" }),
            artifact.valid === false ? chip(t("hist_invalid"), { size: "sm", variant: "diag-BLOCK" }) : chip(t("hist_valid"), { size: "sm", variant: "kind-decision" }))),
        el("td", { class: "nowrap small", text: artifact.profile ?? t("none") }),
        el("td", {}, el("span", { class: "hash", title: artifact.sha256, text: `${String(artifact.sha256 ?? "").slice(0, 12)}…` }),
          artifact.sha256 ? copyButton(artifact.sha256, { label: t("copy") }) : null)))))));
  }
  main.append(artifactsCard);

  aside.append(card({ title: t("hist_events") }, lifecycleTimeline(session, answers)));

  const edges = trace?.edges ?? [];
  const relations = card({ title: t("hist_relations"), count: edges.length,
    actions: [el("a", { class: "btn btn--ghost btn--sm", href: `#/traceability/${qsId}` }, t("rec_open_trace"), icon("chevron-right"))] });
  if (!edges.length) relations.append(emptyState(t("trace_no_edges"), { compact: true }));
  else relations.append(edgeList(edges, qsId));
  aside.append(relations);

  if (session.diagnostics?.length) {
    aside.append(card({ title: t("col_anomalies"), count: session.diagnostics.length },
      el("ul", { class: "plain-list" }, ...session.diagnostics.map((diag) => el("li", {},
        el("div", { class: "cluster" }, severityChip(diag.severity, { size: "sm" }), el("code", { class: "small", text: diag.code })),
        el("div", { class: "small muted", text: diag.message }))))));
  }
}

function edgeList(edges, center) {
  return el("ul", { class: "edge-list" }, ...edges.map((edge) => {
    const outgoing = edge.from === center;
    const other = outgoing ? edge.to : edge.from;
    return el("li", {},
      el("span", { class: "edge-dir", title: outgoing ? t("rec_out") : t("rec_in") }, icon(outgoing ? "arrow-right" : "chevron-left", { size: "sm" })),
      el("code", { class: "edge-type", text: edge.type }),
      idTag(other, hrefForId(other)),
      el("span", { class: "subtle xsmall" }, isDeclared(edge) ? t("trace_declared") : t("trace_inferred")));
  }));
}

function isDeclared(edge) {
  return !edge.source || String(edge.source).endsWith("links.yaml");
}

// ============================================================ record detail
export async function renderDecisionDetail(root, recordId) {
  let detail;
  try {
    detail = await get(`/api/v1/decisions/${encodeURIComponent(recordId)}`);
  } catch (error) {
    root.append(pageHeader({ crumbs: [[t("hist_title"), "#/history"], [recordId, null]], title: recordId }));
    failure(root, t("rec_title"), error, () => { root.replaceChildren(); renderDecisionDetail(root, recordId); });
    return;
  }
  const doc = await recordDoc(recordId, detail.record_path);
  const sourceQs = doc?.source_ref?.question_session_id ?? String(detail.source ?? "").match(/QS-\d{4}/)?.[0] ?? null;

  root.append(pageHeader({
    crumbs: [[t("hist_title"), "#/history"], sourceQs ? [sourceQs, `#/history/${sourceQs}`] : null, [recordId, null]].filter(Boolean),
    title: doc?.title ?? recordId,
    meta: [idTag(recordId), kindChip(detail.kind), el("span", { class: "cluster" }, icon("user", { size: "sm" }), detail.owner ?? t("unknown")),
      el("span", {}, `${t("rec_decided_at")} `, timeTag(detail.decided_at))],
    actions: [el("a", { class: "btn btn--sm", href: `#/traceability/${recordId}` }, icon("graph"), t("rec_open_trace"))],
  }));

  const main = el("div", { class: "stack" });
  const aside = el("div", { class: "stack" });
  root.append(el("div", { class: "detail-layout" }, main, aside));

  if (!doc) main.append(callout("warn", {}, el("p", { text: t("rec_unreadable") })));
  main.append(card({ title: t("rec_decision"), variant: "accent" },
    el("p", { class: "prose prose-lg", text: doc?.decision ?? t("not_available") })));
  if (doc?.comment) {
    main.append(card({ title: t("rec_comment") }, el("blockquote", { class: "quote prose", text: doc.comment })));
  }
  const rejected = doc?.options_rejected ?? [];
  main.append(card({ title: t("rec_options_rejected"), count: rejected.length },
    rejected.length ? el("ul", { class: "plain-list" }, ...rejected.map((option) => el("li", { text: option })))
      : emptyState(t("hist_rejected_note"), { compact: true })));
  const affected = doc?.affected_items ?? [];
  main.append(card({ title: t("rec_affected"), count: affected.length },
    affected.length ? el("ul", { class: "plain-list" }, ...affected.map((item) => el("li", {}, idOrText(item))))
      : emptyState(t("none"), { compact: true })));

  const binding = doc?.artifact_binding;
  aside.append(card({ title: t("rec_title") }, kv([
    [t("rec_owner"), detail.owner],
    [t("rec_decided_at"), formatDate(detail.decided_at)],
    [t("rec_source"), doc?.source ?? detail.source],
    sourceQs ? [t("rec_source_session"), idTag(sourceQs, `#/history/${sourceQs}`)] : null,
    doc?.source_ref?.answer_session_id ? ["ANS", idTag(doc.source_ref.answer_session_id)] : null,
    detail.approved_artifact || doc?.artifact_ref ? [t("rec_artifact"), detail.approved_artifact || doc.artifact_ref] : null,
    [t("rec_expiry"), doc?.expiry || detail.expiry || null],
    [t("col_schema"), doc?.schema_version ? `v${doc.schema_version}` : t("none")],
    [t("rec_file"), el("span", { class: "path small", text: detail.record_path ?? t("none") })],
  ]),
  binding ? el("div", { class: "binding" },
    el("div", { class: "binding-title", text: t("approval_binding") }),
    el("div", { class: "path", text: binding.path }),
    el("div", { class: "cluster" }, el("span", { class: "hash", text: binding.sha256 }), copyButton(binding.sha256))) : null,
  ));

  const edgesOut = detail.edges_out ?? [];
  const edgesIn = detail.edges_in ?? [];
  aside.append(card({ title: t("rec_relations"), count: edgesOut.length + edgesIn.length },
    edgesOut.length + edgesIn.length
      ? edgeList([...edgesOut.map((edge) => ({ ...edge, from: edge.from ?? recordId })), ...edgesIn.map((edge) => ({ ...edge, to: edge.to ?? recordId }))], recordId)
      : emptyState(t("trace_no_edges"), { compact: true })));
}

// ============================================================= traceability
export async function renderTraceability(root, initialNode) {
  root.append(pageHeader({ title: t("trace_title"), subtitle: t("trace_subtitle") }));
  const state = { node: (initialNode ?? "").trim(), direction: "both", depth: "1" };

  const known = el("datalist", { id: "trace-ids" });
  Promise.all([get("/api/v1/sessions?limit=100").catch(() => null), get("/api/v1/decisions?limit=100").catch(() => null)])
    .then(([sessions, decisions]) => {
      const ids = new Set();
      for (const session of sessions?.sessions ?? []) {
        ids.add(session.question_session_id);
        if (session.answer_session_id) ids.add(session.answer_session_id);
      }
      for (const record of decisions?.decisions ?? []) ids.add(record.record_id);
      known.replaceChildren(...[...ids].sort().map((id) => el("option", { value: id })));
    });

  const nodeInput = el("input", { class: "input input--mono", id: "trace-node", type: "text", list: "trace-ids",
    placeholder: t("trace_node_placeholder"), autocomplete: "off", spellcheck: "false" });
  nodeInput.value = state.node;
  const depth = el("select", { class: "select", id: "trace-depth" }, ...["1", "2", "3"].map((d) => el("option", { value: d, text: d })));
  const direction = segmented({ label: t("trace_direction"), value: state.direction,
    options: [["both", t("dir_both")], ["in", t("dir_in")], ["out", t("dir_out")]],
    onChange: (value) => { state.direction = value; if (state.node) load(); } });
  const form = el("form", { class: "trace-form" },
    el("div", { class: "field trace-node" }, el("label", { class: "field-label", for: "trace-node", text: t("trace_node") }), nodeInput, known),
    el("div", { class: "field" }, el("span", { class: "field-label", text: t("trace_direction") }), direction),
    el("div", { class: "field" }, el("label", { class: "field-label", for: "trace-depth", text: t("trace_depth") }), depth),
    el("button", { class: "btn btn--primary", type: "submit" }, icon("search"), t("trace_go")));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    state.node = nodeInput.value.trim().toUpperCase();
    nodeInput.value = state.node;
    history.replaceState(null, "", state.node ? `#/traceability/${encodeURIComponent(state.node)}` : "#/traceability");
    load();
  });
  depth.addEventListener("change", () => { state.depth = depth.value; if (state.node) load(); });
  root.append(card({}, form));

  const results = el("div", { class: "stack", "aria-live": "polite" });
  root.append(results);

  const recenter = (id) => {
    state.node = id;
    nodeInput.value = id;
    history.replaceState(null, "", `#/traceability/${encodeURIComponent(id)}`);
    load();
  };

  async function load() {
    if (!state.node) {
      results.replaceChildren(card({}, emptyState(t("empty_graph"), { iconName: "graph" })));
      return;
    }
    results.replaceChildren(card({}, el("div", { class: "page-loading" }, el("span", { class: "spinner", "aria-hidden": "true" }), t("loading"))));
    const params = new URLSearchParams({ node: state.node, direction: state.direction, depth: state.depth });
    let data;
    try {
      data = await get(`/api/v1/traceability?${params}`);
    } catch (error) {
      results.replaceChildren(card({}, errorState(errorMessage(error), { onRetry: load })));
      return;
    }
    const edges = data.edges ?? [];
    const nodes = data.nodes ?? [];
    const blocks = [];
    if (data.truncated) {
      blocks.push(callout("warn", {}, el("p", {}, t("trace_truncated"), " ",
        data.continue_from ? el("button", { class: "btn btn--sm", type: "button", onclick: () => recenter(data.continue_from) }, data.continue_from) : null)));
    }
    if (!edges.length) {
      blocks.push(card({}, emptyState(t("trace_no_edges"), { title: state.node, iconName: "graph" })));
      results.replaceChildren(...blocks);
      return;
    }
    blocks.push(card({ title: t("trace_graph"), sub: t("trace_graph_hint") },
      buildGraph(nodes, edges, state.node, recenter),
      graphLegend()));
    const tbody = el("tbody", {}, ...edges.map((edge) => el("tr", {},
      el("td", {}, linkNode(edge.from, recenter)),
      el("td", {}, el("code", { class: "small strong", text: edge.type }), " ",
        chip(isDeclared(edge) ? t("trace_declared") : t("trace_inferred"), { size: "sm", variant: isDeclared(edge) ? "kind-decision" : "rec" })),
      el("td", {}, linkNode(edge.to, recenter)),
      el("td", { class: "small" }, edge.by ?? t("none")),
      el("td", { class: "nowrap small" }, formatDate(edge.at)))));
    blocks.push(card({ title: t("trace_edges"), count: edges.length, variant: "flush" },
      el("div", { class: "table-wrap" }, el("table", { class: "table" },
        el("thead", {}, el("tr", {},
          el("th", { scope: "col", text: t("trace_from") }), el("th", { scope: "col", text: t("trace_type") }),
          el("th", { scope: "col", text: t("trace_to") }), el("th", { scope: "col", text: t("trace_by") }),
          el("th", { scope: "col", text: t("trace_at") }))),
        tbody))));
    results.replaceChildren(...blocks);
  }

  await load();
}

function linkNode(id, recenter) {
  return el("span", { class: "cluster" },
    el("button", { class: "btn btn--ghost btn--sm mono", type: "button", title: t("trace_graph_hint"), onclick: () => recenter(id) }, id),
    ID_PATTERN.test(id) && !/^ANS-/.test(id) ? el("a", { class: "subtle", href: hrefForId(id), title: t("open"), "aria-label": `${t("open")} ${id}` }, icon("external", { size: "sm" })) : null);
}

function graphLegend() {
  return el("div", { class: "graph-legend" },
    el("span", {}, el("span", { class: "legend-node legend-node--QS" }), t("trace_legend_qs")),
    el("span", {}, el("span", { class: "legend-node legend-node--ANS" }), t("trace_legend_ans")),
    el("span", {}, el("span", { class: "legend-node legend-node--REC" }), t("trace_legend_rec")),
    el("span", {}, el("span", { class: "legend-swatch" }), t("trace_declared")),
    el("span", {}, el("span", { class: "legend-swatch legend-swatch--inferred" }), t("trace_inferred")));
}

/** Concentric layout: BFS distance from the centre node defines the ring. */
function buildGraph(nodes, edges, center, recenter) {
  const all = new Set([center, ...nodes, ...edges.flatMap((edge) => [edge.from, edge.to])]);
  const adjacency = new Map([...all].map((id) => [id, new Set()]));
  for (const edge of edges) { adjacency.get(edge.from).add(edge.to); adjacency.get(edge.to).add(edge.from); }
  const level = new Map([[center, 0]]);
  const queue = [center];
  while (queue.length) {
    const id = queue.shift();
    for (const next of adjacency.get(id) ?? []) if (!level.has(next)) { level.set(next, level.get(id) + 1); queue.push(next); }
  }
  for (const id of all) if (!level.has(id)) level.set(id, 1);
  const rings = new Map();
  for (const [id, depth] of level) { if (!rings.has(depth)) rings.set(depth, []); rings.get(depth).push(id); }
  const maxLevel = Math.max(...rings.keys());
  const ringGap = 130;
  const nodeW = 92;
  const nodeH = 30;
  const radiusFor = (depth) => {
    const count = rings.get(depth)?.length ?? 1;
    return Math.max(depth * ringGap, (count * (nodeW + 16)) / (2 * Math.PI));
  };
  const outer = radiusFor(maxLevel) || ringGap;
  const width = Math.max(640, 2 * outer + nodeW + 80);
  const height = Math.max(320, 2 * outer + nodeH + 80);
  const cx = width / 2;
  const cy = height / 2;
  const pos = new Map();
  for (const [depth, ids] of rings) {
    ids.sort();
    if (depth === 0) { pos.set(ids[0], [cx, cy]); continue; }
    const radius = radiusFor(depth);
    ids.forEach((id, index) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / ids.length + (depth % 2 ? 0 : Math.PI / ids.length);
      pos.set(id, [cx + radius * Math.cos(angle), cy + radius * 0.82 * Math.sin(angle)]);
    });
  }
  const svg = svgEl("svg", { class: "graph", viewBox: `0 0 ${Math.round(width)} ${Math.round(height)}`, role: "group",
    "aria-label": `${t("trace_graph")}: ${center}` });
  const defs = svgEl("defs", {},
    svgEl("marker", { id: "arrow-declared", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" },
      svgEl("path", { d: "M0 0L10 5L0 10z", class: "arrow" })),
    svgEl("marker", { id: "arrow-inferred", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" },
      svgEl("path", { d: "M0 0L10 5L0 10z", class: "arrow arrow--inferred" })));
  svg.append(defs);
  const showLabels = edges.length <= 6;
  const clip = (x1, y1, x2, y2) => {
    // shorten the segment so it stops at the target box border
    const dx = x2 - x1; const dy = y2 - y1;
    const scale = Math.min(Math.abs((nodeW / 2 + 4) / (dx || 1e-6)), Math.abs((nodeH / 2 + 4) / (dy || 1e-6)), 1);
    return [x2 - dx * scale, y2 - dy * scale];
  };
  for (const edge of edges) {
    const [x1, y1] = pos.get(edge.from);
    const [x2, y2] = pos.get(edge.to);
    const [ex, ey] = clip(x1, y1, x2, y2);
    const [sx, sy] = clip(x2, y2, x1, y1);
    const declared = isDeclared(edge);
    svg.append(svgEl("line", { x1: sx, y1: sy, x2: ex, y2: ey,
      class: `edge ${declared ? "edge--declared" : "edge--inferred"}`,
      "marker-end": `url(#${declared ? "arrow-declared" : "arrow-inferred"})` }));
    if (showLabels) {
      const label = svgEl("text", { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 5, "text-anchor": "middle", class: "edge-label" });
      label.textContent = edge.type;
      svg.append(label);
    }
  }
  for (const [id, [x, y]] of pos) {
    const prefix = id.split("-")[0];
    const group = svgEl("g", { class: `node node--${prefix}${id === center ? " node--center" : ""}`, tabindex: "0", role: "button",
      "aria-label": `${id}${id === center ? "" : ` — ${t("trace_graph_hint")}`}` });
    group.append(svgEl("rect", { x: x - nodeW / 2, y: y - nodeH / 2, width: nodeW, height: nodeH, rx: 7 }));
    const text = svgEl("text", { x, y: y + 4, "text-anchor": "middle" });
    text.textContent = id;
    group.append(text);
    const activate = () => { if (id !== center) recenter(id); };
    group.addEventListener("click", activate);
    group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } });
    svg.append(group);
  }
  return el("div", { class: "graph-wrap" }, svg);
}

// ============================================================ project state
function summarize(value) {
  if (value === null || value === undefined) return t("none");
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (value.every((item) => typeof item !== "object")) return value.join(", ");
    return t("ps_items", { n: value.length });
  }
  if (typeof value === "object") return t("ps_fields_n", { n: Object.keys(value).length });
  return String(value);
}

export async function renderProjectState(root) {
  root.append(pageHeader({ title: t("ps_title"), subtitle: t("ps_subtitle") }));
  let data;
  try {
    data = await get("/api/v1/project/state");
  } catch (error) {
    failure(root, t("ps_title"), error, () => { root.replaceChildren(); renderProjectState(root); });
    return;
  }
  const pointers = Object.entries(data.pointers ?? {});
  const available = pointers.filter(([, info]) => info.available);
  const missing = pointers.filter(([, info]) => !info.available);
  if (!pointers.length) {
    root.append(card({}, emptyState(t("ps_unavailable"), { title: t("ps_pointers"), iconName: "layers" })));
    return;
  }
  for (const [path, info] of available) {
    const doc = info.document;
    const scalarPairs = doc && typeof doc === "object" && !Array.isArray(doc)
      ? Object.entries(doc).map(([key, value]) => [key, el("span", { class: typeof value === "object" && value !== null ? "subtle" : "", text: summarize(value) })])
      : [];
    root.append(card({ title: path.split("/").pop(), actions: [chip(t("ps_available"), { variant: "kind-decision", size: "sm", dot: true })] },
      el("p", { class: "path small muted", text: path }),
      scalarPairs.length ? kv(scalarPairs) : null,
      disclosure(t("show_raw"), codeBlock(JSON.stringify(doc, null, 2)), { plain: true })));
  }
  if (missing.length) {
    root.append(card({ title: t("not_available"), count: missing.length, variant: "sunken" },
      el("ul", { class: "plain-list" }, ...missing.map(([path]) => el("li", { class: "path small", text: path })))));
  }
}

// ============================================================== diagnostics
export async function renderDiagnostics(root) {
  root.append(pageHeader({ title: t("dg_title"), subtitle: t("dg_subtitle") }));
  let ready, diags, version;
  try {
    [ready, diags, version] = await Promise.all([
      get("/api/v1/ready"), get("/api/v1/diagnostics/reconciliation"), get("/api/v1/version"),
    ]);
  } catch (error) {
    failure(root, t("dg_title"), error, () => { root.replaceChildren(); renderDiagnostics(root); });
    return;
  }
  const yesNo = (value) => (value === undefined || value === null ? t("unknown") : value ? t("yes") : t("no"));
  root.append(el("div", { class: "grid-2" },
    card({ title: t("dg_service") }, kv([
      [t("dg_ready"), yesNo(ready.ready)],
      [t("dg_stale"), yesNo(ready.stale)],
      [t("dg_write"), yesNo(ready.writes_enabled)],
      [t("dg_generation"), ready.generation ?? t("unknown")],
      [t("dg_lock"), ready.lock ? el("span", { class: "mono small", text: ready.lock }) : null],
      [t("dg_installed"), version.app_version],
      [t("dg_api"), version.api_version],
      [t("dg_inventory"), formatDate(diags.last_full_inventory)],
    ])),
    card({ title: t("dg_contracts") }, kv(Object.entries(version.contract_versions ?? {})
      .map(([name, value]) => [el("span", { class: "mono small", text: name }), `v${value}`])))));

  const rows = diags.diagnostics ?? [];
  const severities = ["BLOCK", "WARN", "INFO"];
  const countBy = Object.fromEntries(severities.map((sev) => [sev, rows.filter((row) => row.severity === sev).length]));
  const listBox = el("div", {});
  const listCard = card({ title: t("dg_list"), count: rows.length, variant: "flush",
    actions: rows.length ? [segmented({ label: t("dg_severity"), value: "",
      options: [["", t("dg_filter_all")], ...severities.filter((sev) => countBy[sev]).map((sev) => [sev, t(`sev_${sev}`),
        el("span", { class: `badge ${sev === "BLOCK" ? "badge--danger" : sev === "WARN" ? "badge--warn" : ""}`, text: String(countBy[sev]) })])],
      onChange: (value) => draw(value) })] : [] }, listBox);
  root.append(listCard);

  function draw(filter) {
    const shown = rows.filter((row) => !filter || row.severity === filter);
    if (!shown.length) { listBox.replaceChildren(emptyState(t("empty_diags"), { iconName: "check-circle" })); return; }
    listBox.replaceChildren(el("div", { class: "table-wrap" }, el("table", { class: "table" },
      el("thead", {}, el("tr", {},
        el("th", { scope: "col", text: t("dg_severity") }), el("th", { scope: "col", text: t("dg_code") }),
        el("th", { scope: "col", text: t("dg_scope") }), el("th", { scope: "col", text: t("dg_message") }))),
      el("tbody", {}, ...shown.map((row) => {
        let sources = [];
        try { sources = typeof row.sources === "string" ? JSON.parse(row.sources) : row.sources ?? []; } catch (_error) { sources = []; }
        return el("tr", {},
          el("td", {}, severityChip(row.severity, { size: "sm" })),
          el("td", {}, el("code", { class: "small strong", text: row.code })),
          el("td", { class: "nowrap" }, row.scope ? (ID_PATTERN.test(row.scope) ? idTag(row.scope, hrefForId(row.scope)) : el("span", { class: "path small", text: row.scope })) : t("none")),
          el("td", {}, el("div", { text: row.message }),
            ...(Array.isArray(sources) ? sources : []).map((source) => el("div", { class: "path xsmall subtle", text: source }))));
      })))));
  }
  draw("");
}
