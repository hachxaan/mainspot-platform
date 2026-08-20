/**
 * State machine de preview/aprobación (INC-002, FLOW-002, CAP-008).
 *
 * Estados: drafted → awaiting_confirmation → confirmed → preview_ready
 *          → approved_for_publish → published | rejected | expired | failed
 *
 * Invariantes:
 *  - Publicación SOLO desde preview/sandbox aprobado (AC-007, RULE-003).
 *  - Decisiones sensibles SOLO con aprobación humana (AC-004, RULE-004).
 *  - Idempotencia: repetir una aprobación NO duplica publicaciones
 *    (publish_key UNIQUE como backstop) — AC-007.
 *  - Fail-closed: las transiciones sensibles y su auditoría son atómicas
 *    (COMMIT/ROLLBACK con la operación).
 */
import type { Pool, PoolClient } from 'pg';
import type { AuditEventInput } from '../audit/event.ts';
import type { AuditSink } from '../audit/sink.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { PublisherRegistry, type PublisherContext } from '../publishing/publisher.ts';
import {
  ConversationRepository,
  newConversationIds,
  type ActionProposalRow,
} from './repositories.ts';
import { generatePreviewToken, hashPreviewToken, previewExpiry, verifyPreviewToken } from './preview-token.ts';
import type { PublicationRow } from './repositories.ts';

export interface StateMachineDeps {
  pool: Pool;
  sink: AuditSink;
  repo: ConversationRepository;
  publishers: PublisherRegistry;
  previewTtlMinutes: number;
}

export interface PublishOutcome {
  proposal: ActionProposalRow;
  publication: PublicationRow | null;
  alreadyPublished: boolean;
  published: boolean;
}

export async function runAtomic<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Auditoría dentro de una transacción (fail-closed: si falla, ROLLBACK). */
async function auditInTx(sink: AuditSink, client: PoolClient, input: Omit<AuditEventInput, 'decision' | 'result'>): Promise<void> {
  await sink.write({ ...input, decision: 'allow', result: 'success' }, client);
}

/** Genera el preview/sandbox tras la confirmación (confirmed → preview_ready). */
export async function confirmAndPreparePreview(
  deps: StateMachineDeps,
  input: { tenantId: string; proposalId: string; actorId: string; requestId: string },
): Promise<{ previewId: string; token: string; expiresAt: string; proposal: ActionProposalRow }> {
  const found = await deps.repo.findProposalScoped(input.tenantId, input.proposalId);
  if (!found.found || !found.in_tenant) {
    throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró la propuesta solicitada.');
  }
  const proposal = found.row as ActionProposalRow;
  if (proposal.status !== 'awaiting_confirmation') {
    throw new AppError(409, 'validation_error', 'La propuesta no está esperando confirmación. No se puede preparar la vista previa en su estado actual.');
  }

  const token = generatePreviewToken();
  const tokenHash = hashPreviewToken(token);
  const expiresAt = previewExpiry(deps.previewTtlMinutes).toISOString();
  const ids = newConversationIds();

  const proposalOut = await runAtomic(deps.pool, async (client) => {
    await deps.repo.updateProposalStatus(input.tenantId, input.proposalId, 'confirmed', { confirmedBy: input.actorId }, 'awaiting_confirmation', client);
    await deps.repo.createPreview({
      previewId: ids.previewId, proposalId: input.proposalId, tenantId: input.tenantId,
      tokenHash, expiresAt, createdBy: input.actorId,
    }, client);
    const p = await deps.repo.updateProposalStatus(input.tenantId, input.proposalId, 'preview_ready', { previewId: ids.previewId }, 'confirmed', client);
    const row = p.row as ActionProposalRow;
    await auditInTx(deps.sink, client, {
      tenant_id: input.tenantId, actor_id: input.actorId,
      actor_role: null, action: 'conversation.confirmed', resource: `action_proposal/${input.proposalId}`,
      request_id: input.requestId, evidence_ref: ids.previewId,
    });
    await auditInTx(deps.sink, client, {
      tenant_id: input.tenantId, actor_id: input.actorId,
      actor_role: null, action: 'conversation.preview.created', resource: `action_proposal/${input.proposalId}`,
      request_id: input.requestId, evidence_ref: ids.previewId,
    });
    return row;
  });

  return { previewId: ids.previewId, token, expiresAt, proposal: proposalOut };
}

