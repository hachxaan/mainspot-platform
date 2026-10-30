/**
 * Propuestas de página web que prepara MainSpot (DEV-E2E-03), no el chat:
 *
 * - Primera página (`website.initial`): un negocio dado de alta por invitación no tiene
 *   `client_website`; el dueño la crea con los datos del alta (`POST /website` con `data`) y
 *   MainSpot prepara su PRIMERA versión.
 * - Teléfono de la página (`website.phone`): al cambiar el número del canal Página web en
 *   «Teléfonos de contacto», la página publicada sigue mostrando el anterior hasta publicar una
 *   versión nueva con el número efectivo (una sola fuente del número; el chat no lo edita).
 * - Restaurar una versión (`website.restore`, DEV-E2E-04 P3): «Restaurar esta versión» NO reescribe
 *   el historial: prepara una propuesta cuyo `after` son los datos de la versión elegida (teléfono
 *   efectivo actual) con diff «actual vs solicitada» y referencia a la fuente; al aprobarse se
 *   publica como versión NUEVA. Guard optimista (`expected_current_version`) e idempotencia por
 *   `Idempotency-Key` (repetir no crea otra propuesta ni otra versión).
 *
 * Todas son propuestas normales con vista previa lista que SOLO se publican tras aprobación
 * humana (RULE-003). Idempotentes: mientras haya una abierta del mismo tipo se devuelve la misma;
 * un candado consultivo por tenant evita duplicados por clics o sesiones simultáneas.
 */

import type { Pool, PoolClient } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { AppError } from '../shared/errors.ts';
import { newConversationIds, type ActionProposalRow, type ConversationRepository } from '../conversation/repositories.ts';
import { confirmAndPreparePreview, rejectProposal, runAtomic, type StateMachineDeps } from '../conversation/state-machine.ts';
import { formatInternational, type ContactPhoneService } from '../contact/phones.ts';
import { restoreRefOf } from '../publishing/website.ts';
import { normalizeWebsiteData, type WebsiteData } from './template.ts';
import type { ClientWebsiteRow, WebsiteRepository } from './repository.ts';

export const INITIAL_PROPOSAL_TYPE = 'website.initial';
export const PHONE_PROPOSAL_TYPE = 'website.phone';
export const RESTORE_PROPOSAL_TYPE = 'website.restore';
const OPEN_STATES = ['awaiting_confirmation', 'confirmed', 'preview_ready', 'approved_for_publish', 'failed'] as const;

const LIMITS: Record<'line' | 'about' | 'address' | 'hours' | 'email', number> = {
  line: 160, about: 600, address: 200, hours: 200, email: 200,
};

/** Valida los datos opcionales del alta para la página (sin teléfono: sale de «Teléfonos»). */
export function initialWebsiteData(siteName: string, raw: unknown): WebsiteData | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError(400, 'validation_error', 'Los datos de la página no son válidos.');
  }
  const b = raw as Record<string, unknown>;
  if ('phone' in b) {
    throw new AppError(400, 'validation_error', 'El teléfono de la página se configura en «Teléfonos de contacto».');
  }
  const out: Record<string, unknown> = { name: siteName };
  for (const [key, max] of Object.entries(LIMITS)) {
    const v = b[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || v.trim().length > max) {
      throw new AppError(400, 'validation_error', `Revisa el campo «${key}»: admite hasta ${max} caracteres.`);
    }
    out[key] = v.trim();
  }
  if (b['services'] !== undefined) {
    const s = b['services'];
    if (!Array.isArray(s) || s.length > 12 || s.some((x) => typeof x !== 'string' || !x.trim() || x.trim().length > 80)) {
      throw new AppError(400, 'validation_error', 'Elige hasta 12 cosas que vendes, de hasta 80 caracteres cada una.');
    }
    out['services'] = [...new Set(s.map((x: string) => x.trim()))];
  }
  return normalizeWebsiteData(out);
}

export interface SiteProposalDeps {
  pool: Pool;
  sink: AuditSink;
  repo: ConversationRepository;
  machine: StateMachineDeps;
  websiteRepo: WebsiteRepository;
  phones: ContactPhoneService;
}

