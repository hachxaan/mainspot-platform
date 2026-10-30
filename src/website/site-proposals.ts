/**
 * Propuestas de página web que prepara MainSpot (DEV-E2E-03), no el chat:
 *
 * - Primera página (`website.initial`): un negocio dado de alta por invitación no tiene
 *   `client_website`; el dueño la crea con los datos del alta (`POST /website` con `data`) y
 *   MainSpot prepara su PRIMERA versión.
 * - Teléfono de la página (`website.phone`): al cambiar el número del canal Página web en
 *   «Teléfonos de contacto», la página publicada sigue mostrando el anterior hasta publicar una
 *   versión nueva con el número efectivo (una sola fuente del número; el chat no lo edita).
 *
 * Ambas son propuestas normales con vista previa lista que SOLO se publican tras aprobación
 * humana (RULE-003). Idempotentes: mientras haya una abierta del mismo tipo se devuelve la misma;
 * un candado consultivo por tenant evita duplicados por clics o sesiones simultáneas.
 */

import type { Pool, PoolClient } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { AppError } from '../shared/errors.ts';
import { newConversationIds, type ActionProposalRow, type ConversationRepository } from '../conversation/repositories.ts';
import { confirmAndPreparePreview, rejectProposal, runAtomic, type StateMachineDeps } from '../conversation/state-machine.ts';
import { formatInternational, type ContactPhoneService } from '../contact/phones.ts';
import { normalizeWebsiteData, type WebsiteData } from './template.ts';
import type { ClientWebsiteRow, WebsiteRepository } from './repository.ts';

export const INITIAL_PROPOSAL_TYPE = 'website.initial';
export const PHONE_PROPOSAL_TYPE = 'website.phone';
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
