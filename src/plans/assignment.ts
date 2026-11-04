/**
 * Asignación de planes a negocios (FR-0018, DEC-0075/SRC-0013): exclusiva de MainSpot Administration
 * (`subscriptions.assign`, platform_admin, step-up + motivo). El negocio nunca se asigna planes.
 *
 * - Asignar fija la suscripción a la revisión PUBLICADA vigente del plan (nunca un borrador ni un plan
 *   deshabilitado; lo garantiza también el trigger de la migración 0034).
 * - Publicar una revisión nueva NO cambia a los clientes vigentes: migrarlos es esta acción explícita,
 *   con vista previa de afectados (uso por encima del nuevo límite) y recuento esperado. «Asignar» el mismo
 *   plan a quien sigue en una revisión anterior se rechaza (409) y remite a esa migración; reactivar una
 *   suscripción suspendida o cancelada conserva la revisión fijada.
 * - Downgrade sin borrados: el uso existente se conserva; solo se bloquean nuevas creaciones.
 * - Cada cambio queda en `subscription_history` (trigger, con actor y motivo de la transacción), en la
 *   auditoría del negocio (visible para él) y en la de plataforma, todo en la misma transacción.
 * - Retención (DEC-0027): la auditoría del negocio lleva un request_id propio por evento y nunca el motivo
 *   (lo escribe la plataforma y puede nombrar a otros negocios); la de plataforma va por negocio con
 *   `tenant_id`, que su anonimización re-etiqueta. El resumen de un lote no lleva motivo ni ids de negocios.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { writePlatformAudit } from '../platform/auth.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { QuotaLedger } from '../subscriptions/quota.ts';
import { loadPinnedPolicy, revisionValues, type PolicySubscription } from './policy.ts';

export interface PlatformActor {
  platformUserId: string;
  login: string;
  roles: string[];
  requestId: string | null;
}

export interface MigrationPreviewRow {
  tenant_id: string;
  business_name: string;
  subscription_status: string;
  from_revision_id: string;
  from_version: number;
  /** Capacidades cuyo uso actual ya supera el límite de la revisión destino (se conservan, sin borrar). */
  over_limit: Array<{ capability: string; usage: number; new_limit: number }>;
}

async function setHistoryContext(client: PoolClient, actor: PlatformActor, reason: string, change: string): Promise<void> {
  await client.query(
    `SELECT set_config('mainspot.actor', $1, true), set_config('mainspot.reason', $2, true),
            set_config('mainspot.request_id', $3, true), set_config('mainspot.subscription_change', $4, true)`,
    [`platform:${actor.platformUserId}`, reason, actor.requestId ?? '', change]);
}

export class SubscriptionAssignment {
  private readonly pool: Pool;
  private readonly sink: AuditSink;
  private readonly quota: QuotaLedger;

  constructor(deps: { pool: Pool; sink: AuditSink }) {
    this.pool = deps.pool;
    this.sink = deps.sink;
    this.quota = new QuotaLedger({ pool: deps.pool, sink: deps.sink });
  }

