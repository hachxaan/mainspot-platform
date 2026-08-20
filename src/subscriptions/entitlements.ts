/**
 * EntitlementService (INC-006, CAP-012, REQ-019, DEC-024).
 *
 * Catálogo de planes CONFIGURABLE en BD (seed idempotente), SIN precios reales.
 * Un cliente tiene UNA suscripción activa. checkLimit() es el enforcement de
 * límites en el punto de creación (website/social/reputation): exceso ⇒ deny
 * 403 'limit_exceeded' (auditado por la capa de rutas).
 *
 * Fail-closed: sin suscripción activa no hay entitlements (deny
 * 'subscription_required'); un plan sin precio NO se puede facturar
 * ('prohibited', RULE-006/DEC-024).
 */

import type { Pool, PoolClient } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { AppError, DENY_CODES, type DenyCode } from '../shared/errors.ts';
import { SimulatedPaymentProvider, type PaymentProvider } from './payment.ts';

export type SubscriptionStatus = 'active' | 'suspended' | 'cancelled';

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

export interface PlanLimitRow {
  limit_id: string;
  plan_id: string;
  capability: string;
  max_value: number;
}

export interface SubscriptionRow {
  subscription_id: string;
  tenant_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  started_at: string;
  updated_at: string;
}

export interface EntitlementView {
  tenant_id: string;
  subscription: SubscriptionRow;
  plan: PlanRow;
  limits: Record<string, number>;
}

/** Capacidades conocidas del catálogo (espejo de dec-024/seed). */
export const KNOWN_CAPABILITIES = ['website', 'social_posts', 'social_ads', 'reviews_managed', 'agents', 'conversations'] as const;
export type CapabilityName = (typeof KNOWN_CAPABILITIES)[number];

/** Función pura del límite (unit-testable): usage >= max ⇒ denegado. */
export function usageWithinLimit(limit: number | null, usage: number): boolean {
  if (limit === null) return false; // sin límite configurado ⇒ fail-closed deny
  return usage < limit;
}