export interface SiteProposalInput {
  tenantId: string;
  actorId: string;
  actorRole: string | null;
  requestId: string;
}

export interface SiteProposalOutcome {
  proposal: ActionProposalRow;
  created: boolean;
  preview: { url: string; expires_at: string } | null;
}

interface Draft {
  summary: string;
  detail: Record<string, unknown>;
}

async function requireSite(deps: SiteProposalDeps, tenantId: string): Promise<ClientWebsiteRow> {
  const site = await deps.websiteRepo.websiteForTenant(tenantId);
  if (!site) {
    throw new AppError(409, 'website_missing', 'Todavía no tienes página. Primero créala con los datos de tu negocio.');
  }
  return site;
}

/**
 * Devuelve la propuesta abierta del tipo o crea una nueva (bajo candado por tenant) y la deja con
 * su vista previa lista. `stale` decide si una abierta ya no corresponde (p. ej. otro número):
 * se descarta antes de crear la nueva.
 */
async function openOrCreate(
  deps: SiteProposalDeps, input: SiteProposalInput, type: string, draft: Draft,
  stale: (open: ActionProposalRow) => boolean = () => false,
): Promise<SiteProposalOutcome> {
  const found = await runAtomic(deps.pool, async (client: PoolClient) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`site-proposal:${input.tenantId}`]);
    const open = await client.query<ActionProposalRow>(
      `SELECT * FROM action_proposal WHERE tenant_id = $1 AND proposal_type = $2 AND status = ANY($3::text[])
        ORDER BY created_at DESC LIMIT 1`,
      [input.tenantId, type, [...OPEN_STATES]]);
    const row = open.rows[0];
    if (row && !stale(row)) return { proposal: row, created: false, replaced: null };
    const ids = newConversationIds();
    await deps.repo.createRequest({
      requestId: ids.requestId, tenantId: input.tenantId, actorId: input.actorId, channel: 'simulated',
      rawMessage: draft.summary, intent: type, capabilityTarget: 'website', actionClass: 'preview_required',
      status: 'awaiting_confirmation', responseMessage: null, proposalId: ids.proposalId,
    }, client);
    const created = await deps.repo.createProposal({
      proposalId: ids.proposalId, tenantId: input.tenantId, requestId: ids.requestId,
      capabilityTarget: 'website', proposalType: type, actionClass: 'preview_required', summary: draft.summary,
      detail: draft.detail, status: 'awaiting_confirmation', createdBy: input.actorId,
    }, client);
    await deps.sink.write({
      tenant_id: input.tenantId, actor_id: input.actorId, actor_role: input.actorRole,
      action: 'website.proposal.prepared', resource: `action_proposal/${ids.proposalId}`, request_id: input.requestId,
      decision: 'allow', result: type,
    }, client);
    return { proposal: created, created: true, replaced: row ?? null };
  });

  // Una propuesta anterior del mismo tipo que ya no corresponde se descarta (sin publicar nada).
  if (found.replaced && ['awaiting_confirmation', 'confirmed', 'preview_ready'].includes(found.replaced.status)) {
    await rejectProposal(deps.machine, {
      tenantId: input.tenantId, proposalId: found.replaced.proposal_id, actorId: input.actorId, requestId: input.requestId,
    }).catch(() => undefined);
  }

  const { proposal, created } = found;
  if (proposal.status !== 'awaiting_confirmation') return { proposal, created, preview: null };
  try {
    const prepared = await confirmAndPreparePreview(deps.machine, {
      tenantId: input.tenantId, proposalId: proposal.proposal_id, actorId: input.actorId, requestId: input.requestId,
    });
    return { proposal: prepared.proposal, created, preview: { url: `/preview/${prepared.token}`, expires_at: prepared.expiresAt } };
  } catch (err) {
    // Otra sesión preparó la vista previa en paralelo: se devuelve el estado vigente.
    if (!(err instanceof AppError) || err.status !== 409) throw err;
    const now = await deps.repo.findProposalScoped(input.tenantId, proposal.proposal_id);
    return { proposal: (now.row ?? proposal) as ActionProposalRow, created, preview: null };
  }
}