  /** Asigna `planId` al negocio fijando su revisión publicada vigente. */
  async assign(input: { tenantId: string; planId: string; reason: string; actor: PlatformActor }): Promise<{ subscription: PolicySubscription; changed: boolean }> {
    return runAtomic(this.pool, async (client) => {
      // FOR SHARE: una baja confirmada a la vez espera a que la asignación termine (o la asignación ve la baja).
      const tenant = await client.query<{ status: string }>('SELECT status FROM client WHERE client_id = $1 FOR SHARE', [input.tenantId]);
      const tenantStatus = tenant.rows[0]?.status;
      if (!tenantStatus) throw new AppError(404, DENY_CODES.NOT_FOUND, 'No existe ese negocio.');
      if (tenantStatus !== 'active' && tenantStatus !== 'suspended') {
        throw new AppError(409, 'validation_error', 'Este negocio está en baja; no se le puede asignar un plan.');
      }
      // FOR SHARE en su propia sentencia: una publicación concurrente del mismo plan espera a que la asignación
      // termine. La revisión publicada se lee DESPUÉS, con instantánea nueva (READ COMMITTED): si la asignación
      // esperó a una publicación, fija la que quedó publicada y no la reemplazada (que el trigger rechazaría).
      const plan = (await client.query<{ active: boolean }>('SELECT active FROM plan WHERE plan_id = $1 FOR SHARE', [input.planId])).rows[0];
      const row = plan?.active
        ? (await client.query<{ revision_id: string }>(`SELECT revision_id FROM plan_revision WHERE plan_id = $1 AND status = 'PUBLISHED'`, [input.planId])).rows[0]
        : undefined;
      if (!row) {
        throw new AppError(409, 'validation_error', 'Ese plan no está habilitado o no tiene una revisión publicada; no se puede asignar.');
      }
      const current = (await client.query<PolicySubscription>(
        'SELECT * FROM subscription WHERE tenant_id = $1 FOR UPDATE', [input.tenantId])).rows[0];
      const platformAudit = (result: string) => writePlatformAudit(client, {
        actorId: input.actor.platformUserId, actorRoles: input.actor.roles, action: 'platform.tenant.plan',
        resource: `client/${input.tenantId}`, tenantId: input.tenantId, decision: 'allow', result,
        reason: input.reason, requestId: input.actor.requestId,
      });
      if (current?.plan_id === input.planId && current.status === 'active') {
        if (current.plan_revision_id === row.revision_id) {
          await platformAudit('noop');
          return { subscription: current, changed: false };
        }
        throw new AppError(409, 'validation_error',
          'Este negocio ya tiene este plan, fijado a una revisión anterior. Para pasarlo a la revisión publicada usa la migración con vista previa (Engineering Console › Planes).');
      }
      // Mismo plan sin estar activa: reactivar conserva la revisión fijada (cambiarla es la migración). Va por UPDATE
      // de solo estado: en un upsert, el trigger BEFORE INSERT exigiría la publicada a la fila propuesta.
      const kept = current?.plan_id === input.planId ? current.plan_revision_id : null;
      const change = !current ? 'assign' : kept ? 'status_change' : 'plan_change';
      const revisionId = kept ?? row.revision_id;
      await setHistoryContext(client, input.actor, input.reason, change);
      const res = kept
        ? await client.query<PolicySubscription>(`UPDATE subscription SET status = 'active', updated_at = now() WHERE tenant_id = $1 RETURNING *`, [input.tenantId])
        : await client.query<PolicySubscription>(
          `INSERT INTO subscription (subscription_id, tenant_id, plan_id, plan_revision_id, status)
           VALUES ($1, $2, $3, $4, 'active')
           ON CONFLICT (tenant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, plan_revision_id = EXCLUDED.plan_revision_id,
                                                 status = 'active', updated_at = now()
           RETURNING *`, [`sub_${randomUUID()}`, input.tenantId, input.planId, revisionId]);
      const subscription = res.rows[0] as PolicySubscription;
      await this.sink.write({
        tenant_id: input.tenantId, actor_id: `platform:${input.actor.login}`, actor_role: 'platform_admin',
        action: 'subscription.plan_assigned', resource: `subscription/${subscription.subscription_id}`,
        request_id: `plat_${randomUUID()}`, decision: 'allow', result: `${input.planId}:${revisionId}`,
      }, client);
      await platformAudit(`${current?.plan_id ?? '-'}@${current?.plan_revision_id ?? '-'} -> ${input.planId}@${revisionId}`);
      return { subscription, changed: true };
    });
  }

  /** Suscripciones del plan en revisiones anteriores a `toRevisionId`, con su uso frente al nuevo límite. */
  async previewMigration(planId: string, toRevisionId: string, db: Pool | PoolClient = this.pool): Promise<MigrationPreviewRow[]> {
    const target = await db.query<{ status: string }>(
      'SELECT status FROM plan_revision WHERE revision_id = $1 AND plan_id = $2', [toRevisionId, planId]);
    if (target.rows[0]?.status !== 'PUBLISHED') {
      throw new AppError(409, 'validation_error', 'Solo se puede migrar a la revisión publicada vigente del plan.');
    }
    const newValues = await revisionValues(db, toRevisionId);
    const subs = await db.query<{ tenant_id: string; business_name: string; status: string; plan_revision_id: string; version: number }>(
      `SELECT s.tenant_id, c.business_name, s.status, s.plan_revision_id, r.version
         FROM subscription s JOIN client c ON c.client_id = s.tenant_id
         JOIN plan_revision r ON r.revision_id = s.plan_revision_id
        WHERE s.plan_id = $1 AND s.plan_revision_id <> $2 ORDER BY c.business_name, s.tenant_id`, [planId, toRevisionId]);
    const out: MigrationPreviewRow[] = [];
    for (const s of subs.rows) {
      const policy = await loadPinnedPolicy(db, s.tenant_id);
      const over: MigrationPreviewRow['over_limit'] = [];
      if (policy) {
        for (const status of await this.quota.capacityStatus(db, policy)) {
          const next = newValues.get(status.parameter_key);
          if (typeof next === 'number' && status.window === null && status.usage > next) {
            over.push({ capability: status.capability, usage: status.usage, new_limit: next });
          }
        }
      }
      out.push({ tenant_id: s.tenant_id, business_name: s.business_name, subscription_status: s.status, from_revision_id: s.plan_revision_id, from_version: s.version, over_limit: over });
    }
    return out;
  }

