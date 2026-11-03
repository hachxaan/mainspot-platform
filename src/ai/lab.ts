/**
 * AiLab (DEC-0074, SRC-0012): laboratorio manual del AI Core, SOLO con AI_ENVIRONMENT=lab.
 *
 * - Grant temporal: plataforma (platform_admin | ai_engineer con step-up) autoriza a UN usuario activo de
 *   UN negocio a ejecutar rutas concretas no retiradas (texto Anthropic / imagen OpenAI) durante 5–120 min,
 *   con motivo, revocable y auditado. El id del grant es opaco: no es permiso por sí solo; cada uso lo
 *   revalida (vigencia, revocación, negocio, usuario, membresía, emisor, entorno, ruta, proveedor).
 * - Evidencia manual: invocaciones reales (assignment `manual_lab`) de una ruta, saneadas (ids, hashes,
 *   costo, latencia; nunca contenido). Revisión manual con checklist, notas, snapshot y hash: aceptar marca
 *   DRAFT → TESTED (`tested_manual_review_id`), rechazar nunca deja un TESTED manual en pie. No crea ningún
 *   ai_eval_run: la suite automática sigue siendo la única vía para desplegar fuera del laboratorio.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { runAtomic } from '../conversation/state-machine.ts';
import { AppError } from '../shared/errors.ts';
import type { RoleName } from '../identity/entities.ts';
import { MATRIX, type ActionName } from '../rbac/matrix.ts';
import type { AiRegistry, ModelRow, RouteRow, RouteStatus } from './registry.ts';

export const LAB_ENVIRONMENT = 'lab';
export const LAB_GRANT_MINUTES = { min: 5, max: 120, default: 60 } as const;
export const LAB_GRANT_MAX_ROUTES = 20;
export const LAB_REVIEW_MAX_INVOCATIONS = 50;
/** Allowlist de proveedor por modalidad (DEC-0074): texto/razonamiento Anthropic, imágenes OpenAI. */
export const LAB_PROVIDER_BY_MODALITY: Readonly<Record<'text' | 'image', string>> = { text: 'anthropic', image: 'openai' };
export const LAB_ISSUER_ROLES = ['platform_admin', 'ai_engineer'] as const;
export const MANUAL_CHECKLIST_KEYS = ['result_reviewed', 'task_fit', 'safety_privacy', 'cost_acceptable'] as const;

export type LabGrantStatus = 'active' | 'expired' | 'revoked';
export type LabGrantFailure =
  | 'lab_disabled' | 'grant_not_found' | 'grant_revoked' | 'grant_expired' | 'grant_environment'
  | 'tenant_mismatch' | 'user_mismatch' | 'tenant_inactive' | 'user_inactive' | 'membership_missing' | 'permissions_revoked'
  | 'issuer_inactive' | 'issuer_unauthorized' | 'use_case_not_granted' | 'route_not_granted' | 'route_retired' | 'route_unavailable';

/**
 * Permisos del panel (RBAC, src/rbac/matrix.ts) que el usuario debe conservar para ejecutar cada capacidad bajo un
 * grant. Un grant solo incluye capacidades que el usuario puede ejecutar hoy y se invalida entero si pierde alguna
 * (p. ej. degradado a solo lectura): el worker no gasta con permisos viejos.
 */
export function labRequiredActions(useCaseId: string): readonly ActionName[] {
  if (useCaseId === 'conversation.owner.assistant') return ['assistant.ask'];
  if (useCaseId === 'business.insights.generate') return ['insights.read'];
  if (useCaseId.startsWith('marketing.campaign.')) return ['campaign.plan'];
  if (useCaseId.startsWith('social.')) return ['ai.generate', 'social.create'];
  if (useCaseId.startsWith('engagement.') && useCaseId.endsWith('.reply')) return ['ai.generate', 'engagement.respond'];
  return ['ai.generate'];
}

function isRoleName(name: string): name is RoleName {
  return Object.hasOwn(MATRIX, name);
}

/** Acciones permitidas hoy por los roles vigentes del usuario en el negocio (unión; fail-closed para roles desconocidos). */
export function permittedActions(roleNames: readonly string[]): Set<ActionName> {
  const out = new Set<ActionName>();
  for (const name of roleNames) if (isRoleName(name)) for (const a of MATRIX[name]) out.add(a);
  return out;
}

function missingActions(useCaseIds: readonly string[], permitted: Set<ActionName>): string[] {
  return useCaseIds.filter((uc) => labRequiredActions(uc).some((a) => !permitted.has(a)));
}

