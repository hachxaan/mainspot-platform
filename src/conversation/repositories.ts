/**
 * Repositories del flujo conversacional (INC-002, CAP-008).
 *
 * INVARIANTS INC-001 reutilizadas:
 *  - FAIL-CLOSED: sin tenant_id no se ejecuta ninguna consulta.
 *  - ANTI-ORACLE (IR-01): recurso inexistente y recurso de OTRO tenant se
 *    devuelven como found=false/in_tenant=false (el caller responde 404
 *    idéntico; el marcador es interno, jamás diferencia la respuesta HTTP).
 *  - ON DELETE RESTRICT en FKs: jamás se borra datos de un tenant en cascada.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ActionClass, CapabilityTarget, ProposalStatus, RequestStatus } from './intents.ts';

export interface TenantBoundaryResult<T> {
  found: boolean;
  in_tenant: boolean;
  row: T | null;
}

function assertTenant(tenantId: string): string {
  if (!tenantId) {
    throw new Error('FAIL-CLOSED: conversation repository requires a tenant context');
  }
  return tenantId;
}

export interface ConversationRequestRow {
  request_id: string;
  tenant_id: string;
  actor_id: string;
  channel: string;
  raw_message: string;
  intent: string;
  capability_target: string;
  action_class: ActionClass;
  status: RequestStatus;
  response_message: string | null;
  proposal_id: string | null;
  created_at: string;
}

export interface ActionProposalRow {
  proposal_id: string;
  tenant_id: string;
  request_id: string;
  capability_target: string;
  proposal_type: string;
  action_class: ActionClass;
  summary: string;
  detail: Record<string, unknown>;
  status: ProposalStatus;
  created_by: string;
  created_at: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  preview_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  published_version: number | null;
  updated_at: string;
}

export interface PreviewSessionRow {
  preview_id: string;
  proposal_id: string;
  tenant_id: string;
  token_hash: string;
  scope: string;
  expires_at: string;
  created_by: string;
  status: 'active' | 'expired' | 'used';
  created_at: string;
}

export interface ApprovalRow {
  approval_id: string;
  proposal_id: string;
  tenant_id: string;
  approved_by: string;
  decision: 'approve' | 'reject';
  request_id: string;
  created_at: string;
}

export interface PublicationRow {
  publication_id: string;
  proposal_id: string;
  tenant_id: string;
  publish_key: string;
  attempt: number;
  publisher: string;
  status: 'published' | 'failed';
  published_version: number | null;
  external_ref: string | null;
  published_by: string;
  source: 'backoffice' | 'preview';
  published_at: string;
}

export class ConversationRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // --- conversation_request -------------------------------------------------

  async createRequest(input: {
    requestId: string;
    tenantId: string;
    actorId: string;
    channel: string;
    rawMessage: string;
    intent: string;
    capabilityTarget: string;
    actionClass: ActionClass;
    status: RequestStatus;
    responseMessage: string | null;
    proposalId?: string | null;
  }, db: Pool | PoolClient = this.pool): Promise<ConversationRequestRow> {
    const tenantId = assertTenant(input.tenantId);
    // RETURNING * (no re-SELECT): la fila puede no ser visible desde el pool
    // dentro de la misma transacción (misma conexión = client).
    const res = await db.query<ConversationRequestRow>(
      `INSERT INTO conversation_request
        (request_id, tenant_id, actor_id, channel, raw_message, intent, capability_target, action_class, status, response_message, proposal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [input.requestId, tenantId, input.actorId, input.channel, input.rawMessage, input.intent,
        input.capabilityTarget, input.actionClass, input.status, input.responseMessage, input.proposalId ?? null],
    );
    return res.rows[0] as ConversationRequestRow;
  }

  async findRequestScoped(tenantId: string, requestId: string): Promise<TenantBoundaryResult<ConversationRequestRow>> {
    const t = assertTenant(tenantId);
    const res = await this.pool.query<ConversationRequestRow>('SELECT * FROM conversation_request WHERE request_id = $1', [requestId]);
    const row = res.rows[0] ?? null;
    if (!row) return { found: false, in_tenant: false, row: null };
    return { found: true, in_tenant: row.tenant_id === t, row };
  }

  /** Lista solicitudes del tenant (opcional filtro por estado). */
  async listRequests(tenantId: string, opts: { status?: RequestStatus; limit?: number } = {}): Promise<ConversationRequestRow[]> {
    const t = assertTenant(tenantId);
    const limit = Math.min(opts.limit ?? 100, 500);
    const res = await this.pool.query<ConversationRequestRow>(
      `SELECT * FROM conversation_request
       WHERE tenant_id = $1 ${opts.status ? 'AND status = $2' : ''}
       ORDER BY created_at DESC, request_id LIMIT ${opts.status ? '$3' : '$2'}`,
      opts.status ? [t, opts.status, limit] : [t, limit],
    );
    return res.rows;
  }

  // --- action_proposal ------------------------------------------------------

  async createProposal(input: {
    proposalId: string;
    tenantId: string;
    requestId: string;
    capabilityTarget: string;
    proposalType: string;
    actionClass: Extract<ActionClass, 'draft' | 'preview_required' | 'human_approval_required'>;
    summary: string;
    detail: Record<string, unknown>;
    status: ProposalStatus;
    createdBy: string;
  }, db: Pool | PoolClient = this.pool): Promise<ActionProposalRow> {
    const tenantId = assertTenant(input.tenantId);
    const res = await db.query<ActionProposalRow>(
      `INSERT INTO action_proposal
        (proposal_id, tenant_id, request_id, capability_target, proposal_type, action_class, summary, detail, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [input.proposalId, tenantId, input.requestId, input.capabilityTarget, input.proposalType,
        input.actionClass, input.summary, JSON.stringify(input.detail), input.status, input.createdBy],
    );
    return res.rows[0] as ActionProposalRow;
  }

  async findProposalScoped(tenantId: string, proposalId: string): Promise<TenantBoundaryResult<ActionProposalRow>> {
    const t = assertTenant(tenantId);
    const res = await this.pool.query<ActionProposalRow>('SELECT * FROM action_proposal WHERE proposal_id = $1', [proposalId]);
    const row = res.rows[0] ?? null;
    if (!row) return { found: false, in_tenant: false, row: null };
    return { found: true, in_tenant: row.tenant_id === t, row };
  }

  async findProposalByRequest(tenantId: string, requestId: string): Promise<ActionProposalRow | null> {
    const t = assertTenant(tenantId);
    const res = await this.pool.query<ActionProposalRow>(
      'SELECT * FROM action_proposal WHERE tenant_id = $1 AND request_id = $2 ORDER BY created_at LIMIT 1',
      [t, requestId],
    );
    return res.rows[0] ?? null;
  }

  /** Transición de estado (FLOW-002). Solo actualiza si el estado actual es `fromStatus` (guard antiraza). */
  async updateProposalStatus(
    tenantId: string,
    proposalId: string,
    status: ProposalStatus,
    meta: { confirmedBy?: string; approvedBy?: string; rejectedBy?: string; previewId?: string; publishedVersion?: number } = {},
    fromStatus?: ProposalStatus,
    db: Pool | PoolClient = this.pool,
  ): Promise<TenantBoundaryResult<ActionProposalRow>> {
    const t = assertTenant(tenantId);
    const sets: string[] = ['status = $3', 'updated_at = now()'];
    const values: unknown[] = [t, proposalId, status];
    if (meta.confirmedBy) { sets.push('confirmed_by = $' + (values.length + 1)); values.push(meta.confirmedBy); sets.push('confirmed_at = now()'); }
    if (meta.approvedBy) { sets.push('approved_by = $' + (values.length + 1)); values.push(meta.approvedBy); sets.push('approved_at = now()'); }
    if (meta.rejectedBy) { sets.push('rejected_by = $' + (values.length + 1)); values.push(meta.rejectedBy); sets.push('rejected_at = now()'); }
    if (meta.previewId) { sets.push('preview_id = $' + (values.length + 1)); values.push(meta.previewId); }
    if (meta.publishedVersion != null) { sets.push('published_version = $' + (values.length + 1)); values.push(meta.publishedVersion); }
    const guard = fromStatus ? 'AND status = $' + (values.length + 1) + ' ' : '';
    if (fromStatus) values.push(fromStatus);
    const sql = `UPDATE action_proposal SET ${sets.join(', ')} WHERE tenant_id = $1 AND proposal_id = $2 ${guard}RETURNING *`;
    const res = await db.query<ActionProposalRow>(sql, values);
    const row = res.rows[0] ?? null;
    if (!row) return { found: false, in_tenant: false, row: null };
    return { found: true, in_tenant: true, row };
  }

  async listProposals(tenantId: string, opts: { status?: ProposalStatus; limit?: number } = {}): Promise<ActionProposalRow[]> {
    const t = assertTenant(tenantId);
    const limit = Math.min(opts.limit ?? 100, 500);
    const res = await this.pool.query<ActionProposalRow>(
      `SELECT * FROM action_proposal
       WHERE tenant_id = $1 ${opts.status ? 'AND status = $2' : ''}
       ORDER BY created_at DESC, proposal_id LIMIT ${opts.status ? '$3' : '$2'}`,
      opts.status ? [t, opts.status, limit] : [t, limit],
    );
    return res.rows;
  }

  // --- preview_session ------------------------------------------------------

  async createPreview(input: {
    previewId: string;
    proposalId: string;
    tenantId: string;
    tokenHash: string;
    expiresAt: string;
    createdBy: string;
  }, db: Pool | PoolClient = this.pool): Promise<PreviewSessionRow> {
    const tenantId = assertTenant(input.tenantId);
    const res = await db.query<PreviewSessionRow>(
      `INSERT INTO preview_session (preview_id, proposal_id, tenant_id, token_hash, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [input.previewId, input.proposalId, tenantId, input.tokenHash, input.expiresAt, input.createdBy],
    );
    return res.rows[0] as PreviewSessionRow;
  }

  async findPreviewByTokenHash(tenantId: string, tokenHash: string): Promise<PreviewSessionRow | null> {
    const t = assertTenant(tenantId);
    const res = await this.pool.query<PreviewSessionRow>(
      'SELECT * FROM preview_session WHERE tenant_id = $1 AND token_hash = $2 ORDER BY created_at DESC LIMIT 1',
      [t, tokenHash],
    );
    return res.rows[0] ?? null;
  }

  /** Marca el preview como usados/expirado. Devuelve la fila actualizada. */
  async setPreviewStatus(
    tenantId: string,
    previewId: string,
    status: 'used' | 'expired',
    db: Pool | PoolClient = this.pool,
  ): Promise<void> {
    const t = assertTenant(tenantId);
    await db.query('UPDATE preview_session SET status = $1 WHERE preview_id = $2 AND tenant_id = $3', [status, previewId, t]);
  }

  /**
   * Lookup por hash del token preview (ruta PÚBLICA /preview/:token, CAP-008).
   * Excepción deliberada al scope por tenant: el token de alta entropía ES la
   * capacidad para ver el preview (no enumerable); el resultado no expone
   * secretos. Single-use + expiración limitan el riesgo (TENTATIVA documentada).
   */
  async findPreviewByTokenHashGlobal(tokenHash: string): Promise<PreviewSessionRow | null> {
    const res = await this.pool.query<PreviewSessionRow>(
      'SELECT * FROM preview_session WHERE token_hash = $1 ORDER BY created_at DESC LIMIT 1',
      [tokenHash],
    );
    return res.rows[0] ?? null;
  }

  /** Carga un proposal por id (para resolver el preview público). */
  async findProposalById(proposalId: string): Promise<ActionProposalRow | null> {
    const res = await this.pool.query<ActionProposalRow>('SELECT * FROM action_proposal WHERE proposal_id = $1', [proposalId]);
    return res.rows[0] ?? null;
  }

  // --- approval --------------------------------------------------------------

  async insertApproval(input: {
    approvalId: string;
    proposalId: string;
    tenantId: string;
    approvedBy: string;
    decision: 'approve' | 'reject';
    requestId: string;
  }, db: Pool | PoolClient = this.pool): Promise<void> {
    const tenantId = assertTenant(input.tenantId);
    await db.query(
      `INSERT INTO approval (approval_id, proposal_id, tenant_id, approved_by, decision, request_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [input.approvalId, input.proposalId, tenantId, input.approvedBy, input.decision, input.requestId],
    );
  }

  async listApprovals(tenantId: string, proposalId?: string): Promise<ApprovalRow[]> {
    const t = assertTenant(tenantId);
    const res = await this.pool.query<ApprovalRow>(
      `SELECT * FROM approval WHERE tenant_id = $1 ${proposalId ? 'AND proposal_id = $2' : ''} ORDER BY created_at, approval_id`,
      proposalId ? [t, proposalId] : [t],
    );
    return res.rows;
  }

  // --- publication -----------------------------------------------------------

  /**
   * Inserta una publicación con idempotencia: publish_key UNIQUE + UNIQUE
   * (proposal_id, attempt). En conflicto devuelve null SIN error (backstop
   * AC-007: repetir una aprobación NO duplica publicaciones).
   */
  async insertPublication(
    input: {
      publicationId: string;
      proposalId: string;
      tenantId: string;
      publishKey: string;
      attempt: number;
      publisher: string;
      publishedBy: string;
      source: 'backoffice' | 'preview';
      externalRef?: string | null;
      publishedVersion?: number | null;
    },
    db: Pool | PoolClient = this.pool,
  ): Promise<PublicationRow | null> {
    const tenantId = assertTenant(input.tenantId);
    const res = await db.query<PublicationRow>(
      `INSERT INTO publication
        (publication_id, proposal_id, tenant_id, publish_key, attempt, publisher, status, published_version, external_ref, published_by, source)
       VALUES ($1,$2,$3,$4,$5,$6,'published',$7,$8,$9,$10)
       ON CONFLICT (publish_key) DO NOTHING
       RETURNING *`,
      [input.publicationId, input.proposalId, tenantId, input.publishKey, input.attempt,
        input.publisher, input.publishedVersion ?? null, input.externalRef ?? null, input.publishedBy, input.source],
    );
    return res.rows[0] ?? null;
  }

  /** Marca fallida una publicación (retry permitido desde 'failed'). */
  async markPublicationFailed(
    tenantId: string,
    proposalId: string,
    reason: string,
    db: Pool | PoolClient = this.pool,
  ): Promise<void> {
    const t = assertTenant(tenantId);
    await db.query(
      `UPDATE publication SET status = 'failed', external_ref = $1
       WHERE proposal_id = $2 AND tenant_id = $3`,
      [reason, proposalId, t],
    );
  }

  async publicationByProposal(tenantId: string, proposalId: string): Promise<PublicationRow | null> {
    const t = assertTenant(tenantId);
    const res = await this.pool.query<PublicationRow>(
      'SELECT * FROM publication WHERE proposal_id = $1 AND tenant_id = $2 ORDER BY attempt DESC LIMIT 1',
      [proposalId, t],
    );
    return res.rows[0] ?? null;
  }

  async countPublicationsByProposal(tenantId: string, proposalId: string): Promise<number> {
    const t = assertTenant(tenantId);
    const res = await this.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM publication WHERE proposal_id = $1 AND tenant_id = $2',
      [proposalId, t],
    );
    return Number(res.rows[0]?.n ?? 0);
  }
}

export function newConversationIds(): {
  requestId: string;
  proposalId: string;
  previewId: string;
  approvalId: string;
  publicationId: string;
} {
  return {
    requestId: `req_${randomUUID()}`,
    proposalId: `prop_${randomUUID()}`,
    previewId: `preview_${randomUUID()}`,
    approvalId: `apr_${randomUUID()}`,
    publicationId: `pub_${randomUUID()}`,
  };
}