/** Primera versión de la página con los datos del alta (vista previa lista, sin publicar). */
export async function prepareFirstPage(deps: SiteProposalDeps, input: SiteProposalInput): Promise<SiteProposalOutcome> {
  const site = await requireSite(deps, input.tenantId);
  if (Number(site.published_version) > 0) {
    throw new AppError(409, 'already_published', 'Tu página ya está publicada. Para cambiarla, pide un cambio.');
  }
  const data = normalizeWebsiteData({ ...site.data, name: (site.data as { name?: unknown }).name || site.site_name });
  const summary = 'Publicar la primera versión de tu página con los datos de tu negocio.';
  return openOrCreate(deps, input, INITIAL_PROPOSAL_TYPE, { summary, detail: { after: data, diff_sentences: [summary], patches: [] } });
}

/** Nueva versión de la página publicada con el teléfono efectivo del canal Página web. */
export async function preparePhoneUpdate(deps: SiteProposalDeps, input: SiteProposalInput): Promise<SiteProposalOutcome> {
  const site = await requireSite(deps, input.tenantId);
  if (Number(site.published_version) === 0) {
    throw new AppError(409, 'validation_error', 'Tu página todavía no está publicada: su primera versión ya usará este número.');
  }
  const effective = await deps.phones.effectivePhone(input.tenantId, 'website');
  if (!effective) {
    throw new AppError(409, 'validation_error', 'Primero elige el número de tu página en «Teléfonos de contacto».');
  }
  const current = deps.websiteRepo.dataOf(site);
  const phone = formatInternational(effective);
  if (current.phone === phone) {
    throw new AppError(409, 'validation_error', 'Tu página ya muestra ese número. No hay nada que publicar.');
  }
  const sentence = `Cambiar el teléfono de tu página de ${current.phone || '(sin teléfono)'} a ${phone}.`;
  const patch = { field: 'contact.phone', kind: 'change', label: 'teléfono', before: current.phone || '(sin teléfono)', after: phone, sentence };
  return openOrCreate(deps, input, PHONE_PROPOSAL_TYPE,
    { summary: sentence, detail: { after: { ...current, phone }, diff_sentences: [sentence], patches: [patch] } },
    (open) => ((open.detail as { after?: { phone?: unknown } }).after?.phone ?? null) !== phone);
}

export const AI_DESIGN_PROPOSAL_TYPE = 'website.ai_design' as const;
export const AI_EDIT_PROPOSAL_TYPE = 'website.ai_edit' as const;

export interface AiSiteChange {
  type: typeof AI_DESIGN_PROPOSAL_TYPE | typeof AI_EDIT_PROPOSAL_TYPE;
  after: WebsiteData;
  summary: string;
  sentences: string[];
  /** Trazabilidad: invocaciones, versión de marca y job (nunca prompts ni salidas crudas). */
  ai: { job_id: string; invocation_ids: string[]; brand_version: number | null; route_ids: string[] };
}

/**
 * Diseño o edición generada por el AI Core: misma vista previa/aprobación humana que cualquier
 * cambio. Guarda la versión publicada sobre la que se generó (`base_version`): si al aprobar hay
 * otra encima, el publicador responde 409 y no pisa nada. Un job nuevo reemplaza la abierta.
 */