export interface LabGrantRoute {
  use_case_id: string; use_case_title: string; modality: string; route_id: string; route_version: number; route_status: RouteStatus;
  model_id: string; model_name: string; model_status: string; provider_id: string; provider_kind: string; provider_status: string; provider_model: string; max_cost_usd: string;
}
export interface LabGrantView {
  grant_id: string; environment: string; tenant_id: string; user_id: string; issued_by: string; issued_roles: string[]; reason: string;
  status: LabGrantStatus; created_at: string; expires_at: string; revoked_at: string | null; revoked_by: string | null; revoke_reason: string | null;
  route_ids: string[]; routes: LabGrantRoute[];
}
export interface LabCapability { use_case: string; route_id: string; model: string; model_name: string; provider: string; provider_kind: string; status: RouteStatus }
export interface LabStatus { grant_id: string; expires_at: string; capabilities: LabCapability[] }
export type LabCheck = { ok: true; grant: LabGrantView; route: LabGrantRoute | null } | { ok: false; reason: LabGrantFailure };

export interface LabIssuer { platformUserId: string; roles: readonly string[] }
export interface ManualChecklist { result_reviewed: boolean; task_fit: boolean; safety_privacy: boolean; cost_acceptable: boolean }
export interface ManualReviewRow {
  review_id: string; route_id: string; use_case_id: string; environment: string; decision: 'accept' | 'reject'; notes: string; checklist: ManualChecklist;
  invocation_ids: string[]; snapshot: Array<Record<string, unknown>>; snapshot_sha256: string; actor_id: string; actor_roles: string[]; created_at: string;
}
export interface ManualEvidenceInvocation {
  invocation_id: string; tenant_id: string | null; actor_id: string; actor_kind: string; origin: string; status: string; assignment: string | null;
  use_case_id: string; route_id: string | null; route_version: number | null; prompt_sha256: string | null; provider_id: string | null; provider_kind: string | null;
  provider_model: string | null; created_at: string; finished_at: string | null; cost_usd: string | null; cost_source: string; latency_ms: number | null;
  output_sha256: string | null; lab_grant_id: string | null; job_id: string | null; error_code: string | null; media_asset_id: string | null; media_sha256: string | null;
  review_ids: string[];
}
export interface LabTenantUser { user_id: string; display_name: string; email: string; role: string; status: string }
export interface LabTenant { tenant_id: string; business_name: string; status: string; data_classification: string; users: LabTenantUser[] }
export type LabRoute = RouteRow & { model: ModelRow; provider: { provider_id: string; display_name: string; kind: string; status: string }; modality: string; use_case_title: string; prompt_version: number };
export interface LabOverview { environment: string; enabled: boolean; tenants: LabTenant[]; routes: LabRoute[]; grants: LabGrantView[] }

type Db = Pool | PoolClient;

interface GrantRow extends Omit<LabGrantView, 'route_ids'> {
  tenant_status: string | null; user_status: string | null; user_tenant_id: string | null; user_roles: string[] | null;
  issuer_status: string | null; issuer_authorized: boolean;
}

export const LAB_FAILURE_MESSAGES: Readonly<Record<LabGrantFailure, string>> = {
  lab_disabled: 'El laboratorio manual solo existe en el entorno de laboratorio.',
  grant_not_found: 'La autorización de laboratorio no existe.',
  grant_revoked: 'La autorización de laboratorio fue revocada.',
  grant_expired: 'La autorización de laboratorio caducó; pide una nueva.',
  grant_environment: 'La autorización de laboratorio pertenece a otro entorno.',
  tenant_mismatch: 'La autorización de laboratorio no es de este negocio.',
  user_mismatch: 'La autorización de laboratorio no es de este usuario.',
  tenant_inactive: 'El negocio de la autorización no está activo.',
  user_inactive: 'El usuario autorizado no está activo.',
  membership_missing: 'El usuario autorizado ya no pertenece al negocio.',
  permissions_revoked: 'El usuario ya no tiene los permisos del panel que exigen las capacidades autorizadas.',
  issuer_inactive: 'Quien emitió la autorización ya no está activo en la plataforma.',
  issuer_unauthorized: 'Quien emitió la autorización ya no tiene un rol que la permita.',
  use_case_not_granted: 'Esta capacidad no está incluida en la autorización de laboratorio.',
  route_not_granted: 'La ruta solicitada no es la autorizada para esta capacidad.',
  route_retired: 'La ruta autorizada fue retirada.',
  route_unavailable: 'El modelo o el proveedor de la ruta autorizada está deshabilitado.',
};

