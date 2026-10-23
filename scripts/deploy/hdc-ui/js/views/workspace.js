// Workspace: the eight canonical sections (definition §11). Answers are never
// preselected — recommendations render as guidance only. Section 7 replaces
// "export": it publishes the canonical ANS through the local API. Only human
// drafts bound to the current QS hash are restored; restoring never confirms
// authorship or submits an ANS. Governed content is always rendered as text.
import { get, put, post, ensureCsrf } from "../api.js";
import { t, has, language, setLanguage } from "../i18n.js";
import {
  el, icon, chip, stateChip, riskChip, severityChip, idTag, pageHeader, card, callout, metaGrid, kv,
  emptyState, errorState, errorMessage, disclosure, codeBlock, progressBar, setProgress, copyButton,
  announce, formatDate, timeTag, loopLabel, typeLabel, artifactPath,
} from "../ui.js";

const SAVE_DEBOUNCE_MS = 600;
const SAVE_RETRY_MS = 5000;
const LONG_DETAIL_CHARS = 280;
const EXCERPT_CHARS = 180;
const ANSWERED_STATES = ["ANSWERED", "INGESTED", "ARCHIVED"];
const CLOSED_STATES = ["CANCELLED", "EXPIRED", "INDETERMINATE"];

// Hash of the QS the open workspace is answering (main.js asks before
// re-rendering on generation changes — an unchanged hash never wipes input).
let workspaceHash = null;
export function lastWorkspaceHash() {
  return workspaceHash;
}

function draftStorageKey(qsId) {
  return `hdc-pending-draft:${qsId}`;
}

function readPendingDraft(qsId) {
  try {
    return JSON.parse(sessionStorage.getItem(draftStorageKey(qsId)));
  } catch (_error) {
    return null;
  }
}

function draftPayload(qs, state) {
  return {
    question_session_id: qs.question_session_id,
    question_sha256: qs.qs_sha256,
    request_id: state.requestId ??= crypto.randomUUID(),
    answered_by: state.author,
    ui_language: language(),
    answers: (qs.questions ?? []).flatMap((question) => {
      const qid = question.question_id;
      if (!state.answers.has(qid) && !state.comments.has(qid)) return [];
      const entry = { question_id: qid };
      if (state.answers.has(qid)) entry.value = state.answers.get(qid);
      if (state.comments.has(qid)) entry.comment = state.comments.get(qid);
      return [entry];
    }),
    confirmations: { ...state.confirmations },
  };
}

function sameDraft(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  const fields = ["question_session_id", "question_sha256", "request_id", "answered_by", "ui_language", "answers", "confirmations"];
  const signature = (draft) => JSON.stringify(canonical(Object.fromEntries(fields.map((key) => [key, draft[key]]))));
  return signature(left) === signature(right);
}

function restoreDraft(qs, state, draft) {
  const questions = new Map((qs.questions ?? []).map((question) => [question.question_id, question]));
  for (const answer of Array.isArray(draft.answers) ? draft.answers : []) {
    if (!answer || !questions.has(answer.question_id)) continue;
    const question = questions.get(answer.question_id);
    if (Object.hasOwn(answer, "value")) {
      if (question.type !== "ordered_priority" ||
          (Array.isArray(answer.value) && answer.value.length === question.options.length &&
           new Set(answer.value).size === answer.value.length &&
           answer.value.every((value) => question.options.some((option) => option.value === value)))) {
        state.answers.set(answer.question_id, answer.value);
      }
    }
    if (typeof answer.comment === "string") state.comments.set(answer.question_id, answer.comment);
  }
  for (const question of questions.values()) {
    if (question.type !== "ordered_priority") continue;
    if (typeof draft.confirmations?.[question.question_id] === "boolean") {
      state.confirmations[question.question_id] = draft.confirmations[question.question_id];
      if (state.confirmations[question.question_id] && !state.answers.has(question.question_id)) {
        const previous = (Array.isArray(draft.answers) ? draft.answers : [])
          .find((answer) => answer?.question_id === question.question_id);
        if (previous && Object.hasOwn(previous, "value")) state.confirmations[question.question_id] = false;
        else state.answers.set(question.question_id, question.options.map((option) => option.value));
      }
    }
  }
  if (typeof draft.answered_by === "string") state.author = draft.answered_by;
  if (typeof draft.request_id === "string") state.requestId = draft.request_id;
}

