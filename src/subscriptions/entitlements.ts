/**
 * EntitlementService (INC-006, CAP-012, REQ-019, DEC-024; catálogo versionado DEC-0075).
 *
 * Catálogo de planes en BD SIN precios reales. Un cliente tiene UNA suscripción, FIJADA a la revisión
 * publicada con la que se asignó (src/plans/assignment.ts). Este módulo expone la vista de solo lectura
 * del negocio (plan, revisión, límites y uso efectivos con la misma cuenta que aplica QuotaLedger) y la
 * facturación, que sigue PROHIBITED sin precio (RULE-006/DEC-024). El negocio nunca asigna planes.
 *
 * Fail-closed: sin suscripción no hay entitlements; un valor ausente en la revisión se muestra sin
 * límite (null) y el enforcement lo deniega.
 */

import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { AppError, DENY_CODES, type DenyCode } from '../shared/errors.ts';
import { effectiveValue, loadPinnedPolicy, type PolicySubscription } from '../plans/policy.ts';
import { PLAN_PARAMETERS, periodLabel, type PlanParameterDefinition } from '../plans/registry.ts';
import { QuotaLedger } from './quota.ts';
import { SimulatedPaymentProvider, type PaymentProvider } from './payment.ts';

export type { SubscriptionStatus } from '../plans/policy.ts';

export interface PlanRow {
  plan_id: string;
  name: string;
  description: string | null;
  price_cents: number | null;
  currency: string | null;
  is_pilot: boolean;
  active: boolean;
  created_at: string;
}

export type SubscriptionRow = PolicySubscription;

export interface EntitlementParameter {
  key: string;
  capability: string | null;
  label: string;
  unit: string;
  semantics: string;
  period: string;
  value: number | boolean | null;
  usage: number | null;
  enforced: boolean;
  /** Ciclo vigente [start, end) de un parámetro periódico (UTC); null en los demás. */
  window: { start: string; end: string } | null;
  /** Aviso para el negocio cuando el parámetro no se aplica por decisión (p. ej. recibir reseñas). */
  note: string | null;
}

export interface EntitlementView {
  tenant_id: string;
  subscription: SubscriptionRow;
  plan: PlanRow;
  revision: { revision_id: string; version: number; status: string; published_at: Date };
  /** Límite efectivo por capacidad (contrato del panel: capacidad → máximo). */
  limits: Record<string, number>;
  /** Uso que cuenta para el límite, por capacidad (misma cuenta que el enforcement). */
  usage: Record<string, number>;
  parameters: EntitlementParameter[];
}

export class SubscriptionRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async plan(planId: string): Promise<PlanRow | null> {
    const res = await this.pool.query<PlanRow>(
      'SELECT plan_id, name, description, price_cents, currency, is_pilot, active, created_at FROM plan WHERE plan_id = $1', [planId]);
    return res.rows[0] ?? null;
  }

  /** Planes asignables (habilitados con revisión publicada); nunca borradores ni deshabilitados. */
  async listAssignablePlans(): Promise<PlanRow[]> {
    const res = await this.pool.query<PlanRow>(
      `SELECT p.plan_id, p.name, p.description, p.price_cents, p.currency, p.is_pilot, p.active, p.created_at
         FROM plan p WHERE p.active AND EXISTS (SELECT 1 FROM plan_revision r WHERE r.plan_id = p.plan_id AND r.status = 'PUBLISHED')
        ORDER BY p.is_pilot DESC, p.name`);
    return res.rows;
  }
}

export interface EntitlementServiceDeps {
  pool: Pool;
  sink: AuditSink;
  paymentProvider?: PaymentProvider;
}

export class EntitlementService {
  private readonly deps: EntitlementServiceDeps;
  private readonly repo: SubscriptionRepository;
  private readonly quota: QuotaLedger;

  constructor(deps: EntitlementServiceDeps) {
    this.deps = deps;
    this.repo = new SubscriptionRepository(deps.pool);
    this.quota = new QuotaLedger({ pool: deps.pool, sink: deps.sink });
  }

  private get payment(): PaymentProvider {
    return this.deps.paymentProvider ?? new SimulatedPaymentProvider();
  }