const ROUTES_JSON = `COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'use_case_id', gr.use_case_id, 'use_case_title', uc.title, 'modality', uc.modality, 'route_id', r.route_id, 'route_version', r.version,
      'route_status', r.status, 'model_id', m.model_id, 'model_name', m.display_name, 'model_status', m.status, 'provider_id', p.provider_id,
      'provider_kind', p.kind, 'provider_status', p.status, 'provider_model', m.provider_model, 'max_cost_usd', r.max_cost_usd) ORDER BY gr.use_case_id)
     FROM ai_lab_grant_route gr JOIN ai_route_revision r ON r.route_id = gr.route_id JOIN ai_use_case uc ON uc.use_case_id = gr.use_case_id
     JOIN ai_model m ON m.model_id = r.model_id JOIN ai_provider p ON p.provider_id = m.provider_id WHERE gr.grant_id = g.grant_id), '[]') AS routes`;
const STATUS_SQL = `CASE WHEN g.revoked_at IS NOT NULL THEN 'revoked' WHEN g.expires_at <= now() THEN 'expired' ELSE 'active' END AS status`;
/** `rolesParam`: placeholder posicional (p. ej. `$2`) del array de roles que autorizan al emisor. */
function grantSelect(rolesParam: string): string {
  return `SELECT g.grant_id, g.environment, g.tenant_id, g.user_id, g.issued_by, g.issued_roles, g.reason, g.created_at, g.expires_at, g.revoked_at, g.revoked_by, g.revoke_reason,
       ${STATUS_SQL}, c.status AS tenant_status, u.status AS user_status, u.tenant_id AS user_tenant_id,
       (SELECT array_agg(r.name) FROM user_role ur JOIN role r ON r.role_id = ur.role_id WHERE ur.user_id = g.user_id AND ur.tenant_id = g.tenant_id) AS user_roles,
       pu.status AS issuer_status,
       EXISTS (SELECT 1 FROM platform_user_role pr WHERE pr.platform_user_id = g.issued_by AND pr.role = ANY(${rolesParam}::text[])) AS issuer_authorized,
       ${ROUTES_JSON}
  FROM ai_lab_grant g LEFT JOIN client c ON c.client_id = g.tenant_id LEFT JOIN internal_user u ON u.user_id = g.user_id
  LEFT JOIN platform_user pu ON pu.platform_user_id = g.issued_by`;
}

/** Rutas que un grant puede incluir: no retiradas, caso de uso generativo activo, modelo y proveedor activos, proveedor de la allowlist. */
const ELIGIBLE_ROUTES_SQL = `SELECT r.*, to_jsonb(m.*) AS model,
       jsonb_build_object('provider_id', p.provider_id, 'display_name', p.display_name, 'kind', p.kind, 'status', p.status) AS provider,
       uc.modality, uc.title AS use_case_title, pr.version AS prompt_version
  FROM ai_route_revision r JOIN ai_use_case uc ON uc.use_case_id = r.use_case_id JOIN ai_model m ON m.model_id = r.model_id
  JOIN ai_provider p ON p.provider_id = m.provider_id JOIN ai_prompt_revision pr ON pr.revision_id = r.prompt_revision_id
 WHERE r.status <> 'RETIRED' AND uc.status = 'active' AND m.status = 'active' AND p.status = 'active'
   AND ((uc.modality = 'text' AND p.kind = $1) OR (uc.modality = 'image' AND p.kind = $2))`;

const EVIDENCE_SQL = `SELECT i.invocation_id, i.tenant_id, i.actor_id, i.actor_kind, i.origin, i.status, i.assignment, i.use_case_id, i.route_id, i.route_version, i.prompt_sha256,
       i.provider_id, p.kind AS provider_kind, i.provider_model, i.created_at, i.finished_at, i.cost_usd, i.cost_source, i.latency_ms, i.output_sha256, i.lab_grant_id,
       i.job_id, i.error_code, ma.asset_id AS media_asset_id, ma.sha256 AS media_sha256,
       COALESCE((SELECT jsonb_agg(rv.review_id ORDER BY rv.created_at DESC) FROM ai_manual_review rv WHERE rv.route_id = i.route_id AND rv.invocation_ids @> to_jsonb(i.invocation_id)), '[]') AS review_ids
  FROM ai_invocation i LEFT JOIN ai_provider p ON p.provider_id = i.provider_id
  LEFT JOIN LATERAL (SELECT asset_id, sha256 FROM media_asset WHERE invocation_id = i.invocation_id ORDER BY created_at DESC LIMIT 1) ma ON true`;