// ------------------------------------------------------------------ helpers
function safeId(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function excerpt(text, max = EXCERPT_CHARS) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function lowerLabel(text) {
  return String(text ?? "").toLocaleLowerCase(language());
}

function kindLabel(kind) {
  const label = t(`kind_${kind}`);
  return label === `kind_${kind}` ? String(kind) : label;
}

function tomorrowUtc() {
  return new Date(Date.now() + 86400000).toISOString().slice(0, 10);
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Scroll to a node and move focus without letting the hash router navigate. */
function jumpTo(target, focusTarget = target) {
  if (!target) return;
  target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  if (!focusTarget) return;
  if (!focusTarget.matches("a[href], button, input, textarea, select, summary, [tabindex]")) {
    focusTarget.setAttribute("tabindex", "-1");
  }
  focusTarget.focus({ preventScroll: true });
}

function jumpLink(ctx, attrs, getTarget, ...children) {
  return el("a", {
    href: `#/sessions/${encodeURIComponent(ctx.qsId)}`,
    ...attrs,
    onclick: (event) => {
      event.preventDefault();
      const [target, focusTarget] = getTarget();
      jumpTo(target, focusTarget);
    },
  }, ...children);
}

function firstControl(node) {
  return node?.querySelector("input:not([disabled]), textarea:not([disabled]), button:not([disabled]), select:not([disabled])") ?? null;
}

/** The answer control of a question (never the artifact copy button or the disclosure). */
function primaryControl(item) {
  if (!item) return null;
  return firstControl(item.node.querySelector("fieldset")) ?? firstControl(item.node.querySelector(".order-list")) ??
    (item.controls.text && !item.controls.text.disabled ? item.controls.text : null) ?? firstControl(item.node);
}

function optionOf(question, value) {
  return (question.options ?? []).find((option) => option.value === value) ?? null;
}

function optionLabel(question, value) {
  const option = optionOf(question, value);
  if (option?.label) return option.label;
  if (question.type === "yes_no" || question.type === "approval") return t(value);
  return String(value ?? "");
}

function hasValue(question, value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (question.type === "risk_acceptance") return typeof value?.accepted === "boolean";
  if (typeof value === "string") return question.type === "free_text" ? value.trim() !== "" : value !== "";
  return true;
}

function hasCommentField(question) {
  return question.requires_comment === true || question.type === "approval" ||
    question.type === "confirm_or_override" || question.type === "ordered_priority";
}

/** Mirrors the server cross-rules that demand a comment for the current value. */
function commentRequired(question, value) {
  if (question.requires_comment === true) return true;
  if (question.type === "confirm_or_override") return value !== undefined && value !== question.default_option;
  if (question.type === "approval") return value === "reject";
  return false;
}

function riskComplete(value) {
  return typeof value?.expiry === "string" && value.expiry >= tomorrowUtc() &&
    typeof value?.justification === "string" && value.justification.trim() !== "";
}

/** Client-side status; informative only — the server stays the validator. */
function assess(question, state) {
  const qid = question.question_id;
  const value = state.answers.get(qid);
  const comment = state.comments.get(qid) ?? "";
  const valued = hasValue(question, value);
  const notes = [];
  const unconfirmed = question.type === "ordered_priority" && valued && state.confirmations[qid] !== true;
  if (unconfirmed) notes.push("ws_summary_order_unconfirmed");
  if (valued && commentRequired(question, value) && !comment.trim()) notes.push("ws_summary_comment_missing");
  if (question.type === "risk_acceptance" && value?.accepted === true && !riskComplete(value)) {
    notes.push("ws_summary_risk_incomplete");
  }
  let status;
  if (state.errors.has(qid)) status = "error";
  else if (notes.length) status = "attention";
  else if (valued) status = "done";
  else status = question.required === true ? "missing" : "optional";
  return { valued, answered: valued && !unconfirmed, status, notes };
}

function counts(ctx) {
  const questions = ctx.qs.questions ?? [];
  let answered = 0;
  let requiredTotal = 0;
  let requiredDone = 0;
  let commentsOk = true;
  for (const question of questions) {
    const result = assess(question, ctx.state);
    if (result.answered) answered += 1;
    if (question.required === true) {
      requiredTotal += 1;
      if (result.answered) requiredDone += 1;
    }
    if (result.notes.includes("ws_summary_comment_missing")) commentsOk = false;
  }
  return { total: questions.length, answered, requiredTotal, requiredDone, requiredLeft: requiredTotal - requiredDone, commentsOk };
}

function answerText(question, value) {
  switch (question.type) {
    case "risk_acceptance":
      return value?.accepted === true
        ? t("ws_risk_accepted_until", { date: value.expiry || t("none") })
        : t("ws_risk_not_accepted");
    case "ordered_priority":
      return value.map((item, index) => `${index + 1}. ${optionLabel(question, item)}`).join("\n");
    case "multi_choice":
      return value.map((item) => optionLabel(question, item)).join(", ");
    case "free_text":
      return excerpt(value, 240);
    default:
      return optionLabel(question, value);
  }
}

/** Question a server field error belongs to: its path carries the question id. */
function questionForError(fieldError, questions) {
  const ids = questions.map((question) => question.question_id);
  const path = String(fieldError?.path ?? "");
  const direct = path.match(/answers\(([^)]*)\)/)?.[1];
  if (direct && ids.includes(direct)) return direct;
  const longest = (list) => list.sort((a, b) => b.length - a.length)[0] ?? null;
  const inPath = longest(ids.filter((id) => path.includes(id)));
  if (inPath) return inPath;
  const message = String(fieldError?.message ?? "");
  return longest(ids.filter((id) => message.includes(`'${id}'`)));
}

function fieldErrorText(fieldError) {
  const key = `fe_${fieldError?.code}`;
  return has(key) ? t(key) : String(fieldError?.message || t("err_generic"));
}

// ------------------------------------------------------------------- render
export async function render(root, qsId, { readOnly = false } = {}) {
  root.textContent = "";
  let session;
  try {
    session = await get(`/api/v1/sessions/${encodeURIComponent(qsId)}`);
  } catch (error) {
    workspaceHash = null;
    root.append(el("div", { class: "stack" },
      pageHeader({ crumbs: [[t("nav_decisions"), "#/decisions"], [qsId, null]], title: qsId }),
      errorState(errorMessage(error), {
        onRetry: () => window.dispatchEvent(new HashChangeEvent("hashchange")),
      })));
    return;
  }

  // the projection row carries states; the QS artifact carries the questions
  let qsDoc = null;
  if (session.qs_path) {
    try {
      const artifact = await get(`/api/v1/artifacts/${artifactPath(session.qs_path)}`);
      qsDoc = JSON.parse(artifact.content);
    } catch (_error) {
      qsDoc = null; // render what is known; the workspace stays explicit
    }
  }
  // §11: QS.ui_language seeds the chrome unless the user already chose one
  // (the masthead toggle syncs through the hdc:language event).
  const wanted = qsDoc?.ui_language;
  if (wanted && !localStorage.getItem("hdc-lang") && wanted !== language()) setLanguage(wanted);
  workspaceHash = session.qs_sha256 ?? null;

  const qs = { ...session, ...Object.fromEntries(
    Object.entries(qsDoc ?? {}).filter(([key]) =>
      ["intervention_reason", "decision_impact", "questions", "initial_instructions",
       "ui_language", "risk_tier", "affected_loop"].includes(key)),
  ) };
  const pending = readPendingDraft(qsId);
  const matches = (draft) => draft?.question_session_id === qsId &&
    typeof qs.qs_sha256 === "string" && draft.question_sha256 === qs.qs_sha256;
  // A reload can interrupt the reply after the server already committed the draft.
  const pendingAcknowledged = matches(pending?.payload) && matches(session.draft) &&
    sameDraft(pending.payload, session.draft);
  const pendingCurrent = matches(pending?.payload) && !pendingAcknowledged;
  if (pendingAcknowledged) {
    try { sessionStorage.removeItem(draftStorageKey(qsId)); } catch (_error) { /* Server copy is intact. */ }
  }
  const currentDraft = pendingCurrent ? pending.payload : matches(session.draft) ? session.draft : null;
  const staleDraft = pending?.payload && !matches(pending.payload) ? pending.payload :
    session.draft && !matches(session.draft) ? session.draft : null;
  const state = {
    answers: new Map(),
    comments: new Map(),
    confirmations: {},
    etag: pendingCurrent ? pending.etag ?? null : session.draft?.etag ?? null,
    author: "",
    authorConfirmed: false,
    sentReceipt: null,
    sourceChanged: false,
    pendingDraft: pendingCurrent,
    errors: new Map(), // question_id -> [{code, path, message}] from the last 422
    unmappedErrors: [],
  };

  const effective = qs.effective_state;
  const answeredState = ANSWERED_STATES.includes(effective);
  const closedState = CLOSED_STATES.includes(effective);
  const blocked = !answeredState && !closedState && (Boolean(qs.blocked_reason) || qs.can_answer === false);
  const hasQuestions = Array.isArray(qs.questions) && qs.questions.length > 0;
  const mode = answeredState ? "answered" : closedState ? "closed" : blocked ? "blocked"
    : readOnly || !hasQuestions ? "readonly" : "answer";

  const restored = Boolean(currentDraft) && !readOnly && effective === "PENDING" && mode === "answer";
  if (restored) restoreDraft(qs, state, currentDraft);

  // ANSWERED / INGESTED / ARCHIVED: the ANS bound to this exact QS version, read-only.
  let answersStatus = null;
  if (mode === "answered") {
    try {
      if (!qs.answers_path || !hasQuestions) throw new Error("ANSWERS_UNAVAILABLE");
      const artifact = await get(`/api/v1/artifacts/${artifactPath(qs.answers_path)}`);
      const answers = JSON.parse(artifact.content);
      if (answers.question_session_id !== qsId || answers.submission?.question_sha256 !== qs.qs_sha256 ||
          !Array.isArray(answers.answers)) throw new Error("ANSWER_BINDING_MISMATCH");
      restoreDraft(qs, state, answers);
      // A published ANS passed the confirmation rule; display it as confirmed.
      for (const question of qs.questions) {
        if (question.type === "ordered_priority" && state.answers.has(question.question_id)) {
          state.confirmations[question.question_id] = true;
        }
      }
      state.answeredAt = answers.answered_at ?? qs.answered_at ?? null;
      answersStatus = "restored";
    } catch (_error) {
      answersStatus = "unavailable";
    }
  }

  const ctx = {
    qsId, qs, state, mode, restored, staleDraft, answersStatus,
    locked: mode !== "answer",
    sending: false,
    items: new Map(), // question_id -> { question, node, title, errorEl, controls, refresh }
    ui: {},
  };
  const view = el("div", { class: "stack workspace" });
  ctx.view = view;
  root.append(view);

  view.append(buildHeader(ctx), ...buildBanners(ctx));
  const showQuestions = hasQuestions && (mode !== "answered" || answersStatus === "restored");
  const main = el("div", { class: "ws-main" },
    buildContext(ctx), buildImpact(ctx), buildRecommendations(ctx), buildRisks(ctx),
    buildQuestionsSection(ctx, showQuestions), buildSummarySection(ctx), buildSendSection(ctx), buildNextSection(ctx));
  view.append(el("div", { class: "ws-layout" }, main, buildAside(ctx, showQuestions)));
  if (mode === "answer") view.append(buildMobileBar(ctx));
  refresh(ctx);

  if (mode !== "answer") return;
  // Cache changes synchronously before the debounced server save.
  state.drafts = wireDraftAutosave(view, qsId, qs, state);
  try { await ensureCsrf(); } catch (_error) { /* sending retries the token */ }
}

// ------------------------------------------------------------------- header
function buildHeader(ctx) {
  const { qs } = ctx;
  ctx.ui.stateChip = stateChip(qs.effective_state, { preparing: ctx.restored });
  return pageHeader({
    crumbs: [[t("nav_decisions"), "#/decisions"], [qs.question_session_id ?? ctx.qsId, null]],
    title: qs.title || qs.question_session_id || ctx.qsId,
    subtitle: qs.session_label || null,
    meta: [
      idTag(qs.question_session_id ?? ctx.qsId),
      ctx.ui.stateChip,
      riskChip(qs.risk_tier),
      qs.affected_loop ? chip(loopLabel(qs.affected_loop), { variant: "outline" }) : null,
      qs.generated_at ? el("span", {}, `${t("col_date")} `, timeTag(qs.generated_at)) : null,
    ],
  });
}

function sourcesList(qs) {
  const refs = (qs.source_refs ?? []).filter(Boolean);
  // source_refs carry "<kind>:<path>"; the bare paths are only added when missing.
  const extra = [qs.qs_path, qs.answers_path].filter((path) => path && !refs.some((ref) => ref === path || ref.endsWith(`:${path}`)));
  const sources = [...new Set([...refs, ...extra])];
  if (!sources.length) return null;
  return el("div", { class: "stack-sm" },
    el("div", { class: "strong small", text: t("ws_sources") }),
    el("ul", { class: "stack-sm ws-plain-list" }, ...sources.map((source) => el("li", { class: "path", text: source }))));
}

function diagnosticsList(qs) {
  const diagnostics = qs.diagnostics ?? [];
  if (!diagnostics.length) return null;
  return el("div", { class: "stack-sm" },
    el("div", { class: "strong small", text: t("nav_diagnostics") }),
    el("ul", { class: "stack-sm ws-plain-list" }, ...diagnostics.map((diag) => el("li", { class: "cluster" },
      severityChip(diag.severity, { size: "sm" }),
      el("span", { class: "id", text: diag.code ?? diag.diag_id ?? "—" }),
      el("span", { class: "small", text: diag.message ?? "" })))));
}

function buildBanners(ctx) {
  const { qs, mode } = ctx;
  const banners = [];
  const stateLabel = lowerLabel(t(`st_${qs.effective_state}`));
  if (ctx.restored) {
    const node = callout("info", {}, el("p", { text: t("ws_draft_restored") }));
    node.id = "draft-restored";
    node.setAttribute("role", "status");
    banners.push(node);
  }
  if (ctx.staleDraft) {
    const node = callout("warn", { title: t("ws_draft_other_version") },
      disclosure(t("ws_draft_other_show"), codeBlock(JSON.stringify(ctx.staleDraft, null, 2)), { plain: true }));
    node.id = "draft-stale";
    banners.push(node);
  }
  if (mode === "readonly" && Array.isArray(qs.questions) && qs.questions.length) {
    banners.push(callout("info", { title: t("ws_readonly_title"), iconName: "lock" }, el("p", { text: t("readonly_mode") })));
  }
  if (mode === "answered") {
    banners.push(callout("info", { title: t("ws_readonly_title"), iconName: "lock" },
      el("p", { text: t("ws_readonly_text", { state: stateLabel }) }),
      el("p", {}, el("a", { href: `#/history/${encodeURIComponent(ctx.qsId)}`, text: t("ws_open_history") }))));
  }
  if (mode === "closed" || mode === "blocked" || (mode === "answered" && qs.blocked_reason)) {
    banners.push(callout("danger", {
      title: mode === "closed" ? t("ws_closed_text", { state: stateLabel }) : t("blocked_title"),
    },
    el("div", { class: "stack-sm" },
      qs.blocked_reason ? el("p", { class: "prose strong", text: qs.blocked_reason }) : null,
      mode === "answered" ? null : el("p", { text: t("ws_blocked_text") }),
      diagnosticsList(qs),
      sourcesList(qs))));
  }
  return banners;
}

// --------------------------------------------------------------- sections
function section(num, title, ...children) {
  const body = el("div", { class: "stack-sm ws-section-body" }, ...children);
  const node = card({ num, title, id: `sec-${num}` }, body);
  node.classList.add("ws-section");
  return { node, body, heading: node.querySelector(".card-title") };
}

function buildContext(ctx) {
  const { qs } = ctx;
  const s = section(1, t("sec1"),
    qs.intervention_reason
      ? el("p", { class: "prose prose-lg", text: qs.intervention_reason })
      : emptyState(t("not_available"), { compact: true }),
    qs.initial_instructions
      ? callout("info", { title: t("ws_instructions") }, el("p", { class: "prose", text: qs.initial_instructions }))
      : null,
    metaGrid([
      [t("col_session"), idTag(qs.question_session_id ?? ctx.qsId)],
      [t("col_date"), qs.generated_at ? formatDate(qs.generated_at) : null],
      [t("col_risk"), riskChip(qs.risk_tier, { size: "sm" })],
      [t("col_loop"), loopLabel(qs.affected_loop)],
      [t("ws_intervention"), qs.intervention_type ? kindLabel(qs.intervention_type) : null],
      [t("ws_evidence"), qs.evidence_status ?? null],
      [t("sec5"), Array.isArray(qs.questions) ? String(qs.questions.length) : null],
    ]));
  return s.node;
}

function buildImpact(ctx) {
  const { qs } = ctx;
  return section(2, t("sec2"),
    qs.decision_impact
      ? el("p", { class: "prose", text: qs.decision_impact })
      : emptyState(t("not_available"), { compact: true })).node;
}

function questionLink(ctx, question) {
  return jumpLink(ctx, { class: "ws-guide-link" }, () => {
    const item = ctx.items.get(question.question_id);
    return [item?.node, item?.title];
  }, question.title || question.question_id);
}

function optionMeta(option, id = null) {
  const parts = [["option_impact", option?.impact], ["option_risk", option?.risk], ["option_tradeoff", option?.tradeoff]]
    .filter(([, value]) => value);
  if (!parts.length) return null;
  return el("span", { class: "option-meta", id },
    ...parts.map(([key, value]) => el("span", {}, el("b", { text: `${t(key)}: ` }), String(value))));
}

function buildRecommendations(ctx) {
  const rows = [];
  for (const question of ctx.qs.questions ?? []) {
    const rec = question.recommended_option;
    const def = question.default_option;
    if (!rec && !def) continue;
    const line = (value, chips) => {
      const option = optionOf(question, value);
      return el("div", { class: "stack-sm ws-guide-line" },
        el("div", { class: "cluster" }, ...chips, el("span", { class: "strong", text: optionLabel(question, value) })),
        option?.description ? el("p", { class: "small muted prose", text: option.description }) : null);
    };
    const recChip = chip(t("recommended_label"), { variant: "rec", size: "sm" });
    const defChip = chip(t("default_label"), { variant: "default", size: "sm" });
    rows.push(el("li", {},
      el("div", { class: "ws-guide-head" }, questionLink(ctx, question),
        el("span", { class: "question-id", text: question.question_id })),
      rec ? line(rec, rec === def ? [recChip, defChip] : [recChip]) : null,
      def && def !== rec ? line(def, [defChip]) : null));
  }
  if (!rows.length) return section(3, t("sec3"), emptyState(t("ws_no_recs"), { compact: true })).node;
  return section(3, t("sec3"),
    callout("rec", {}, el("p", { text: t("ws_rec_note") })),
    el("ul", { class: "ws-guide" }, ...rows)).node;
}

function buildRisks(ctx) {
  const rows = [];
  for (const question of ctx.qs.questions ?? []) {
    const risky = (question.options ?? []).filter((option) => option.risk || option.impact || option.tradeoff);
    if (!(question.risk_tier >= 3) && !risky.length) continue;
    rows.push(el("li", {},
      el("div", { class: "ws-guide-head" }, questionLink(ctx, question),
        Number.isInteger(question.risk_tier) ? riskChip(question.risk_tier, { size: "sm" }) : null),
      risky.length
        ? el("ul", { class: "ws-guide-opts" }, ...risky.map((option) => el("li", {},
          el("span", { class: "strong", text: option.label ?? option.value }),
          optionMeta(option))))
        : el("p", { class: "small muted prose", text: question.why_this_matters || question.short_description || "" })));
  }
  return section(4, t("sec4"),
    rows.length ? el("ul", { class: "ws-guide" }, ...rows) : emptyState(t("ws_no_risks"), { compact: true })).node;
}

// ----------------------------------------------------------- questions (5)
function buildQuestionsSection(ctx, showQuestions) {
  const { qs, mode } = ctx;
  const s = section(5, t("sec5"));
  ctx.ui.sec5 = s;
  if (mode === "answered" && ctx.answersStatus === "restored") {
    const note = callout("info", { iconName: "lock" }, el("p", { text: t("ws_answers_readonly") }));
    note.id = "saved-answers-restored";
    note.setAttribute("role", "status");
    s.body.append(note);
  }
  if (mode === "answered" && ctx.answersStatus === "unavailable") {
    s.body.append(errorState(t("ws_answers_unavailable")));
  }
  if (!Array.isArray(qs.questions)) {
    s.body.append(errorState(t("ws_qs_unavailable")));
  } else if (!qs.questions.length) {
    s.body.append(emptyState(t("ws_no_questions"), { compact: true }));
  }
  if (!showQuestions) return s.node;
  const list = el("div", { class: "ws-questions" });
  qs.questions.forEach((question, index) => list.append(buildQuestion(ctx, question, index, qs.questions.length)));
  s.body.append(list);
  return s.node;
}

function buildQuestion(ctx, question, index, total) {
  const { state } = ctx;
  const qid = question.question_id;
  const sid = safeId(qid);
  const errorId = `err-${sid}`;
  const titleId = `qt-${sid}`;
  const item = { question, controls: {} };
  ctx.items.set(qid, item);

  const title = el("h3", { class: "question-title", id: titleId, tabindex: "-1", text: question.title || qid });
  const detail = question.full_explanation
    ? disclosure(t("ws_more_detail"), el("p", { class: "prose question-detail", text: question.full_explanation }),
      { plain: true, open: question.full_explanation.length <= LONG_DETAIL_CHARS })
    : null;
  const why = question.why_this_matters
    ? el("div", { class: "why" }, icon("info"),
      el("p", {}, el("span", { class: "why-label", text: `${t("ws_why")}:` }), " ",
        el("span", { class: "prose", text: question.why_this_matters })))
    : null;
  item.errorEl = el("p", { class: "field-error", id: errorId });

  const node = el("article", { class: "question", id: `q-${sid}`, "aria-labelledby": titleId },
    el("div", { class: "question-head" },
      el("span", { class: "question-id", text: qid }),
      chip(typeLabel(question.type), { variant: "outline", size: "sm" }),
      question.required === true
        ? chip(t("required_label"), { variant: "required", size: "sm" })
        : chip(t("optional_label"), { variant: "optional", size: "sm" }),
      Number.isInteger(question.risk_tier) ? riskChip(question.risk_tier, { size: "sm" }) : null,
      el("span", { class: "question-n subtle xsmall", text: t("ws_question_n", { n: index + 1, total }) })),
    title,
    question.short_description ? el("p", { class: "question-desc prose", text: question.short_description }) : null,
    detail,
    why,
    buildControls(ctx, question, item, errorId),
    hasCommentField(question) ? buildComment(ctx, question, item, errorId) : null,
    item.errorEl);
  item.node = node;
  item.title = title;
  // Editing a question clears its server errors (the server re-validates on send).
  const clear = () => {
    if (!state.errors.has(qid)) return;
    state.errors.delete(qid);
    // Once every reported field is edited, the rejected attempt no longer applies.
    if (!state.errors.size && !state.unmappedErrors.length) state.sendError = null;
    renderQuestionError(ctx, qid);
    renderErrorSummary(ctx);
    refresh(ctx);
  };
  node.addEventListener("input", clear);
  node.addEventListener("change", clear);
  node.addEventListener("click", (event) => { if (event.target.closest(".order-actions button")) clear(); });
  return node;
}

function changed(ctx) {
  refresh(ctx);
  ctx.view.dispatchEvent(new Event("draftchange"));
}

function optionCard(ctx, question, index, { type, value, label, description, option, chips = [], danger = false, checked, onChange, name }) {
  const base = `${safeId(question.question_id)}-opt-${index}`;
  const meta = optionMeta(option, `${base}-m`);
  const describedBy = [chips.length && `${base}-c`, description && `${base}-d`, meta && `${base}-m`].filter(Boolean);
  const input = el("input", {
    type, name, value, disabled: ctx.locked,
    "aria-labelledby": `${base}-l`, "aria-describedby": describedBy.join(" ") || null,
  });
  input.checked = checked;
  input.addEventListener("change", onChange);
  return el("label", { class: ["option", danger && "option--danger"] }, input,
    el("span", { class: "option-body" },
      el("span", { class: "option-label" }, el("span", { id: `${base}-l`, text: label }),
        chips.length ? el("span", { class: "cluster", id: `${base}-c` }, ...chips) : null),
      description ? el("span", { class: "option-desc prose", id: `${base}-d`, text: description }) : null,
      meta));
}

function optionChips(question, value) {
  const chips = [];
  if (value === question.recommended_option) chips.push(chip(t("recommended_label"), { variant: "rec", size: "sm" }));
  if (value === question.default_option) chips.push(chip(t("default_label"), { variant: "default", size: "sm" }));
  return chips;
}

function fieldset(question, errorId, { inline = false } = {}, ...children) {
  return el("fieldset", { class: ["options", inline && "options--inline"], "aria-describedby": errorId },
    el("legend", { class: "sr-only", text: question.title || question.question_id }), ...children);
}

function buildControls(ctx, question, item, errorId) {
  const { state } = ctx;
  const qid = question.question_id;
  const name = `q-${safeId(qid)}`;
  const current = state.answers.get(qid);
  const setScalar = (value) => () => { state.answers.set(qid, value); changed(ctx); };

  switch (question.type) {
    case "single_choice":
    case "confirm_or_override":
      return fieldset(question, errorId, {}, ...(question.options ?? []).map((option, index) => optionCard(ctx, question, index, {
        type: "radio", name, value: option.value, label: option.label ?? option.value, description: option.description,
        option, chips: optionChips(question, option.value), checked: current === option.value, onChange: setScalar(option.value),
      })));
    case "multi_choice": {
      const options = question.options ?? [];
      return fieldset(question, errorId, {}, ...options.map((option, index) => {
        const node = optionCard(ctx, question, index, {
          type: "checkbox", name, value: option.value, label: option.label ?? option.value, description: option.description,
          option, chips: optionChips(question, option.value),
          checked: Array.isArray(current) && current.includes(option.value),
          onChange: () => {
            const picked = new Set([...node.closest("fieldset").querySelectorAll("input:checked")].map((input) => input.value));
            state.answers.set(qid, options.map((o) => o.value).filter((value) => picked.has(value)));
            changed(ctx);
          },
        });
        return node;
      }));
    }
    case "yes_no":
      return fieldset(question, errorId, { inline: true }, ...["yes", "no"].map((value, index) => {
        const option = optionOf(question, value);
        return optionCard(ctx, question, index, {
          type: "radio", name, value, label: option?.label || t(value), description: option?.description, option,
          chips: optionChips(question, value), checked: current === value, onChange: setScalar(value),
        });
      }));
    case "approval":
      return el("div", { class: "stack-sm" },
        fieldset(question, errorId, {}, ...["approve", "reject", "defer"].map((value, index) => {
          const option = optionOf(question, value);
          return optionCard(ctx, question, index, {
            type: "radio", name, value, label: option?.label || t(value), description: option?.description || t(`${value}_desc`),
            option, chips: optionChips(question, value), danger: value === "reject",
            checked: current === value, onChange: setScalar(value),
          });
        })),
        buildBinding(question));
    case "risk_acceptance":
      return buildRiskAcceptance(ctx, question, item, errorId, name);
    case "free_text":
      return buildFreeText(ctx, question, item, errorId);
    case "ordered_priority":
      return buildOrder(ctx, question, item, errorId);
    default:
      return callout("warn", {}, el("p", { text: t("ws_unknown_type", { type: String(question.type) }) }));
  }
}

function buildBinding(question) {
  const binding = question.artifact_binding;
  if (!binding && !question.artifact_ref) return null;
  const ref = binding?.artifact_ref ?? question.artifact_ref;
  return el("div", { class: "binding" },
    el("div", { class: "binding-title", text: t("approval_binding") }),
    kv([
      [t("approval_ref"), el("span", { class: "id", text: ref })],
      binding?.path ? [t("approval_path"), el("span", { class: "path", text: binding.path })] : null,
      binding?.sha256 ? [t("approval_hash"), el("span", { class: "cluster" },
        el("span", { class: "hash", text: binding.sha256 }), copyButton(binding.sha256))] : null,
    ]));
}

function buildRiskAcceptance(ctx, question, item, errorId, name) {
  const { state } = ctx;
  const qid = question.question_id;
  const sid = safeId(qid);
  const saved = state.answers.get(qid);
  const expiryHint = `${sid}-expiry-hint`;
  const justHint = `${sid}-just-hint`;
  const expiry = el("input", {
    class: "input", type: "date", id: `${sid}-expiry`, min: tomorrowUtc(), disabled: ctx.locked,
    "aria-describedby": `${expiryHint} ${errorId}`,
  });
  const justification = el("textarea", {
    class: "textarea", id: `${sid}-just`, rows: "3", disabled: ctx.locked,
    "aria-describedby": `${justHint} ${errorId}`,
  });
  expiry.value = typeof saved?.expiry === "string" ? saved.expiry : "";
  justification.value = typeof saved?.justification === "string" ? saved.justification : "";
  item.controls.expiry = expiry;
  item.controls.justification = justification;

  const fields = el("div", { class: "risk-fields" },
    el("div", { class: "field" },
      el("label", { class: "field-label", for: expiry.id, text: t("expiry_label") }),
      expiry,
      el("p", { class: "field-hint", id: expiryHint, text: t("expiry_hint") })),
    el("div", { class: "field" },
      el("label", { class: "field-label", for: justification.id, text: t("justification_label") }),
      justification,
      el("p", { class: "field-hint", id: justHint, text: t("justification_hint") })));

  let accept;
  let decline;
  const update = () => {
    if (!accept.checked && !decline.checked) return;
    fields.hidden = !accept.checked;
    // Field values are kept while toggling; only an acceptance carries them.
    state.answers.set(qid, accept.checked
      ? { accepted: true, expiry: expiry.value || undefined, justification: justification.value || undefined }
      : { accepted: false });
    changed(ctx);
  };
  const acceptCard = optionCard(ctx, question, 0, {
    type: "radio", name, value: "accept", label: t("accepted"), description: t("accepted_desc"),
    checked: saved?.accepted === true, onChange: update,
  });
  const declineCard = optionCard(ctx, question, 1, {
    type: "radio", name, value: "decline", label: t("not_accepted"), description: t("not_accepted_desc"),
    checked: saved?.accepted === false, onChange: update,
  });
  accept = acceptCard.querySelector("input");
  decline = declineCard.querySelector("input");
  expiry.addEventListener("input", update);
  expiry.addEventListener("change", update);
  justification.addEventListener("input", update);
  fields.hidden = !(saved?.accepted === true || (ctx.locked && (expiry.value || justification.value)));
  return el("div", { class: "stack-sm" }, fieldset(question, errorId, { inline: true }, acceptCard, declineCard), fields);
}

function buildFreeText(ctx, question, item, errorId) {
  const { state } = ctx;
  const qid = question.question_id;
  const sid = safeId(qid);
  const countId = `${sid}-count`;
  const input = el("textarea", {
    class: "textarea", id: `${sid}-text`, rows: "4", disabled: ctx.locked,
    "aria-describedby": `${countId} ${errorId}`,
  });
  const saved = state.answers.get(qid);
  input.value = typeof saved === "string" ? saved : "";
  item.controls.text = input;
  const count = el("div", { class: "char-count", id: countId });
  const updateCount = () => { count.textContent = t("ws_chars", { n: input.value.length }); };
  updateCount();
  input.addEventListener("input", () => {
    if (input.value === "") state.answers.delete(qid);
    else state.answers.set(qid, input.value);
    updateCount();
    changed(ctx);
  });
  return el("div", { class: "field" },
    el("label", { class: "field-label", for: input.id, text: t("free_text_label") }), input, count);
}

function buildOrder(ctx, question, item, errorId) {
  const { state } = ctx;
  const qid = question.question_id;
  const sid = safeId(qid);
  const items = (question.options ?? []).map((option) => option.value);
  const hintId = `${sid}-order-hint`;
  const list = el("ol", { class: "order-list", "aria-labelledby": `qt-${sid}`, "aria-describedby": `${hintId} ${errorId}` });
  const currentOrder = () => state.answers.get(qid) ?? items;

  const renderOrder = (moved = null) => {
    const order = currentOrder();
    list.replaceChildren(...order.map((value, index) => {
      const option = optionOf(question, value);
      const label = option?.label ?? value;
      const button = (direction, disabledEdge) => el("button", {
        class: "btn btn--ghost btn--sm btn--icon", type: "button", "data-dir": direction,
        "aria-label": t(direction === "up" ? "order_move_up" : "order_move_down", { label }),
        title: t(direction === "up" ? "order_move_up" : "order_move_down", { label }),
        disabled: ctx.locked || disabledEdge,
        onclick: () => move(value, direction),
      }, icon(direction === "up" ? "arrow-up" : "arrow-down"));
      return el("li", { class: ["order-item", value === moved && "is-moved"], dataset: { value } },
        el("span", { class: "order-pos", "aria-hidden": "true", text: String(index + 1) }),
        el("span", { class: "order-body" },
          el("span", { class: "order-label", text: label }),
          option?.description ? el("span", { class: "order-desc", text: option.description }) : null,
          optionMeta(option)),
        el("span", { class: "order-actions" }, button("up", index === 0), button("down", index === order.length - 1)));
    }));
  };
  const move = (value, direction) => {
    const next = [...currentOrder()];
    const from = next.indexOf(value);
    const to = from + (direction === "up" ? -1 : 1);
    if (from < 0 || to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to], next[from]];
    state.answers.set(qid, next);
    renderOrder(value);
    // Keep focus on the moved item's control (the other arrow when it hit an edge).
    const row = [...list.children].find((li) => li.dataset.value === value);
    const same = row?.querySelector(`button[data-dir="${direction}"]`);
    const other = row?.querySelector(`button[data-dir="${direction === "up" ? "down" : "up"}"]`);
    (same && !same.disabled ? same : other)?.focus();
    announce(t("order_moved", { label: optionOf(question, value)?.label ?? value, n: to + 1 }));
    changed(ctx);
  };
  renderOrder();

  const confirm = el("input", { type: "checkbox", id: `confirm-${sid}`, disabled: ctx.locked, "aria-describedby": errorId });
  confirm.checked = state.confirmations[qid] === true;
  confirm.addEventListener("change", () => {
    state.confirmations[qid] = confirm.checked;
    if (confirm.checked && !state.answers.has(qid)) {
      state.answers.set(qid, [...items]);
    }
    changed(ctx);
  });
  item.controls.confirm = confirm;
  const confirmRow = el("label", { class: "checkbox-row ws-order-confirm" }, confirm, el("span", { class: "strong", text: t("order_confirm") }));
  // Order confirmation is submit-time consent, not a persisted ANS field.
  confirmRow.hidden = ctx.locked;
  item.controls.confirmRow = confirmRow;
  return el("div", { class: "stack-sm" },
    ctx.locked ? null : el("p", { class: "field-hint", id: hintId, text: t("order_hint") }),
    list, confirmRow);
}