  /** Entitlements del tenant: plan, revisión fijada, límites y uso efectivos (solo lectura). */
  async getEntitlements(tenantId: string): Promise<EntitlementView | null> {
    const policy = await loadPinnedPolicy(this.deps.pool, tenantId);
    if (!policy) return null;
    const plan = await this.repo.plan(policy.subscription.plan_id);
    if (!plan) return null;
    const status = new Map((await this.quota.capacityStatus(this.deps.pool, policy)).map((s) => [s.parameter_key, s]));
    const limits: Record<string, number> = {};
    const usage: Record<string, number> = {};
    const parameters: EntitlementParameter[] = [];
    for (const def of PLAN_PARAMETERS as readonly PlanParameterDefinition[]) {
      const value = effectiveValue(policy, def)?.value ?? null;
      const capacity = status.get(def.key);
      const used = capacity?.usage ?? null;
      if (def.capability && typeof value === 'number') limits[def.capability] = value;
      if (def.capability && used !== null) usage[def.capability] = used;
      parameters.push({
        key: def.key, capability: def.capability, label: def.label, unit: def.unit, semantics: def.semantics,
        period: periodLabel(def), value, usage: used, enforced: def.enforcement.state === 'enforced',
        window: capacity?.window ?? null, note: def.enforcement.businessNote ?? null,
      });
    }
    const { revision_id, version, status: revStatus, published_at } = policy.revision;
    return {
      tenant_id: tenantId, subscription: policy.subscription, plan,
      revision: { revision_id, version, status: revStatus, published_at }, limits, usage, parameters,
    };
  }

  /**
   * Facturación — PROHIBIDA en el piloto si el plan no tiene precio
   * (DEC-024/RULE-006). Con precio futuro usaría PaymentProvider (simulado).
   */
  async invoice(tenantId: string, actorId: string, requestId: string): Promise<{ ok: boolean; result: string; evidence_ref: string | null }> {
    const subscription = (await this.deps.pool.query<SubscriptionRow>(
      'SELECT subscription_id, tenant_id, plan_id, plan_revision_id, status, started_at, updated_at FROM subscription WHERE tenant_id = $1', [tenantId])).rows[0];
    if (!subscription || subscription.status !== 'active') {
      await this.deps.sink.write({
        tenant_id: tenantId, actor_id: actorId, actor_role: null,
        action: 'subscription.invoice', resource: 'invoice', request_id: requestId,
        decision: 'deny', result: 'no_active_subscription',
      }, this.deps.pool, false).catch(() => undefined);
      throw this.auditedError(403, DENY_CODES.SUBSCRIPTION_REQUIRED, 'Este cliente no tiene un plan activo para facturar.');
    }
    const plan = await this.repo.plan(subscription.plan_id);
    if (!plan || plan.price_cents == null) {
      // Plan sin precio (piloto): facturar es PROHIBITED (DENY + audit).
      await this.deps.sink.write({
        tenant_id: tenantId, actor_id: actorId, actor_role: null,
        action: 'subscription.invoice', resource: `subscription/${subscription.subscription_id}`, request_id: requestId,
        decision: 'deny', result: 'no_price_prohibited',
      }).catch(() => undefined);
      throw this.auditedError(403, DENY_CODES.PROHIBITED,
        'El plan de este cliente aún no tiene precio aprobado, por lo que no se puede facturar. En el piloto no hay cobros.');
    }
    // Rama futura (fuera del piloto): pago simulado sin efecto externo.
    const payment = await this.payment.charge({
      tenantId, subscriptionId: subscription.subscription_id,
      amountCents: plan.price_cents, currency: plan.currency ?? 'USD',
    });
    // NFR-0001: el registro del cobro es sensible; si no se puede auditar, la
    // operación falla (nunca un cobro sin rastro).
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actorId, actor_role: null,
      action: 'subscription.invoice', resource: `subscription/${subscription.subscription_id}`, request_id: requestId,
      decision: payment.ok ? 'allow' : 'deny', result: payment.ok ? 'simulated_charge' : 'charge_failed',
      evidence_ref: payment.external_ref,
    });
    return { ok: payment.ok, result: payment.ok ? 'simulated_charge' : 'charge_failed', evidence_ref: payment.external_ref };
  }

  private auditedError(status: number, code: DenyCode, message: string): AppError {
    const err = new AppError(status, code, message);
    err.audited = true;
    return err;
  }
}