function toView(row: GrantRow): LabGrantView {
  const { tenant_status: _t, user_status: _u, user_tenant_id: _ut, user_roles: _r, issuer_status: _i, issuer_authorized: _a, ...view } = row;
  return { ...view, route_ids: view.routes.map((r) => r.route_id) };
}

function uniqueStrings(value: unknown, max: number, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new AppError(400, 'validation_error', `Indica al menos ${what}.`);
  const out = [...new Set(value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0 && v.length <= 120))];
  if (!out.length || out.length !== value.length) throw new AppError(400, 'validation_error', `La lista de ${what} tiene valores vacíos o repetidos.`);
  if (out.length > max) throw new AppError(400, 'validation_error', `Máximo ${max} ${what} por operación.`);
  return out;
}

function textBetween(value: unknown, min: number, max: number, what: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < min || s.length > max) throw new AppError(400, 'validation_error', `${what} (${min} a ${max} caracteres).`);
  return s;
}

export class AiLab {
  readonly environment: string;
  /** Solo el entorno `lab` emite o acepta grants; en cualquier otro, todo grant es inválido (fail closed). */
  readonly enabled: boolean;
  private readonly pool: Pool;
  private readonly registry: AiRegistry;

  constructor(deps: { pool: Pool; registry: AiRegistry; environment: string }) {
    this.pool = deps.pool;
    this.registry = deps.registry;
    this.environment = deps.environment;
    this.enabled = deps.environment === LAB_ENVIRONMENT;
  }

  // ------------------------------------------------------------------ lectura y validación (dispatcher, worker, API del negocio)

  private async grantRow(grantId: string, db: Db = this.pool): Promise<GrantRow | null> {
    const r = await db.query<GrantRow>(`${grantSelect('$2')} WHERE g.grant_id = $1`, [grantId, [...LAB_ISSUER_ROLES]]);
    return r.rows[0] ?? null;
  }

  async grantView(grantId: string): Promise<LabGrantView | null> {
    const row = await this.grantRow(grantId);
    return row ? toView(row) : null;
  }

  /**
   * Revalidación completa, sin lanzar: vigencia, revocación, entorno, negocio, usuario (activo y con membresía),
   * emisor (activo y con rol) y, si se indica, que el caso de uso esté en la allowlist con esa ruta y que la
   * ruta siga ejecutable. Un id opaco nunca basta.
   */
  async check(input: { grantId: string | null | undefined; tenantId: string | null | undefined; userId: string; useCaseId?: string | null; routeId?: string | null }): Promise<LabCheck> {
    if (!this.enabled) return { ok: false, reason: 'lab_disabled' };
    const grantId = typeof input.grantId === 'string' ? input.grantId.trim() : '';
    if (!grantId || grantId.length > 120) return { ok: false, reason: 'grant_not_found' };
    const row = await this.grantRow(grantId);
    if (!row) return { ok: false, reason: 'grant_not_found' };
    if (row.environment !== this.environment) return { ok: false, reason: 'grant_environment' };
    if (row.status === 'revoked') return { ok: false, reason: 'grant_revoked' };
    if (row.status === 'expired') return { ok: false, reason: 'grant_expired' };
    if (!input.tenantId || row.tenant_id !== input.tenantId) return { ok: false, reason: 'tenant_mismatch' };
    if (row.user_id !== input.userId) return { ok: false, reason: 'user_mismatch' };
    if (row.tenant_status !== 'active') return { ok: false, reason: 'tenant_inactive' };
    if (row.user_status !== 'active' || row.user_tenant_id !== row.tenant_id) return { ok: false, reason: 'user_inactive' };
    if (!row.user_roles?.length) return { ok: false, reason: 'membership_missing' };
    // Permisos vigentes: el conjunto completo del grant debe seguir siendo ejecutable (también antes de clasificar en un job).
    if (missingActions(row.routes.map((r) => r.use_case_id), permittedActions(row.user_roles)).length) return { ok: false, reason: 'permissions_revoked' };
    if (row.issuer_status !== 'active') return { ok: false, reason: 'issuer_inactive' };
    if (!row.issuer_authorized) return { ok: false, reason: 'issuer_unauthorized' };
    const grant = toView(row);
    if (!input.useCaseId) return { ok: true, grant, route: null };
    const route = grant.routes.find((r) => r.use_case_id === input.useCaseId);
    if (!route) return { ok: false, reason: 'use_case_not_granted' };
    if (input.routeId && input.routeId !== route.route_id) return { ok: false, reason: 'route_not_granted' };
    if (route.route_status === 'RETIRED') return { ok: false, reason: 'route_retired' };
    if (route.model_status !== 'active' || route.provider_status !== 'active') return { ok: false, reason: 'route_unavailable' };
    return { ok: true, grant, route };
  }