function buildComment(ctx, question, item, errorId) {
  const { state } = ctx;
  const qid = question.question_id;
  const sid = safeId(qid);
  const hintId = `${sid}-comment-hint`;
  const value = state.comments.get(qid) ?? "";
  const textarea = el("textarea", {
    class: "textarea", id: `${sid}-comment`, rows: "3", disabled: ctx.locked,
    "aria-describedby": `${hintId} ${errorId}`,
  });
  textarea.value = value;
  textarea.addEventListener("input", () => {
    if (textarea.value === "") state.comments.delete(qid);
    else state.comments.set(qid, textarea.value);
    changed(ctx);
  });
  const label = el("label", { class: "field-label", for: textarea.id });
  const hintKey = question.requires_comment === true ? "comment_hint_required"
    : question.type === "confirm_or_override" ? "comment_hint_override"
      : question.type === "approval" ? "comment_hint_reject" : null;
  item.controls.comment = textarea;
  item.refreshComment = () => {
    label.textContent = t(commentRequired(question, state.answers.get(qid)) ? "comment_required" : "comment_optional");
  };
  item.refreshComment();
  const field = el("div", { class: "field comment-field" }, label,
    hintKey ? el("p", { class: "field-hint", id: hintId, text: t(hintKey) }) : null, textarea);
  // Read-only views show only comments that exist.
  field.hidden = ctx.locked && !value;
  return field;
}