export async function prepareAiSiteChange(deps: SiteProposalDeps, input: SiteProposalInput, change: AiSiteChange): Promise<SiteProposalOutcome> {
  const site = await requireSite(deps, input.tenantId);
  const base = Number(site.published_version);
  if (change.type === AI_EDIT_PROPOSAL_TYPE && base === 0) {
    throw new AppError(409, 'validation_error', 'Tu página todavía no está publicada: primero publica su primera versión.');
  }
  const out = await openOrCreate(deps, input, change.type, {
    summary: change.summary.slice(0, 240),
    detail: { after: change.after, diff_sentences: change.sentences.slice(0, 20), patches: [], base_version: base, ai: change.ai },
  }, (open) => (open.detail as { ai?: { job_id?: unknown } }).ai?.job_id !== change.ai.job_id);
  // Página sin publicar: el diseño reemplaza a la «primera versión» clásica pendiente (una sola
  // primera publicación). Se descarta sin publicar nada.
  if (change.type === AI_DESIGN_PROPOSAL_TYPE && base === 0 && out.created) {
    const open = await deps.pool.query<{ proposal_id: string }>(
      'SELECT proposal_id FROM action_proposal WHERE tenant_id = $1 AND proposal_type = $2 AND status = ANY($3::text[])',
      [input.tenantId, INITIAL_PROPOSAL_TYPE, ['awaiting_confirmation', 'confirmed', 'preview_ready']]);
    for (const row of open.rows) {
      await rejectProposal(deps.machine, { tenantId: input.tenantId, proposalId: row.proposal_id, actorId: input.actorId, requestId: input.requestId }).catch(() => undefined);
    }
  }
  return out;
}

export interface RestoreInput {
  /** Versión a restaurar (website_content.version del tenant). */
  version: number;
  /** Versión que el cliente ve como publicada; si no coincide con la real ⇒ 409 stale_version. */
  expectedCurrentVersion: number;
  /** Clave de idempotencia (cabecera o request_id): repetirla devuelve la misma propuesta. */
  idempotencyKey: string;
}

interface VersionRow {
  content_id: string;
  version: number;
  data: Record<string, unknown> | null;
  proposal_after: Record<string, unknown> | null;
}

/** Campos comparables en el diff «actual vs solicitada» (mismos `field` que entiende el panel). */
const RESTORE_FIELDS: ReadonlyArray<{ key: 'name' | 'line' | 'about' | 'hours' | 'address' | 'email'; field: string; label: string }> = [
  { key: 'name', field: 'site.name', label: 'nombre' },
  { key: 'line', field: 'site.line', label: 'frase' },
  { key: 'about', field: 'site.generic', label: 'descripción' },
  { key: 'hours', field: 'schedule.hours', label: 'horario' },
  { key: 'address', field: 'contact.address', label: 'dirección' },
  { key: 'email', field: 'site.generic', label: 'correo' },
];

/** Diferencias entre la página actual y la versión solicitada, en lenguaje claro. */
export function restorePatches(current: WebsiteData, requested: WebsiteData): Array<Record<string, string>> {
  const patches: Array<Record<string, string>> = [];
  for (const f of RESTORE_FIELDS) {
    const before = current[f.key] || '';
    const after = requested[f.key] || '';
    if (before === after) continue;
    const sentence = `Cambiar ${f.label} de «${before || '(sin dato)'}» a «${after || '(sin dato)'}».`;
    patches.push({ field: f.field, kind: 'change', label: f.label, before, after, sentence });
  }
  const cur = new Set(current.services), req = new Set(requested.services);
  for (const s of requested.services) if (!cur.has(s)) patches.push({ field: 'service.add', kind: 'add', label: 'lo que vendes', before: '', after: s, sentence: `Agregar «${s}» a lo que vendes.` });
  for (const s of current.services) if (!req.has(s)) patches.push({ field: 'site.generic', kind: 'remove', label: 'lo que vendes', before: s, after: '', sentence: `Quitar «${s}» de lo que vendes.` });
  const curSec = new Set(current.sections.map((s) => s.title)), reqSec = new Set(requested.sections.map((s) => s.title));
  for (const s of requested.sections) if (!curSec.has(s.title)) patches.push({ field: 'section.add', kind: 'add', label: 'sección', before: '', after: s.title, sentence: `Agregar la sección «${s.title}».` });
  for (const s of current.sections) if (!reqSec.has(s.title)) patches.push({ field: 'site.generic', kind: 'remove', label: 'sección', before: s.title, after: '', sentence: `Quitar la sección «${s.title}».` });
  return patches;
}

/**
 * Propuesta de restauración de la versión `version` (vista previa lista, sin publicar). Devuelve la
 * propuesta ya existente si la clave de idempotencia se repite (cualquier estado) o si hay una
 * abierta para la misma versión; una abierta para OTRA versión se descarta antes de crear la nueva.
 */