  /** Cabecera `X-AI-Lab-Grant` del panel: vacía ⇒ null; inválida ⇒ 403 (nunca degradar en silencio a la ruta normal). */
  async authorize(input: { grantId: string | null | undefined; tenantId: string; userId: string }): Promise<LabGrantView | null> {
    const grantId = typeof input.grantId === 'string' ? input.grantId.trim() : '';
    if (!grantId) return null;
    const check = await this.check({ grantId, tenantId: input.tenantId, userId: input.userId });
    if (!check.ok) throw new AppError(403, 'permission_denied', LAB_FAILURE_MESSAGES[check.reason]);
    return check.grant;
  }

  /** Bloque `lab` de /ai/status: solo si el grant seleccionado es válido para este usuario; nunca lanza. */
  async statusFor(input: { grantId: string | null | undefined; tenantId: string; userId: string }): Promise<LabStatus | null> {
    const check = await this.check({ grantId: input.grantId, tenantId: input.tenantId, userId: input.userId });
    if (!check.ok) return null;
    return {
      grant_id: check.grant.grant_id, expires_at: check.grant.expires_at,
      capabilities: check.grant.routes.map((r) => ({ use_case: r.use_case_id, route_id: r.route_id, model: r.model_id, model_name: r.model_name, provider: r.provider_id, provider_kind: r.provider_kind, status: r.route_status })),
    };
  }

  /** Grants vigentes de un usuario en su negocio (panel): sin llamadas a proveedores. */
  async grantsForUser(tenantId: string, userId: string): Promise<LabGrantView[]> {
    if (!this.enabled) return [];
    const r = await this.pool.query<GrantRow>(
      `${grantSelect('$4')} WHERE g.tenant_id = $1 AND g.user_id = $2 AND g.environment = $3 AND g.revoked_at IS NULL AND g.expires_at > now()
        ORDER BY g.created_at DESC LIMIT 20`, [tenantId, userId, this.environment, [...LAB_ISSUER_ROLES]]);
    return r.rows.map(toView);
  }

  // ------------------------------------------------------------------ plataforma: emisión y revocación

  private requireEnabled(): void {
    if (!this.enabled) throw new AppError(403, 'permission_denied', LAB_FAILURE_MESSAGES.lab_disabled);
  }

  private requireIssuer(issuer: LabIssuer): void {
    if (!issuer.roles.some((r) => (LAB_ISSUER_ROLES as readonly string[]).includes(r))) throw new AppError(403, 'permission_denied', 'Solo administración de plataforma o ingeniería de IA emiten autorizaciones de laboratorio.');
  }

  async eligibleRoutes(routeIds?: string[]): Promise<LabRoute[]> {
    const params: unknown[] = [LAB_PROVIDER_BY_MODALITY.text, LAB_PROVIDER_BY_MODALITY.image];
    let sql = ELIGIBLE_ROUTES_SQL;
    if (routeIds) { params.push(routeIds); sql += ` AND r.route_id = ANY($3::text[])`; }
    return (await this.pool.query<LabRoute>(`${sql} ORDER BY r.use_case_id, r.version DESC`, params)).rows;
  }

  async overview(): Promise<LabOverview> {
    const tenants = await this.pool.query<LabTenant>(
      `SELECT c.client_id AS tenant_id, c.business_name, c.status, c.data_classification,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', u.user_id, 'display_name', u.display_name, 'email', u.login, 'role', r.name, 'status', u.status) ORDER BY u.display_name, r.name)
                          FROM internal_user u JOIN user_role ur ON ur.user_id = u.user_id AND ur.tenant_id = c.client_id JOIN role r ON r.role_id = ur.role_id
                         WHERE u.tenant_id = c.client_id AND u.status = 'active'), '[]') AS users
         FROM client c WHERE c.status = 'active' ORDER BY c.business_name, c.client_id LIMIT 1000`);
    const grants = await this.pool.query<GrantRow>(`${grantSelect('$2')} WHERE g.environment = $1 ORDER BY g.created_at DESC LIMIT 100`, [this.environment, [...LAB_ISSUER_ROLES]]);
    return { environment: this.environment, enabled: this.enabled, tenants: tenants.rows, routes: this.enabled ? await this.eligibleRoutes() : [], grants: grants.rows.map(toView) };
  }