function renderQuestionError(ctx, qid) {
  const item = ctx.items.get(qid);
  if (!item) return;
  const errors = ctx.state.errors.get(qid) ?? [];
  item.errorEl.replaceChildren(...(errors.length
    ? [icon("alert-circle"), el("span", { text: errors.map(fieldErrorText).join(" ") })]
    : []));
  item.node.classList.toggle("invalid", errors.length > 0);
  for (const control of item.node.querySelectorAll("[aria-invalid]")) control.removeAttribute("aria-invalid");
  for (const error of errors) errorTarget(item, error)?.setAttribute("aria-invalid", "true");
}

function errorTarget(item, fieldError) {
  const path = String(fieldError?.path ?? "");
  if (/\.comment$/.test(path) && item.controls.comment) return item.controls.comment;
  if (/\.expiry$/.test(path) && item.controls.expiry) return item.controls.expiry;
  if (/\.justification$/.test(path) && item.controls.justification) return item.controls.justification;
  if (fieldError?.code === "ORDER_NOT_CONFIRMED" && item.controls.confirm) return item.controls.confirm;
  return primaryControl(item);
}

// ------------------------------------------------------------- summary (6)
function buildSummarySection(ctx) {
  const s = section(6, t("sec6"));
  ctx.ui.summary = s.body;
  return s.node;
}