/** Rechazo (estados previos a publicación → rejected). */
export async function rejectProposal(
  deps: StateMachineDeps,
  input: { tenantId: string; proposalId: string; actorId: string; requestId: string },
): Promise<ActionProposalRow> {
  const found = await deps.repo.findProposalScoped(input.tenantId, input.proposalId);
  if (!found.found || !found.in_tenant) {
    throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró la propuesta solicitada.');
  }
  const proposal = found.row as ActionProposalRow;
  if (proposal.status === 'rejected') return proposal; // idempotente
  const allowed = ['drafted', 'awaiting_confirmation', 'confirmed', 'preview_ready'] as const;
  if (!(allowed as readonly string[]).includes(proposal.status)) {
    throw new AppError(409, 'validation_error', 'La propuesta ya no puede rechazarse en su estado actual.');
  }

  const ids = newConversationIds();
  const out = await runAtomic(deps.pool, async (client) => {
    await deps.repo.insertApproval({
      approvalId: ids.approvalId, proposalId: input.proposalId, tenantId: input.tenantId,
      approvedBy: input.actorId, decision: 'reject', requestId: input.requestId,
    }, client);
    const p = await deps.repo.updateProposalStatus(input.tenantId, input.proposalId, 'rejected', { rejectedBy: input.actorId }, proposal.status, client);
    await auditInTx(deps.sink, client, {
      tenant_id: input.tenantId, actor_id: input.actorId,
      actor_role: null, action: 'conversation.rejected', resource: `action_proposal/${input.proposalId}`,
      request_id: input.requestId, evidence_ref: ids.approvalId,
    });
    return p.row as ActionProposalRow;
  });
  return out;
}

/**
 * Aprobación humana + publicación idempotente (AC-007).
 * - Si ya está publicada ⇒ devuelve alreadyPublished (NO pública de nuevo).
 * - Estados válidos: preview_ready (cambios visibles), drafted
 *   (decisiones sensibles sin preview),
 *   failed (reintento tras fallo del publisher).
 * - El publisher falla ⇒ proposal → failed, publication → failed,
 *   approvación humana registrada, auditoría deny; reintentable.
 */