  async issueGrant(input: { tenantId: unknown; userId: unknown; routeIds: unknown; minutes?: unknown; reason: unknown; issuer: LabIssuer }): Promise<LabGrantView> {
    this.requireEnabled();
    this.requireIssuer(input.issuer);
    const tenantId = textBetween(input.tenantId, 1, 120, 'Elige el negocio');
    const userId = textBetween(input.userId, 1, 120, 'Elige el usuario');
    const reason = textBetween(input.reason, 10, 500, 'Escribe el motivo');
    const minutes = input.minutes === undefined || input.minutes === null || input.minutes === '' ? LAB_GRANT_MINUTES.default : Number(input.minutes);
    if (!Number.isInteger(minutes) || minutes < LAB_GRANT_MINUTES.min || minutes > LAB_GRANT_MINUTES.max) throw new AppError(400, 'validation_error', `La autorización dura de ${LAB_GRANT_MINUTES.min} a ${LAB_GRANT_MINUTES.max} minutos.`);
    const routeIds = uniqueStrings(input.routeIds, LAB_GRANT_MAX_ROUTES, 'una ruta');
    const tenant = await this.pool.query<{ status: string }>('SELECT status FROM client WHERE client_id = $1', [tenantId]);
    if (!tenant.rows[0]) throw new AppError(404, 'not_found', 'No existe ese negocio.');
    if (tenant.rows[0].status !== 'active') throw new AppError(409, 'validation_error', 'El negocio no está activo.');
    const user = await this.pool.query<{ status: string; tenant_id: string; roles: string[] | null }>(
      `SELECT u.status, u.tenant_id, (SELECT array_agg(r.name) FROM user_role ur JOIN role r ON r.role_id = ur.role_id WHERE ur.user_id = u.user_id AND ur.tenant_id = $2) AS roles
         FROM internal_user u WHERE u.user_id = $1`, [userId, tenantId]);
    const u = user.rows[0];
    if (!u || u.tenant_id !== tenantId || !u.roles?.length) throw new AppError(404, 'not_found', 'Ese usuario no pertenece al negocio.');
    if (u.status !== 'active') throw new AppError(409, 'validation_error', 'El usuario no está activo.');
    const routes = await this.eligibleRoutes(routeIds);
    const byId = new Map(routes.map((r) => [r.route_id, r]));
    const missing = routeIds.filter((id) => !byId.has(id));
    if (missing.length) throw new AppError(400, 'validation_error', `Rutas no autorizables (retiradas, de clasificación, con modelo o proveedor deshabilitado, o fuera de la allowlist Anthropic texto / OpenAI imagen): ${missing.join(', ')}.`);
    const useCases = new Set<string>();
    for (const r of routes) {
      if (useCases.has(r.use_case_id)) throw new AppError(400, 'validation_error', `Solo una ruta por caso de uso (${r.use_case_id}).`);
      useCases.add(r.use_case_id);
    }
    // Solo capacidades que el usuario puede ejecutar HOY con su rol en el negocio (p. ej. solo lectura: asistente e insights).
    const notPermitted = missingActions([...useCases], permittedActions(u.roles));
    if (notPermitted.length) throw new AppError(400, 'validation_error', `El usuario no tiene permisos vigentes para: ${notPermitted.join(', ')}.`);
    const grantId = `lbg_${randomUUID()}`;
    await runAtomic(this.pool, async (client) => {
      await client.query(
        `INSERT INTO ai_lab_grant (grant_id, environment, tenant_id, user_id, issued_by, issued_roles, reason, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(mins => $8))`,
        [grantId, this.environment, tenantId, userId, input.issuer.platformUserId, [...input.issuer.roles], reason, minutes]);
      for (const r of routes) {
        await client.query('INSERT INTO ai_lab_grant_route (grant_id, tenant_id, use_case_id, route_id) VALUES ($1,$2,$3,$4)', [grantId, tenantId, r.use_case_id, r.route_id]);
      }
    });
    return (await this.grantView(grantId)) as LabGrantView;
  }