function renderSummary(ctx) {
  const holder = ctx.ui.summary;
  if (!holder) return;
  const questions = ctx.qs.questions ?? [];
  const anyAnswer = questions.some((question) => hasValue(question, ctx.state.answers.get(question.question_id)));
  if (!ctx.items.size || (ctx.mode !== "answer" && !anyAnswer)) {
    holder.replaceChildren(emptyState(t("ws_summary_empty"), { compact: true }));
    return;
  }
  const icons = { done: "check-circle", attention: "alert", missing: "circle-dashed", optional: "circle-dashed", error: "alert-circle" };
  holder.replaceChildren(el("ol", { class: "summary-list" }, ...questions.map((question) => {
    const qid = question.question_id;
    const result = assess(question, ctx.state);
    const value = ctx.state.answers.get(qid);
    const comment = ctx.state.comments.get(qid);
    const serverErrors = ctx.state.errors.get(qid) ?? [];
    const notes = serverErrors.length ? serverErrors.map(fieldErrorText) : result.notes.map((key) => t(key));
    if (!result.valued && !serverErrors.length) notes.unshift(t(question.required === true ? "ws_summary_missing" : "ws_summary_optional"));
    return el("li", { class: "summary-row", dataset: { status: result.status === "optional" ? "missing" : result.status } },
      icon(icons[result.status]),
      el("div", { class: "stack-sm ws-summary-body" },
        el("div", { class: "summary-q" }, el("span", { class: "question-id", text: qid }), " ", question.title || ""),
        result.valued ? el("div", { class: "summary-a", text: answerText(question, value) }) : null,
        comment && comment.trim() ? el("div", { class: "summary-comment", text: excerpt(comment) }) : null,
        notes.length ? el("div", { class: "summary-note", text: notes.join(" · ") }) : null),
      jumpLink(ctx, { class: "btn btn--ghost btn--sm", "aria-label": `${t(ctx.locked ? "ws_summary_view" : "ws_summary_edit")}: ${question.title || qid}` }, () => {
        const item = ctx.items.get(qid);
        return [item?.node, ctx.locked ? item?.title : primaryControl(item) ?? item?.title];
      }, icon(ctx.locked ? "arrow-right" : "edit"), t(ctx.locked ? "ws_summary_view" : "ws_summary_edit")));
  })));
}