export async function approveAndPublish(
  deps: StateMachineDeps,
  input: {
    tenantId: string; proposalId: string; actorId: string; requestId: string;
    source?: 'backoffice' | 'preview'; actorRole?: string | null;
  },
): Promise<PublishOutcome> {
  const found = await deps.repo.findProposalScoped(input.tenantId, input.proposalId);
  if (!found.found || !found.in_tenant) {
    throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró la propuesta solicitada.');
  }
  const proposal = found.row as ActionProposalRow;

  // Idempotencia por replay: ya publicada ⇒ devolver sin mutar estado.
  if (proposal.status === 'published') {
    const existing = await deps.repo.publicationByProposal(input.tenantId, input.proposalId);
    await deps.sink.write({
      tenant_id: input.tenantId, actor_id: input.actorId, actor_role: input.actorRole ?? null,
      action: 'conversation.publish_attempt', resource: `action_proposal/${input.proposalId}`,
      request_id: input.requestId, decision: 'allow', result: 'already_published',
      evidence_ref: existing?.publication_id ?? null,
    });
    return { proposal, publication: existing, alreadyPublished: true, published: false };
  }

  const validStates = [proposal.action_class === 'human_approval_required' ? 'drafted' : 'preview_ready', 'failed'] as const;
  if (!(validStates as readonly string[]).includes(proposal.status)) {
    throw new AppError(409, 'validation_error', 'La propuesta no está lista para aprobarse en su estado actual. Para cambios visibles primero se prepara la vista previa.');
  }

  const publisher = deps.publishers.get(proposal.capability_target === 'website' ? 'website' : 'stub');
  if (!publisher) {
    throw new AppError(500, DENY_CODES.INTERNAL, 'No hay un publicador disponible para este cambio.');
  }

  const ids = newConversationIds();
  const attempt = 1 + await deps.repo.countPublicationsByProposal(input.tenantId, input.proposalId);
  const publishKey = `pub_${input.proposalId}_${attempt}`;
  const pctx: PublisherContext = {
    tenantId: input.tenantId,
    proposalId: input.proposalId,
    proposalType: proposal.proposal_type,
    payload: proposal.detail,
  };

  const source = input.source ?? 'backoffice';
  const actorLabel = source === 'preview' ? 'preview_token' : input.actorId;

  return runAtomic(deps.pool, async (client) => {
    // 1. Registrar decisión humana (solo la primera vez; en retry se re-registra).
    await deps.repo.insertApproval({
      approvalId: ids.approvalId, proposalId: input.proposalId, tenantId: input.tenantId,
      approvedBy: actorLabel, decision: 'approve', requestId: input.requestId,
    }, client);
    // Guard antiraza (TOCTOU): si el estado ya cambió (otra aprobación en
    // paralelo), NO se ejecuta el publisher. Auditoría deny fuera de la tx
    // (independiente del ROLLBACK) para no perder la traza.
    const transitioned = await deps.repo.updateProposalStatus(
      input.tenantId, input.proposalId, 'approved_for_publish',
      { approvedBy: actorLabel }, proposal.status, client,
    );
    if (!transitioned.found) {
      await deps.sink.write({
        tenant_id: input.tenantId, actor_id: actorLabel, actor_role: input.actorRole ?? null,
        action: 'conversation.approved', resource: `action_proposal/${input.proposalId}`,
        request_id: input.requestId, decision: 'deny', result: 'state_conflict',
      }, deps.pool, false).catch(() => undefined);
      throw new AppError(409, 'validation_error', 'La propuesta cambió de estado mientras se procesaba. Revisa el estado actual e inténtalo de nuevo.');
    }

    const result = await publisher.publish(pctx, client);
    if (!result.ok) {
      // Fallo controlado: se registra publish failed + proposal failed + auditoría deny.
      await deps.repo.insertPublication({
        publicationId: ids.publicationId, proposalId: input.proposalId, tenantId: input.tenantId,
        publishKey, attempt, publisher: publisher.name, publishedBy: actorLabel, source,
      }, client);
      await deps.repo.markPublicationFailed(input.tenantId, input.proposalId, result.error ?? 'publish_failed', client);
      const failedRow = await deps.repo.updateProposalStatus(input.tenantId, input.proposalId, 'failed', {}, 'approved_for_publish', client);
      await deps.sink.write({
        tenant_id: input.tenantId, actor_id: actorLabel, actor_role: input.actorRole ?? null,
        action: 'conversation.approved', resource: `action_proposal/${input.proposalId}`,
        request_id: input.requestId, decision: 'deny', result: 'publish_failed', evidence_ref: ids.publicationId,
      }, client);
      return { proposal: failedRow.row as ActionProposalRow, publication: null, alreadyPublished: false, published: false };
    }

    // 2. Publicación idempotente (el UNIQUE es backstop; llegamos aquí solo si
    //    el state guard pasó, por lo que la inserción no debe chocar).
    const publication = await deps.repo.insertPublication({
      publicationId: ids.publicationId, proposalId: input.proposalId, tenantId: input.tenantId,
      publishKey, attempt, publisher: publisher.name, publishedBy: actorLabel, source,
      externalRef: result.external_ref, publishedVersion: result.version,
    }, client);
    if (!publication) {
      // Backstop alcanzable solo si la publicación ya existía (otra aprobación
      // ganó la carrera antes del guard). ROLLBACK de esta tx y señal de replay.
      throw new AlreadyPublishedError(input.proposalId);
    }
    const publishedRow = await deps.repo.updateProposalStatus(
      input.tenantId, input.proposalId, 'published',
      { publishedVersion: result.version }, 'approved_for_publish', client,
    );
    const outProposal = publishedRow.row as ActionProposalRow;
    await deps.sink.write({
      tenant_id: input.tenantId, actor_id: actorLabel, actor_role: input.actorRole ?? null,
      action: 'conversation.approved', resource: `action_proposal/${input.proposalId}`,
      request_id: input.requestId, decision: 'allow', result: 'success', evidence_ref: publication.publication_id,
    }, client);
    await deps.sink.write({
      tenant_id: input.tenantId, actor_id: actorLabel, actor_role: input.actorRole ?? null,
      action: 'conversation.published', resource: `action_proposal/${input.proposalId}`,
      request_id: input.requestId, decision: 'allow', result: `published_v${result.version ?? '?'}`,
      evidence_ref: publication.publication_id,
    }, client);
    log.info('conversation.published.ok', 'proposal published', {
      tenant_id: input.tenantId, proposal_id: input.proposalId, publisher: publisher.name, attempt,
    });
    return { proposal: outProposal, publication, alreadyPublished: false, published: true };
  });
}