  /** Idempotente: revocar un grant ya revocado devuelve su estado sin cambiarlo; `revoked` indica si esta llamada lo revocó. */
  async revokeGrant(grantId: string, input: { reason: unknown; issuer: LabIssuer }): Promise<{ grant: LabGrantView; revoked: boolean }> {
    this.requireIssuer(input.issuer);
    const reason = textBetween(input.reason, 10, 500, 'Escribe el motivo');
    const row = await this.grantRow(grantId);
    if (!row || row.environment !== this.environment) throw new AppError(404, 'not_found', 'No existe esa autorización de laboratorio.');
    if (row.revoked_at) return { grant: toView(row), revoked: false };
    const updated = await this.pool.query('UPDATE ai_lab_grant SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE grant_id = $1 AND revoked_at IS NULL', [grantId, input.issuer.platformUserId, reason]);
    return { grant: (await this.grantView(grantId)) as LabGrantView, revoked: (updated.rowCount ?? 0) > 0 };
  }

  // ------------------------------------------------------------------ evidencia manual y revisión

  async manualEvidence(routeId: string): Promise<{ route: RouteRow; invocations: ManualEvidenceInvocation[]; reviews: ManualReviewRow[] }> {
    const route = await this.registry.route(routeId);
    if (!route) throw new AppError(404, 'not_found', 'No existe esa ruta.');
    const inv = await this.pool.query<ManualEvidenceInvocation>(`${EVIDENCE_SQL} WHERE i.route_id = $1 AND i.assignment = 'manual_lab' ORDER BY i.created_at DESC LIMIT 200`, [routeId]);
    return { route, invocations: inv.rows, reviews: await this.reviews(routeId) };
  }

  async reviews(routeId: string): Promise<ManualReviewRow[]> {
    return (await this.pool.query<ManualReviewRow>('SELECT * FROM ai_manual_review WHERE route_id = $1 ORDER BY created_at DESC LIMIT 50', [routeId])).rows;
  }