// ---------------------------------------------------------------- send (7)
function buildSendSection(ctx) {
  const s = section(7, t("sec7"));
  ctx.ui.sec7 = s;
  const { state, mode, qs } = ctx;
  if (mode === "answered") {
    s.body.append(el("p", { text: state.author
      ? t("ws_answered_by", { name: state.author, date: state.answeredAt ? formatDate(state.answeredAt) : t("none") })
      : t("readonly_mode") }),
    el("p", { class: "muted small", text: t("ws_readonly_text", { state: lowerLabel(t(`st_${qs.effective_state}`)) }) }));
    return s.node;
  }
  if (mode !== "answer") {
    s.body.append(el("p", { class: "muted", text: mode === "readonly" && ctx.qs.questions?.length ? t("readonly_mode") : t("ws_send_unavailable") }));
    return s.node;
  }

  const authorInput = el("input", { class: "input", type: "text", id: "author-input", autocomplete: "name", "aria-describedby": "author-hint" });
  authorInput.value = state.author;
  const confirmBox = el("input", { type: "checkbox", id: "author-confirm" });
  confirmBox.checked = false; // identity is confirmed per send, never restored
  const sendHint = el("p", { class: "field-hint", id: "send-hint", text: t("ws_send_disabled_hint") });
  const sendLabel = el("span", { text: t("btn_send") });
  const sendBtn = el("button", { class: "btn btn--primary btn--lg", type: "button", "aria-describedby": "send-hint" }, icon("send"), sendLabel);
  const saveState = el("span", { class: "save-state", role: "status", "aria-live": "polite" });
  const errorSlot = el("div", { class: "ws-send-errors" });
  ctx.ui.checklist = el("ul", { class: "checklist" });
  ctx.ui.errorSlot = errorSlot;

  const refreshSend = () => {
    // html[data-writes] mirrors /api/v1/ready (main.js); unknown counts as writable.
    const writable = document.documentElement.dataset.writes !== "false";
    const ready = Boolean(state.authorConfirmed && state.author.trim()) && !state.sourceChanged && writable;
    sendBtn.disabled = !ready || ctx.sending;
    sendHint.textContent = t(writable ? "ws_send_disabled_hint" : "ws_writes_disabled");
    sendHint.hidden = ready;
  };
  ctx.ui.refreshSend = refreshSend;
  const onWrites = () => {
    if (!ctx.view.isConnected) { document.removeEventListener("hdc:writes", onWrites); return; }
    if (!ctx.locked) refreshSend();
  };
  document.addEventListener("hdc:writes", onWrites);
  confirmBox.addEventListener("change", () => { state.authorConfirmed = confirmBox.checked; refresh(ctx); });
  authorInput.addEventListener("input", () => {
    state.author = authorInput.value;
    ctx.view.dispatchEvent(new Event("draftchange"));
    refresh(ctx);
  });
  sendBtn.addEventListener("click", () => send(ctx, { sendBtn, sendLabel }));

  s.body.append(
    el("p", { class: "muted", text: t("ws_send_note") }),
    ctx.ui.checklist,
    el("p", { class: "field-hint", text: t("ws_check_hint") }),
    el("div", { class: "field" },
      el("label", { class: "field-label", for: "author-input", text: t("ws_answer_as") }),
      authorInput,
      el("p", { class: "field-hint", id: "author-hint", text: t("ws_author_hint") })),
    el("label", { class: "checkbox-row" }, confirmBox, el("span", { text: t("btn_confirm_author") })),
    errorSlot,
    el("div", { class: "send-row" }, sendBtn, saveState),
    sendHint);
  if (state.sourceChanged) s.body.prepend(callout("warn", {}, el("p", { text: t("ws_source_changed") })));
  refreshSend();
  return s.node;
}