export class SubscriptionRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async findByTenant(tenantId: string): Promise<SubscriptionRow | null> {
    const res = await this.pool.query<SubscriptionRow>(
      `SELECT * FROM subscription WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [tenantId],
    );
    return res.rows[0] ?? null;
  }

  async assign(tenantId: string, planId: string, db: Pool | PoolClient = this.pool): Promise<SubscriptionRow> {
    const res = await db.query<SubscriptionRow>(
      `INSERT INTO subscription (subscription_id, tenant_id, plan_id, status)
       VALUES ($1,$2,$3,'active')
       ON CONFLICT (tenant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active', updated_at = now()
       RETURNING *`,
      [`sub_${crypto.randomUUID()}`, tenantId, planId],
    );
    return res.rows[0] as SubscriptionRow;
  }

  async plan(planId: string): Promise<PlanRow | null> {
    const res = await this.pool.query<PlanRow>('SELECT * FROM plan WHERE plan_id = $1', [planId]);
    return res.rows[0] ?? null;
  }

  async limits(planId: string): Promise<PlanLimitRow[]> {
    const res = await this.pool.query<PlanLimitRow>('SELECT * FROM plan_limit WHERE plan_id = $1', [planId]);
    return res.rows;
  }

  async limitFor(planId: string, capability: string): Promise<PlanLimitRow | null> {
    const res = await this.pool.query<PlanLimitRow>(
      'SELECT * FROM plan_limit WHERE plan_id = $1 AND capability = $2',
      [planId, capability],
    );
    return res.rows[0] ?? null;
  }

  async listPlans(): Promise<PlanRow[]> {
    const res = await this.pool.query<PlanRow>('SELECT * FROM plan ORDER BY is_pilot DESC, name');
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

  constructor(deps: EntitlementServiceDeps) {
    this.deps = deps;
  }

  private get repo(): SubscriptionRepository {
    return new SubscriptionRepository(this.deps.pool);
  }

  private get payment(): PaymentProvider {
    return this.deps.paymentProvider ?? new SimulatedPaymentProvider();
  }

  /** Asigna el plan (una suscripción activa por tenant; upsert idempotente). */
  async assignPlan(tenantId: string, planId: string, actorId: string, requestId: string): Promise<SubscriptionRow> {
    const plan = await this.repo.plan(planId);
    if (!plan) {
      throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró el plan solicitado.');
    }
    if (!plan.active) {
      throw new AppError(409, 'validation_error', 'El plan no está activo para asignarse.');
    }
    const subscription = await this.repo.assign(tenantId, planId);
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actorId, actor_role: null,
      action: 'subscription.assigned', resource: `subscription/${subscription.subscription_id}`,
      request_id: requestId, decision: 'allow', result: `plan:${planId}`,
    });
    return subscription;
  }

  /** Entitlements del tenant (plan + límites por capacidad). */
  async getEntitlements(tenantId: string): Promise<EntitlementView | null> {
    const subscription = await this.repo.findByTenant(tenantId);
    if (!subscription) return null;
    const plan = await this.repo.plan(subscription.plan_id);
    if (!plan) return null;
    const limitRows = await this.repo.limits(subscription.plan_id);
    const limits: Record<string, number> = {};
    for (const l of limitRows) limits[l.capability] = l.max_value;
    return { tenant_id: tenantId, subscription, plan, limits };
  }

  /**
   * Enforcement básico de límites en el punto de creación (DEC-024).
   * Exceso ⇒ AppError 403 'limit_exceeded' (la capa de rutas lo audita y
   * responde). Sin suscripción activa ⇒ 'subscription_required' (fail-closed).
   */
  async checkLimit(tenantId: string, capability: string): Promise<void> {
    if (!(KNOWN_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new AppError(400, 'validation_error', 'La capacidad consultada no está definida en el catálogo de límites.');
    }
    const subscription = await this.repo.findByTenant(tenantId);
    if (!subscription || subscription.status !== 'active') {
      throw new AppError(403, DENY_CODES.SUBSCRIPTION_REQUIRED,
        'Este cliente no tiene un plan activo. Consulta con el administrador del plan de MainSpot.');
    }
    const limit = await this.repo.limitFor(subscription.plan_id, capability);
    const max = limit?.max_value ?? null;
    const usage = await this.countUsage(tenantId, capability as CapabilityName);
    if (!usageWithinLimit(max, usage)) {
      throw new AppError(403, DENY_CODES.LIMIT_EXCEEDED,
        `Se alcanzó el límite del plan para ${capabilityLabel(capability)} (${max ?? 0} de ${max ?? 0}). El plan Piloto puede ajustarse según las necesidades del negocio.`);
    }
  }

  /**
   * Cuota disponible (max - usage) para una capacidad. Fail-closed: sin plan
   * activo ⇒ AppError 403 'subscription_required'; sin fila de límite ⇒ 0.
   * Usado para validar LOTES antes de insertar (PR-03: sync de reseñas).
   */
  async remainingQuota(tenantId: string, capability: string): Promise<number> {
    if (!(KNOWN_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new AppError(400, 'validation_error', 'La capacidad consultada no está definida en el catálogo de límites.');
    }
    const subscription = await this.repo.findByTenant(tenantId);
    if (!subscription || subscription.status !== 'active') {
      throw new AppError(403, DENY_CODES.SUBSCRIPTION_REQUIRED,
        'Este cliente no tiene un plan activo. Consulta con el administrador del plan de MainSpot.');
    }
    const limit = await this.repo.limitFor(subscription.plan_id, capability);
    const max = limit?.max_value ?? null;
    if (max === null) return 0; // sin límite configurado ⇒ 0 (fail-closed)
    const usage = await this.countUsage(tenantId, capability as CapabilityName);
    return max - usage;
  }

  /** Cuenta el uso actual por capacidad (SELECT simple; sin ETL externo). */
  private async countUsage(tenantId: string, capability: CapabilityName): Promise<number> {
    const pool = this.deps.pool;
    let res;
    switch (capability) {
      case 'website':
        res = await pool.query<{ n: string }>('SELECT count(*) AS n FROM client_website WHERE tenant_id = $1', [tenantId]);
        break;
      case 'social_posts':
        res = await pool.query<{ n: string }>("SELECT count(*) AS n FROM social_post WHERE tenant_id = $1 AND content_type = 'post'", [tenantId]);
        break;
      case 'social_ads':
        res = await pool.query<{ n: string }>("SELECT count(*) AS n FROM social_post WHERE tenant_id = $1 AND content_type = 'ad'", [tenantId]);
        break;
      case 'reviews_managed':
        res = await pool.query<{ n: string }>('SELECT count(*) AS n FROM review WHERE tenant_id = $1', [tenantId]);
        break;
      case 'agents':
        res = await pool.query<{ n: string }>('SELECT count(*) AS n FROM internal_user WHERE tenant_id = $1', [tenantId]);
        break;
      case 'conversations':
        res = await pool.query<{ n: string }>('SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1', [tenantId]);
        break;
      default:
        throw new AppError(400, 'validation_error', 'Capacidad de límite desconocida.');
    }
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * Facturación — PROHIBIDA en el piloto si el plan no tiene precio
   * (DEC-024/RULE-006). Con precio futuro usaría PaymentProvider (simulado).
   */
  async invoice(tenantId: string, actorId: string, requestId: string): Promise<{ ok: boolean; result: string; evidence_ref: string | null }> {
    const subscription = await this.repo.findByTenant(tenantId);
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
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actorId, actor_role: null,
      action: 'subscription.invoice', resource: `subscription/${subscription.subscription_id}`, request_id: requestId,
      decision: payment.ok ? 'allow' : 'deny', result: payment.ok ? 'simulated_charge' : 'charge_failed',
      evidence_ref: payment.external_ref,
    }).catch(() => undefined);
    return { ok: payment.ok, result: payment.ok ? 'simulated_charge' : 'charge_failed', evidence_ref: payment.external_ref };
  }

  private auditedError(status: number, code: DenyCode, message: string): AppError {
    const err = new AppError(status, code, message);
    err.audited = true;
    return err;
  }
}

function capabilityLabel(capability: string): string {
  const labels: Record<string, string> = {
    website: 'páginas web',
    social_posts: 'publicaciones en redes',
    social_ads: 'anuncios en redes',
    reviews_managed: 'reseñas gestionadas',
    agents: 'agentes',
    conversations: 'conversaciones',
  };
  return labels[capability] ?? capability;
}