/** Señal de replay: la publicación ya existía (OTRA aprobación ganó la carrera). */
export class AlreadyPublishedError extends Error {
  readonly proposalId: string;

  constructor(proposalId: string) {
    super(`proposal already published: ${proposalId}`);
    this.proposalId = proposalId;
  }
}

/** Expiración de preview (token vencido): preview → used, proposal → expired (si aún puede). */
export async function expirePreviewAndProposal(
  deps: StateMachineDeps,
  input: { tenantId: string; previewId: string; proposalId: string; requestId: string; actorId: string },
): Promise<{ proposal: ActionProposalRow; expired: boolean }> {
  const found = await deps.repo.findProposalScoped(input.tenantId, input.proposalId);
  const proposal = (found.found && found.in_tenant ? found.row : null) as ActionProposalRow | null;
  return runAtomic(deps.pool, async (client) => {
    await deps.repo.setPreviewStatus(input.tenantId, input.previewId, 'expired', client);
    const updated = proposal && ['confirmed', 'preview_ready'].includes(proposal.status)
      ? (await deps.repo.updateProposalStatus(input.tenantId, input.proposalId, 'expired', {}, proposal.status, client)).row as ActionProposalRow
      : proposal;
    await auditInTx(deps.sink, client, {
      tenant_id: input.tenantId, actor_id: input.actorId, actor_role: null,
      action: 'conversation.expired', resource: `preview_session/${input.previewId}`,
      request_id: input.requestId,
    });
    return { proposal: updated ?? (await deps.repo.findProposalScoped(input.tenantId, input.proposalId)).row as ActionProposalRow, expired: true };
  });
}

/**
 * Resuelve preview por token (ruta pública). Devuelve null SOLO si el token
 * no existe; si existe pero está 'used'/'expired' lo comunica para que la
 * ruta responda el mensaje correcto (410/ya-publicado) en vez de 404.
 */
export async function resolvePreviewByToken(
  repo: ConversationRepository,
  rawToken: string,
): Promise<{ previewId: string; tenantId: string; proposal: ActionProposalRow; used: boolean; expired: boolean } | null> {
  if (!rawToken) return null;
  const preview = await repo.findPreviewByTokenHashGlobal(hashPreviewToken(rawToken));
  if (!preview) return null;
  const proposal = await repo.findProposalById(preview.proposal_id);
  if (!proposal) return null;
  const expired = preview.status === 'expired' || new Date(preview.expires_at).getTime() <= Date.now();
  const used = preview.status === 'used';
  return { previewId: preview.preview_id, tenantId: preview.tenant_id, proposal, used, expired };
}