function renderChecklist(ctx, c) {
  const list = ctx.ui.checklist;
  if (!list) return;
  const { state } = ctx;
  const row = (ok, text) => el("li", { dataset: { ok: String(ok) } },
    icon(ok ? "check-circle" : "circle-dashed"),
    el("span", {}, el("span", { class: "sr-only", text: `${t(ok ? "ws_check_ok" : "ws_check_pending")}: ` }), text));
  list.replaceChildren(
    row(c.requiredLeft === 0, t("ws_check_required", { n: c.requiredDone, total: c.requiredTotal })),
    row(c.commentsOk, t("ws_check_comments")),
    row(Boolean(state.author.trim() && state.authorConfirmed), t("ws_check_author")));
}

function renderErrorSummary(ctx) {
  const slot = ctx.ui.errorSlot;
  if (!slot) return null;
  const { state } = ctx;
  const items = [];
  for (const question of ctx.qs.questions ?? []) {
    const qid = question.question_id;
    for (const error of state.errors.get(qid) ?? []) {
      items.push(el("li", {},
        jumpLink(ctx, {}, () => {
          const item = ctx.items.get(qid);
          return [item?.node, errorTarget(item, error) ?? item?.title];
        }, `${qid} · ${question.title || ""}`),
        el("span", { text: ` — ${fieldErrorText(error)}` })));
    }
  }
  for (const error of state.unmappedErrors) {
    items.push(el("li", { text: [fieldErrorText(error), error.path ? `(${error.path})` : ""].filter(Boolean).join(" ") }));
  }
  if (!items.length && !state.sendError) {
    slot.replaceChildren();
    return null;
  }
  const node = callout("danger", { title: state.sendError?.status === 422 || items.length ? t("ws_errors_title") : t("ws_send_failed") },
    el("div", { class: "error-summary" },
      el("p", { text: state.sendError ? errorMessage(state.sendError) : t("err_422") }),
      items.length ? el("ul", {}, ...items) : null));
  node.id = "send-errors";
  node.setAttribute("tabindex", "-1");
  slot.replaceChildren(node);
  return node;
}

async function send(ctx, { sendBtn, sendLabel }) {
  const { qs, state } = ctx;
  // A new attempt starts clean: previous server errors no longer apply.
  const previous = [...state.errors.keys()];
  state.errors.clear();
  state.unmappedErrors = [];
  state.sendError = null;
  for (const qid of previous) renderQuestionError(ctx, qid);
  renderErrorSummary(ctx);
  ctx.sending = true;
  sendBtn.disabled = true;
  sendBtn.setAttribute("aria-busy", "true");
  sendLabel.textContent = t("ws_sending");
  try {
    await state.drafts?.pause();
    await ensureCsrf();
    const answers = [];
    for (const question of qs.questions ?? []) {
      const value = state.answers.get(question.question_id);
      if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
      const entry = { question_id: question.question_id, value };
      const comment = state.comments.get(question.question_id);
      if (comment !== undefined && comment !== "") entry.comment = comment;
      answers.push(entry);
    }
    const payload = {
      question_sha256: qs.qs_sha256,
      request_id: state.requestId ??= crypto.randomUUID(),
      answered_by: state.author.trim(),
      ui_language: language(),
      answers,
      confirmations: state.confirmations,
    };
    const receipt = await post(`/api/v1/sessions/${encodeURIComponent(qs.question_session_id)}/answers`, payload);
    state.sentReceipt = receipt;
    state.drafts?.clear();
    ctx.sending = false;
    renderSent(ctx, receipt);
  } catch (error) {
    ctx.sending = false;
    state.drafts?.resume();
    sendBtn.removeAttribute("aria-busy");
    sendLabel.textContent = t("btn_send");
    const fieldErrors = error.status === 422 ? error.fieldErrors ?? [] : [];
    for (const fieldError of fieldErrors) {
      const qid = questionForError(fieldError, qs.questions ?? []);
      if (qid) state.errors.set(qid, [...(state.errors.get(qid) ?? []), fieldError]);
      else state.unmappedErrors.push(fieldError);
    }
    state.sendError = error;
    for (const qid of state.errors.keys()) renderQuestionError(ctx, qid);
    const summary = renderErrorSummary(ctx);
    refresh(ctx);
    // Focus the first invalid question (QS order), else the error summary.
    const firstInvalid = (qs.questions ?? []).find((question) => state.errors.has(question.question_id));
    const item = firstInvalid ? ctx.items.get(firstInvalid.question_id) : null;
    const target = item ? errorTarget(item, state.errors.get(firstInvalid.question_id)[0]) : null;
    if (item && target) {
      item.node.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
      target.focus({ preventScroll: true });
    } else if (summary) {
      jumpTo(summary, summary);
    }
  }
}

function renderSent(ctx, receipt) {
  const { state } = ctx;
  ctx.locked = true;
  for (const control of ctx.ui.sec5.node.querySelectorAll("input, textarea, button:not(.binding button)")) control.disabled = true;
  for (const item of ctx.items.values()) {
    if (item.controls.comment && !item.controls.comment.value) item.controls.comment.closest(".comment-field").hidden = true;
  }
  const answered = stateChip("ANSWERED");
  ctx.ui.stateChip.replaceWith(answered);
  ctx.ui.stateChip = answered;
  ctx.ui.sec7.body.replaceChildren(
    callout("success", {}, el("p", { text: t("ws_sent_as", {
      name: state.author.trim(), date: receipt.answered_at ? formatDate(receipt.answered_at) : t("none"),
    }) })),
    el("p", { class: "muted small", text: t("ws_readonly_text", { state: lowerLabel(t("st_ANSWERED")) }) }));
  ctx.ui.checklist = null;
  ctx.ui.errorSlot = null;
  ctx.ui.sec8.body.replaceChildren(successPanel({
    title: t("ws_sent_title"), body: t("ws_sent_body"),
    ansId: receipt.answer_session_id, path: receipt.answer_path,
  }));
  for (const node of ctx.view.querySelectorAll(".mobile-bar, .ws-aside-cta")) node.remove();
  refresh(ctx);
  jumpTo(ctx.ui.sec8.node, ctx.ui.sec8.heading);
  announce(t("ws_sent_title"));
}

// ---------------------------------------------------------- what follows (8)
function successPanel({ title, body, ansId, path, noAuto = true }) {
  const ref = `${path ?? ""} (${ansId ?? ""})`;
  return el("div", { class: "success-panel" },
    el("div", { class: "success-icon" }, icon("check")),
    el("h3", { class: "ws-success-title", text: title }),
    body ? el("p", { text: body }) : null,
    noAuto ? el("p", { class: "muted", text: t("ws_no_auto") }) : null,
    el("div", { class: "strong small", text: t("ans_ref_label") }),
    el("div", { class: "ref-box" },
      idTag(ansId ?? null),
      el("span", { class: "path", text: path ?? t("none") }),
      copyButton(ref, { label: t("btn_copy") })));
}

