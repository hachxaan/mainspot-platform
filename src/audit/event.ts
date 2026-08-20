/**
 * Minimal audit event schema (C4, AC-003).
 * Fields derive from DESIGN-INC-001 §6 and AC-003: actor, client, request,
 * decision, action, result, timestamp + correlation (request_id).
 * INVARIANT: audit never exposes credentials or secrets.
 */

import { randomUUID } from 'node:crypto';

export type AuditDecision = 'allow' | 'deny';

export interface AuditEventInput {
  tenant_id: string;
  actor_id: string;
  actor_role?: string | null;
  action: string;
  resource?: string | null;
  request_id: string;
  decision: AuditDecision;
  result: string;
  evidence_ref?: string | null;
}

export interface AuditEventRow extends AuditEventInput {
  event_id: string;
  ts: string;
  created_by_system: string;
}

/** Actions that MUST be audit-reliable: if the event cannot be persisted the
 *  action is ABORTED (fail-closed), per the INC-001 contract
 *  ("audit writes must be reliable or fail closed for sensitive actions"). */
export const SENSITIVE_ACTIONS = new Set<string>([
  'user.manage',
  'client.config.manage',
  'operation.execute',
  'operation.approve',
  'operation.reject',
  'data.write',
]);

export const READ_ACTIONS = new Set<string>(['data.read', 'audit.read', 'audit.export']);

const SECRET_KEY_PATTERN = /\b(password(?:s)?|passwd|token(?:s)?|secret(?:s)?|credential(?:s)?|authorization|api[_-]?key|private[_-]?key)\b|[_-](?:token(?:s)?|secret(?:s)?|password(?:s)?|key|credential(?:s)?|authorization)\b/i;

/** Guard: refuses to persist audit data that would include secrets. */
export function assertNoSecrets(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`Refusing to audit field with sensitive name: ${key} (audit NEVER stores secrets)`);
    }
  }
}

export function newEventId(): string {
  return `evt_${randomUUID()}`;
}

export function normalizeEvent(input: AuditEventInput): AuditEventRow {
  assertNoSecrets(input as unknown as Record<string, unknown>);
  if (!input.tenant_id || !input.actor_id || !input.request_id || !input.action) {
    throw new Error('audit event missing required field (tenant_id, actor_id, request_id, action)');
  }
  if (input.decision !== 'allow' && input.decision !== 'deny') {
    throw new Error(`audit event decision must be allow|deny, got: ${String(input.decision)}`);
  }
  return {
    event_id: newEventId(),
    ts: new Date().toISOString(),
    tenant_id: input.tenant_id,
    actor_id: input.actor_id,
    actor_role: input.actor_role,
    action: input.action,
    resource: input.resource ?? null,
    request_id: input.request_id,
    decision: input.decision,
    result: input.result,
    evidence_ref: input.evidence_ref ?? null,
    created_by_system: 'mainspot-backoffice-api',
  };
}