  /**
   * Aceptar exige evidencia real y completa: invocaciones `manual_lab` bajo grant de este entorno, exitosas, de la
   * MISMA ruta/prompt/caso de uso, proveedor real (no simulado), salida con hash y costo trazable (imágenes: asset
   * persistido). Rechazar documenta la revisión sobre invocaciones de la ruta y retira un TESTED manual previo.
   */
  async manualReview(routeId: string, input: { invocationIds: unknown; decision: unknown; notes: unknown; checklist: unknown; actor: LabIssuer }): Promise<{ review: ManualReviewRow; route: RouteRow }> {
    this.requireEnabled();
    this.requireIssuer(input.actor);
    const decision = input.decision === 'accept' || input.decision === 'reject' ? input.decision : null;
    if (!decision) throw new AppError(400, 'validation_error', 'La decisión es accept o reject.');
    const notes = textBetween(input.notes, 10, 2000, 'Escribe las notas de la revisión');
    if (typeof input.checklist !== 'object' || input.checklist === null) throw new AppError(400, 'validation_error', 'La lista de verificación necesita los cuatro puntos (true/false).');
    const flags = new Map(Object.entries(input.checklist));
    const flag = (k: keyof ManualChecklist): boolean => {
      const v = flags.get(k);
      if (typeof v !== 'boolean') throw new AppError(400, 'validation_error', 'La lista de verificación necesita los cuatro puntos (true/false).');
      return v;
    };
    const checklist: ManualChecklist = { result_reviewed: flag('result_reviewed'), task_fit: flag('task_fit'), safety_privacy: flag('safety_privacy'), cost_acceptable: flag('cost_acceptable') };
    if (decision === 'accept' && MANUAL_CHECKLIST_KEYS.some((k) => !checklist[k])) throw new AppError(409, 'validation_error', 'Para aceptar, los cuatro puntos de la lista de verificación deben estar confirmados.');
    const invocationIds = uniqueStrings(input.invocationIds, LAB_REVIEW_MAX_INVOCATIONS, 'una invocación');
    const bundle = await this.registry.bundle(routeId);
    if (!bundle) throw new AppError(404, 'not_found', 'No existe esa ruta.');
    const rows = (await this.pool.query<ManualEvidenceInvocation>(`${EVIDENCE_SQL} WHERE i.invocation_id = ANY($1::text[])`, [invocationIds])).rows;
    const byId = new Map(rows.map((r) => [r.invocation_id, r]));
    const problems: string[] = [];
    for (const id of invocationIds) {
      const inv = byId.get(id);
      if (!inv) { problems.push(`${id}: no existe`); continue; }
      if (inv.route_id !== routeId || inv.use_case_id !== bundle.route.use_case_id) problems.push(`${id}: no es de esta ruta`);
      else if (inv.prompt_sha256 !== bundle.prompt.sha256) problems.push(`${id}: prompt distinto`);
      if (inv.assignment !== 'manual_lab' || !inv.lab_grant_id) problems.push(`${id}: no se ejecutó bajo una autorización de laboratorio`);
      if (inv.provider_kind === 'simulated' || inv.provider_kind === null) problems.push(`${id}: proveedor simulado o desconocido`);
      if (decision === 'accept') {
        if (inv.status !== 'succeeded') problems.push(`${id}: no terminó con éxito (${inv.status})`);
        if (!inv.output_sha256) problems.push(`${id}: sin hash de salida`);
        if (inv.cost_usd === null || !['reported', 'estimated'].includes(inv.cost_source)) problems.push(`${id}: costo no trazable`);
        if (bundle.model.modality === 'image' && !inv.media_asset_id) problems.push(`${id}: la imagen no quedó guardada en la biblioteca`);
      }
    }
    const grants = await this.pool.query<{ grant_id: string }>('SELECT grant_id FROM ai_lab_grant WHERE grant_id = ANY($1::text[]) AND environment = $2',
      [[...new Set(rows.map((r) => r.lab_grant_id).filter((g): g is string => Boolean(g)))], this.environment]);
    const known = new Set(grants.rows.map((g) => g.grant_id));
    for (const inv of rows) if (inv.lab_grant_id && !known.has(inv.lab_grant_id)) problems.push(`${inv.invocation_id}: autorización de otro entorno o inexistente`);
    if (problems.length) throw new AppError(409, 'validation_error', `La evidencia no es válida: ${problems.slice(0, 8).join('; ')}.`);
    const snapshot = rows.filter((inv) => invocationIds.includes(inv.invocation_id)).sort((x, y) => invocationIds.indexOf(x.invocation_id) - invocationIds.indexOf(y.invocation_id)).map((inv) => ({
      invocation_id: inv.invocation_id, use_case_id: inv.use_case_id, route_id: inv.route_id, route_version: inv.route_version, route_sha256: bundle.route.sha256,
      prompt_sha256: inv.prompt_sha256, provider_id: inv.provider_id, provider_kind: inv.provider_kind, provider_model: inv.provider_model, assignment: inv.assignment,
      lab_grant_id: inv.lab_grant_id, status: inv.status, cost_usd: inv.cost_usd, cost_source: inv.cost_source, latency_ms: inv.latency_ms, output_sha256: inv.output_sha256,
      media_asset_id: inv.media_asset_id, media_sha256: inv.media_sha256, created_at: inv.created_at, finished_at: inv.finished_at,
    }));
    const reviewId = `mrv_${randomUUID()}`;
    return runAtomic(this.pool, async (client) => {
      const locked = (await client.query<RouteRow>('SELECT * FROM ai_route_revision WHERE route_id = $1 FOR UPDATE', [routeId])).rows[0];
      if (!locked) throw new AppError(404, 'not_found', 'No existe esa ruta.');
      if (!['DRAFT', 'TESTED'].includes(locked.status)) throw new AppError(409, 'validation_error', 'La revisión manual solo aplica a rutas en borrador o probadas; una ruta aprobada o desplegada se gestiona desde el rollout.');
      const review = (await client.query<ManualReviewRow>(
        `INSERT INTO ai_manual_review (review_id, route_id, use_case_id, environment, decision, notes, checklist, invocation_ids, snapshot, snapshot_sha256, actor_id, actor_roles)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [reviewId, routeId, locked.use_case_id, this.environment, decision, notes, JSON.stringify(checklist), JSON.stringify(invocationIds), JSON.stringify(snapshot),
          createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
          input.actor.platformUserId, [...input.actor.roles]])).rows[0] as ManualReviewRow;
      const route = (await client.query<RouteRow>(
        decision === 'accept'
          ? `UPDATE ai_route_revision SET status = CASE WHEN status = 'DRAFT' THEN 'TESTED' ELSE status END, tested_manual_review_id = $2 WHERE route_id = $1 RETURNING *`
          : `UPDATE ai_route_revision SET status = CASE WHEN status = 'TESTED' AND tested_eval_run_id IS NULL THEN 'DRAFT' ELSE status END, tested_manual_review_id = NULL WHERE route_id = $1 RETURNING *`,
        decision === 'accept' ? [routeId, reviewId] : [routeId])).rows[0] as RouteRow;
      return { review, route };
    });
  }
}