function buildNextSection(ctx) {
  const s = section(8, t("sec8"));
  ctx.ui.sec8 = s;
  const { qs, mode } = ctx;
  if (mode === "answer") {
    s.body.append(el("p", { text: t("ws_after_send") }), el("p", { class: "muted small", text: t("ws_no_auto") }));
  } else if (mode === "answered") {
    const waiting = qs.effective_state === "ANSWERED";
    s.body.append(successPanel({
      title: waiting ? t("ws_sent_title") : t("ws_ingested_title"),
      body: waiting ? t("ws_sent_body") : t("ws_ingested_body"),
      ansId: qs.answer_session_id, path: qs.answers_path, noAuto: waiting,
    }));
  } else {
    s.body.append(el("p", { class: "muted", text: mode === "readonly"
      ? t("readonly_mode")
      : t("ws_closed_text", { state: lowerLabel(t(`st_${qs.effective_state}`)) }) }));
  }
  return s.node;
}

// -------------------------------------------------------- aside + mobile bar
function reviewButton(ctx, extraClass) {
  return el("button", {
    class: ["btn btn--primary", extraClass], type: "button",
    onclick: () => jumpTo(ctx.ui.sec7.node, ctx.ui.sec7.heading),
  }, icon("send"), t("btn_review_send"));
}

function buildAside(ctx, showQuestions) {
  const aside = el("aside", { class: "ws-aside", "aria-label": t("ws_jump") });
  const showProgress = showQuestions && (ctx.mode === "answer" || ctx.mode === "answered");
  if (showProgress) {
    ctx.ui.asideCount = el("strong", { class: "tnum" });
    ctx.ui.asideBar = progressBar(0, 1, t("ws_progress"));
    ctx.ui.asideLeft = el("p", { class: "small muted" });
    aside.append(el("div", { class: "card stack-sm" },
      el("div", { class: "progress-label" }, el("span", { text: t("ws_progress") }), ctx.ui.asideCount),
      ctx.ui.asideBar,
      ctx.ui.asideLeft,
      ctx.mode === "answer" ? el("div", { class: "stack-sm ws-aside-cta" },
        el("span", { class: "save-state" }),
        reviewButton(ctx, "btn--block")) : null));
  }
  if (showQuestions) {
    ctx.ui.qnav = el("ol", { class: "qnav" });
    aside.append(el("nav", { class: "card stack-sm", "aria-label": t("ws_jump") },
      el("div", { class: "strong small", text: t("ws_jump") }),
      ctx.ui.qnav));
  }
  return aside;
}

function buildMobileBar(ctx) {
  ctx.ui.mobileBar = progressBar(0, 1, t("ws_progress"));
  ctx.ui.mobileCount = el("span", { class: "mobile-count" });
  return el("div", { class: "mobile-bar" }, ctx.ui.mobileBar, ctx.ui.mobileCount, reviewButton(ctx, "btn--sm"));
}

function renderQnav(ctx) {
  if (!ctx.ui.qnav) return;
  ctx.ui.qnav.replaceChildren(...(ctx.qs.questions ?? []).map((question) => {
    const qid = question.question_id;
    const { status } = assess(question, ctx.state);
    const link = jumpLink(ctx, { title: question.title || qid }, () => {
      const item = ctx.items.get(qid);
      return [item?.node, item?.title];
    },
    el("span", { class: "qnav-dot", "aria-hidden": "true" }),
    el("span", { class: "qnav-text" }, question.title || qid,
      el("span", { class: "sr-only", text: ` — ${t(`ws_status_${status}`)}` })));
    if (status !== "missing") link.dataset.status = status;
    return el("li", {}, link);
  }));
}

// ------------------------------------------------------------------ refresh
function refresh(ctx) {
  const c = counts(ctx);
  for (const item of ctx.items.values()) {
    const { status } = assess(item.question, ctx.state);
    item.node.dataset.status = status;
    item.refreshComment?.();
  }
  if (ctx.ui.asideCount) {
    ctx.ui.asideCount.textContent = `${c.answered}/${c.total}`;
    setProgress(ctx.ui.asideBar, c.answered, c.total);
    ctx.ui.asideLeft.textContent = c.requiredLeft ? t("ws_required_left", { n: c.requiredLeft }) : t("ws_all_required_done");
  }
  if (ctx.ui.mobileBar) {
    setProgress(ctx.ui.mobileBar, c.answered, c.total);
    ctx.ui.mobileCount.textContent = t("ws_progress_of", { n: c.answered, total: c.total });
  }
  renderQnav(ctx);
  renderSummary(ctx);
  renderChecklist(ctx, c);
  if (!ctx.locked) ctx.ui.refreshSend?.();
}

// ---------------------------------------------------------------- autosave
function wireDraftAutosave(view, qsId, qs, state) {
  const key = draftStorageKey(qsId);
  let timer = null;
  let dirty = state.pendingDraft;
  let revision = 0;
  let inFlight = null;
  let paused = false;

  // Every visible save indicator (aside + section 7) mirrors the same state.
  const setSaveState = (kind, text) => {
    for (const node of view.querySelectorAll(".save-state")) {
      node.dataset.state = kind;
      node.textContent = text;
    }
  };
  const remember = () => {
    try {
      sessionStorage.setItem(key, JSON.stringify({ etag: state.etag, payload: draftPayload(qs, state) }));
    } catch (_error) {
      setSaveState("error", t("ws_draft_error"));
    }
  };
  const save = () => {
    clearTimeout(timer);
    if (!dirty || paused || inFlight || !view.isConnected || state.sentReceipt || !qs.qs_sha256) return inFlight;
    const savedRevision = revision;
    const payload = draftPayload(qs, state);
    const headers = state.etag ? { "If-Match": state.etag } : { "If-None-Match": "*" };
    setSaveState("saving", t("ws_draft_saving"));
    inFlight = (async () => {
      let saved = false;
      let retry = false;
      try {
        await ensureCsrf();
        const response = await put(`/api/v1/sessions/${encodeURIComponent(qsId)}/draft`, payload, headers);
        state.etag = response.etag;
        dirty = revision !== savedRevision;
        saved = true;
        if (view.isConnected) {
          if (dirty) remember();
          else sessionStorage.removeItem(key);
          setSaveState(dirty ? "saving" : "saved", t(dirty ? "ws_draft_saving" : "ws_draft_saved"));
        }
      } catch (error) {
        setSaveState("error", t(error.status === 412 ? "err_412" : error.code === "WRITES_DISABLED" ? "ws_draft_local_only" : "ws_draft_error"));
        // Transient failures (network, 423 lock, 503) retry; a 412 conflict never
        // overwrites the other tab's draft.
        retry = error.status !== 412 && !(error.status >= 400 && error.status < 500 && error.status !== 423);
      } finally {
        inFlight = null;
        if (saved && dirty && !paused && view.isConnected) timer = setTimeout(save, SAVE_DEBOUNCE_MS);
        else if (retry && dirty && !paused && view.isConnected) timer = setTimeout(save, SAVE_RETRY_MS);
      }
    })();
    return inFlight;
  };
  view.addEventListener("draftchange", () => {
    if (state.sentReceipt) return;
    dirty = true;
    revision += 1;
    remember();
    clearTimeout(timer);
    if (!paused) timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  });
  if (dirty) timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  else if (state.answers.size || state.comments.size) {
    setSaveState("saved", t("ws_draft_saved"));
  }
  return {
    async pause() {
      paused = true;
      clearTimeout(timer);
      await inFlight;
    },
    resume() {
      paused = false;
      if (dirty) timer = setTimeout(save, SAVE_DEBOUNCE_MS);
    },
    clear() {
      paused = true;
      clearTimeout(timer);
      try { sessionStorage.removeItem(key); } catch (_error) { /* Server ANS is already committed. */ }
    },
  };
}