  /**
   * Migra suscripciones del plan a su revisión publicada vigente. `tenantIds` acota el lote (o todas);
   * `expectedCount` debe coincidir con la vista previa que vio el operador (si no, 409 y nada cambia).
   */
  async migrateToPublished(input: { planId: string; toRevisionId: string; tenantIds: string[] | 'all'; expectedCount: number; reason: string; actor: PlatformActor }): Promise<{ migrated: string[] }> {
    return runAtomic(this.pool, async (client) => {
      await client.query('SELECT 1 FROM plan WHERE plan_id = $1 FOR SHARE', [input.planId]);
      const preview = await this.previewMigration(input.planId, input.toRevisionId, client);
      const chosen = input.tenantIds === 'all' ? preview : preview.filter((p) => (input.tenantIds as string[]).includes(p.tenant_id));
      if (input.tenantIds !== 'all' && chosen.length !== input.tenantIds.length) {
        throw new AppError(409, DENY_CODES.STALE_VERSION, 'Algún negocio elegido ya no está en una revisión anterior de este plan. Actualiza la vista previa.');
      }
      if (chosen.length !== input.expectedCount || chosen.length === 0) {
        throw new AppError(409, DENY_CODES.STALE_VERSION, 'La lista de negocios afectados cambió desde la vista previa (o está vacía). Actualízala y vuelve a confirmar.');
      }
      await setHistoryContext(client, input.actor, input.reason, 'revision_migration');
      for (const row of chosen) {
        const upd = await client.query<{ subscription_id: string }>(
          `UPDATE subscription SET plan_revision_id = $3, updated_at = now()
            WHERE tenant_id = $1 AND plan_id = $2 AND plan_revision_id = $4 RETURNING subscription_id`,
          [row.tenant_id, input.planId, input.toRevisionId, row.from_revision_id]);
        if (!upd.rowCount) throw new AppError(409, DENY_CODES.STALE_VERSION, 'Una suscripción cambió durante la migración. Actualiza la vista previa.');
        const result = `${input.planId}:v${row.from_version}->${input.toRevisionId}${row.over_limit.length ? ':over_limit' : ''}`;
        await this.sink.write({
          tenant_id: row.tenant_id, actor_id: `platform:${input.actor.login}`, actor_role: 'platform_admin',
          action: 'subscription.revision_migrated', resource: `subscription/${upd.rows[0]?.subscription_id}`,
          request_id: `plat_${randomUUID()}`, decision: 'allow', result,
        }, client);
        await writePlatformAudit(client, {
          actorId: input.actor.platformUserId, actorRoles: input.actor.roles, action: 'plans.subscriptions.migrate',
          resource: `client/${row.tenant_id}`, tenantId: row.tenant_id, decision: 'allow', result,
          reason: input.reason, requestId: input.actor.requestId,
        });
      }
      const overLimit = chosen.filter((c) => c.over_limit.length).length;
      await writePlatformAudit(client, {
        actorId: input.actor.platformUserId, actorRoles: input.actor.roles, action: 'plans.subscriptions.migrate',
        resource: `plan/${input.planId}`, decision: 'allow', result: `to:${input.toRevisionId} count:${chosen.length} over_limit:${overLimit}`,
        requestId: input.actor.requestId,
      });
      await client.query(
        `INSERT INTO plan_catalog_event (event_id, actor_id, actor_roles, action, plan_id, revision_id, reason, diff, request_id)
         VALUES ($1, $2, $3, 'plans.subscriptions.migrate', $4, $5, NULL, $6, $7)`,
        [`pce_${randomUUID()}`, `platform:${input.actor.platformUserId}`, input.actor.roles, input.planId, input.toRevisionId,
          JSON.stringify({ migrated: chosen.length, over_limit: overLimit }), input.actor.requestId]);
      return { migrated: chosen.map((c) => c.tenant_id) };
    });
  }
}
