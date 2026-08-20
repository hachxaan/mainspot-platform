/**
 * Audit sink (C4) — reliable persistence for sensitive actions (fail-closed)
 * and best-effort for reads (contract: reliable or fail-closed for sensitive).
 * Writes go through the SAME database connection/transaction as the action so
 * a sensitive action and its event commit or roll back together.
 *
 * Failure events are written with decision='deny' and a GENERIC result
 * ('failed') — never with raw error messages (which can carry logins or other
 * personal data into the audit store).
 */

import type { Pool, PoolClient } from 'pg';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { config } from '../shared/config.ts';
import { normalizeEvent, SENSITIVE_ACTIONS, type AuditEventInput, type AuditEventRow } from './event.ts';

export class AuditSink {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Persist one event. Throws (fail-closed) when the event is sensitive and
   *  the write fails; otherwise logs the failure and continues. */
  async write(input: AuditEventInput, db: Pool | PoolClient = this.pool, sensitiveOverride?: boolean): Promise<AuditEventRow> {
    const sensitive = sensitiveOverride ?? SENSITIVE_ACTIONS.has(input.action);
    const row = normalizeEvent(input);
    try {
      await db.query(
        `INSERT INTO audit_event
          (event_id, ts, tenant_id, actor_id, actor_role, action, resource, request_id, decision, result, evidence_ref, created_by_system)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [row.event_id, row.ts, row.tenant_id, row.actor_id, row.actor_role, row.action,
          row.resource, row.request_id, row.decision, row.result, row.evidence_ref, row.created_by_system],
      );
      log.info('audit.written', 'audit event persisted', { action: row.action, decision: row.decision, result: row.result, actor_id: row.actor_id, tenant_id: row.tenant_id });
      return row;
    } catch (err) {
      const msg = `audit write failed (decision=${row.decision}, action=${row.action})`;
      if (sensitive || config.auditMode === 'fail_closed') {
        log.error('audit.write.failed_closed', msg, { error: (err as Error).message, action: row.action });
        throw new AppError(500, DENY_CODES.AUDIT_FAILED, 'No se pudo registrar la operación en el registro de auditoría. La operación no se completó.');
      }
      log.warn('audit.write.failed_open', msg, { error: (err as Error).message, action: row.action });
      throw err;
    }
  }
}

/**
 * Execute `fn` inside a transaction that also persists its audit event.
 * For sensitive actions the action and its audit event commit or roll back
 * together (fail-closed). For reads the event is written after the action.
 * Thrown errors are propagated; if the error is an already-audited deny
 * (AppError.audited) no extra event is written.
 */
export async function auditedOperation<T>(
  sink: AuditSink,
  pool: Pool,
  input: { request_id: string; tenant_id: string; actor_id: string; actor_role: string | null; action: string; resource?: string | null; evidence_ref?: string | null },
  fn: (db: PoolClient | Pool) => Promise<T>,
): Promise<T> {
  const sensitive = SENSITIVE_ACTIONS.has(input.action);

  if (!sensitive) {
    const result = await fn(pool);
    await sink.write({ ...input, decision: 'allow', result: 'success' });
    return result;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await sink.write({ ...input, decision: 'allow', result: 'success' }, client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof AppError && err.audited) {
      // Already audited as deny (e.g. nested permission failure); do not double-write.
      throw err;
    }
    // Failure event after rollback: decision=deny, generic result, WITHOUT the
    // raw error message (never logins/emails/internal details in the audit
    // store). If THIS write fails, surface it loudly (fail-closed intent) and
    // rethrow the original error — no silent swallow.
    try {
      await sink.write({ ...input, decision: 'deny', result: 'failed' });
    } catch (auditErr) {
      log.error('audit.failure_event_write_failed', 'could not write failure audit event', {
        error: (auditErr as Error).message,
        action: input.action,
      });
    }
    throw err;
  } finally {
    client.release();
  }
}