export async function prepareRestore(deps: SiteProposalDeps, input: SiteProposalInput, restore: RestoreInput): Promise<SiteProposalOutcome & { replayed: boolean }> {
  const site = await requireSite(deps, input.tenantId);
  if (!Number.isInteger(restore.version) || restore.version < 1) {
    throw new AppError(400, 'validation_error', 'Elige una versión válida para restaurar.');
  }
  // Idempotencia: la misma clave devuelve la misma propuesta aunque ya esté publicada (sin duplicar versión).
  const replay = await deps.pool.query<ActionProposalRow>(
    `SELECT * FROM action_proposal WHERE tenant_id = $1 AND proposal_type = $2 AND detail #>> '{restore,idempotency_key}' = $3
      ORDER BY created_at DESC LIMIT 1`, [input.tenantId, RESTORE_PROPOSAL_TYPE, restore.idempotencyKey]);
  const prior = replay.rows[0];
  if (prior) return { proposal: prior, created: false, replayed: true, preview: null };

  const live = Number(site.published_version);
  if (live === 0) {
    throw new AppError(409, 'validation_error', 'Tu página todavía no está publicada: no hay versiones que restaurar.');
  }
  if (restore.expectedCurrentVersion !== live) {
    throw new AppError(409, 'stale_version', `Tu página cambió mientras la mirabas: ahora está publicada la versión ${live}. Vuelve a elegir la versión que quieres restaurar.`);
  }
  if (restore.version === live) {
    throw new AppError(409, 'validation_error', `La versión ${live} es la que ya está publicada. Elige otra versión.`);
  }
  const src = await deps.pool.query<VersionRow>(
    `SELECT wc.content_id, wc.version, wc.data, ap.detail->'after' AS proposal_after
       FROM website_content wc LEFT JOIN action_proposal ap ON ap.proposal_id = wc.proposal_id AND ap.tenant_id = wc.tenant_id
      WHERE wc.tenant_id = $1 AND wc.website_id = $2 AND wc.version = $3`, [input.tenantId, site.website_id, restore.version]);
  const row = src.rows[0];
  if (!row) {
    throw new AppError(404, 'not_found', 'No encontramos esa versión de tu página.');
  }
  const sourceRaw = row.data ?? row.proposal_after;
  if (!sourceRaw || typeof sourceRaw !== 'object') {
    throw new AppError(409, 'version_not_restorable', `La versión ${restore.version} no guardó sus datos y no se puede restaurar automáticamente.`);
  }
  const current = deps.websiteRepo.dataOf(site);
  // El teléfono sigue saliendo de «Teléfonos de contacto» (una sola fuente), igual que al publicar.
  const effective = await deps.phones.effectivePhone(input.tenantId, 'website');
  const requested = normalizeWebsiteData({ ...normalizeWebsiteData(sourceRaw), phone: effective ? formatInternational(effective) : current.phone });
  const patches = restorePatches(current, requested);
  const summary = `Volver a la versión ${restore.version} de tu página (hoy está publicada la versión ${live}).`;
  const sentences = [summary, ...patches.map((p) => p['sentence'] as string)];
  if (patches.length === 0) sentences.push('El contenido es el mismo que el de hoy; solo cambia el número de versión.');
  const detail = {
    after: requested, diff_sentences: sentences, patches,
    restore: { source_version: restore.version, source_content_id: row.content_id, current_version: live, idempotency_key: restore.idempotencyKey },
  };
  const out = await openOrCreate(deps, input, RESTORE_PROPOSAL_TYPE, { summary, detail },
    (open) => restoreRefOf(open.detail['restore'])?.source_version !== restore.version);
  if (out.created) {
    await deps.sink.write({
      tenant_id: input.tenantId, actor_id: input.actorId, actor_role: input.actorRole,
      action: 'website.restore.requested', resource: `website_content/${row.content_id}`, request_id: input.requestId,
      decision: 'allow', result: `v${restore.version}_over_v${live}`, evidence_ref: out.proposal.proposal_id,
    });
  }
  return { ...out, replayed: false };
}
