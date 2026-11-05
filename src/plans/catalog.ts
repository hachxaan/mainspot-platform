/**
 * Mantenimiento del catálogo de planes (FR-0010, FR-0019 «Planes», DEC-0075/SRC-0013).
 *
 * Ciclo de vida de una revisión: DRAFT → PUBLISHED → SUPERSEDED (o DRAFT → DISCARDED). Las publicadas
 * son inmutables (trigger de la migración 0034); editar = revisión nueva; rollback = revisión nueva con
 * los valores de una anterior. Crear o clonar un plan lo deja DESHABILITADO con un borrador cuyos valores
 * sugeridos o copiados están SIN confirmar: guardar nunca confirma, cambiar un valor borra su
 * confirmación y publicar exige TODOS los parámetros del registro presentes, válidos y confirmados uno a
 * uno. Publicar es configuración operativa (SRC-0013 publish_meaning): no aprueba nombres, precios ni
 * paquetes comerciales (Q-004 sigue pospuesta) y no cambia a los clientes vigentes (suscripciones fijadas).
 *
 * Concurrencia: toda escritura toma `plan FOR UPDATE` (serializa por plan) y exige el `lock_version` del
 * borrador (409 stale_version si otro lo cambió). Cada escritura deja, en la misma transacción, un
 * `plan_catalog_event` con motivo y diff y un evento en la auditoría de plataforma; una escritura permitida
 * que no cambia nada (habilitar lo ya habilitado) solo deja la auditoría de plataforma con `noop`.
 *
 * Textos (motivos, nombres, descripciones): se cuentan en caracteres reales (puntos de código, como
 * PostgreSQL) y no admiten caracteres de control ni de formato. Quedan en tablas inmutables sin negocio
 * (`plan_catalog_event`, `plan_revision`), que la anonimización no puede re-etiquetar (DEC-0027): por eso
 * tampoco admiten correos ni identificadores de negocio (`client_…`).
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { runAtomic } from '../conversation/state-machine.ts';
import { assertNoTenantData, assertPlatformReason, charLength, hasControlOrFormat, writePlatformAudit } from '../platform/auth.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import type { PlatformActor } from './assignment.ts';
import { revisionValues } from './policy.ts';
import {
  PLAN_PARAMETERS,
  PLAN_REGISTRY_VERSION,
  definitionByKey,
  definitionRow,
  periodLabel,
  validateValue,
  type ParameterValue,
  type PlanParameterDefinition,
} from './registry.ts';

export type RevisionStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'DISCARDED';

export interface RevisionRow {
  revision_id: string;
  plan_id: string;
  version: number;
  status: RevisionStatus;
  origin: 'backfill' | 'create' | 'clone' | 'edit' | 'rollback';
  based_on_revision_id: string | null;
  lock_version: number;
  reason: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  published_by: string | null;
  published_at: Date | null;
  publish_reason: string | null;
  checksum: string | null;
  superseded_at: Date | null;
  discarded_at: Date | null;
}

export interface ValueRow {
  parameter_key: string;
  value: ParameterValue | null;
  source: string;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  updated_by: string;
  updated_at: Date;
}

export interface DiffEntry {
  key: string;
  label: string;
  from: ParameterValue | null;
  to: ParameterValue | null;
}

export interface ReviewItem {
  key: string;
  label: string;
  unit: string;
  period: string;
  value: ParameterValue | null;
  base_value: ParameterValue | null;
  changed: boolean;
  confirmed: boolean;
  source: string | null;
  problem: string | null;
}

export interface DraftValueInput {
  key: string;
  /** Presente ⇒ fija el valor (null lo vacía). Ausente ⇒ no cambia el valor. */
  value?: ParameterValue | null;
  /** true ⇒ confirma el valor resultante; false ⇒ retira la confirmación. Ausente ⇒ sin cambio. */
  confirmed?: boolean;
}

const actorRef = (a: PlatformActor) => `platform:${a.platformUserId}`;

/** Huella canónica: `clave=valor` por línea, ordenado por clave; igual a plan_revision_checksum() en SQL. */
export function revisionChecksum(values: ReadonlyMap<string, ParameterValue>): string {
  const lines = [...values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${String(v)}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function diffValues(from: ReadonlyMap<string, ParameterValue | null>, to: ReadonlyMap<string, ParameterValue | null>, defs: readonly PlanParameterDefinition[] = PLAN_PARAMETERS): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const def of defs) {
    const a = from.get(def.key) ?? null;
    const b = to.get(def.key) ?? null;
    if (a !== b) out.push({ key: def.key, label: def.label, from: a, to: b });
  }
  return out;
}

function planIdFor(name: string): string {
  const slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32) || 'plan';
  return `plan_${slug}_${randomUUID().slice(0, 6)}`;
}

function cleanName(name: unknown): string {
  const v = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  const length = charLength(v);
  if (length < 3 || length > 60) throw new AppError(400, 'validation_error', 'Escribe el nombre del plan (3 a 60 caracteres).');
  if (hasControlOrFormat(v)) throw new AppError(400, 'validation_error', 'El nombre del plan tiene caracteres invisibles o de control. Escríbelo de nuevo sin pegarlo de otro documento.');
  assertNoTenantData(v, 'el nombre del plan');
  return v;
}

function cleanDescription(description: unknown): string | null {
  if (description === undefined || description === null || description === '') return null;
  const v = typeof description === 'string' ? description.trim() : null;
  if (v === null || charLength(v) > 300) throw new AppError(400, 'validation_error', 'La descripción admite hasta 300 caracteres.');
  if (hasControlOrFormat(v)) throw new AppError(400, 'validation_error', 'La descripción tiene caracteres invisibles o de control. Escríbela de nuevo sin pegarla de otro documento.');
  assertNoTenantData(v, 'la descripción');
  return v;
}

const conflict = () => new AppError(409, DENY_CODES.STALE_VERSION,
  'Otra persona cambió este borrador mientras lo editabas. Recarga para ver la versión actual y vuelve a aplicar tus cambios.');

/** Nombre ya usado por una escritura concurrente (índice único `lower(name)`, 23505) ⇒ 409, nunca 500. */
function duplicateName(err: unknown): never {
  if (err && typeof err === 'object' && 'code' in err && err.code === '23505') {
    throw new AppError(409, 'validation_error', 'Ya existe un plan con ese nombre.');
  }
  throw err;
}

export class PlanCatalog {
  private readonly pool: Pool;
  private readonly definitions: readonly PlanParameterDefinition[];

  constructor(deps: { pool: Pool; definitions?: readonly PlanParameterDefinition[] }) {
    this.pool = deps.pool;
    this.definitions = deps.definitions ?? PLAN_PARAMETERS;
  }

  // ------------------------------------------------------------------ espejo del registro

  /** Diferencias entre el registro de código y `plan_parameter_definition` (vacío = coherentes). */
  async registryDifferences(db: Pool | PoolClient = this.pool): Promise<string[]> {
    const rows = (await db.query<Record<string, string | number | boolean | null>>(
      `SELECT parameter_key, capability, value_type, semantics, period_kind, window_seconds, min_value, max_value,
              suggested_int, suggested_bool, enforcement_state, registry_version FROM plan_parameter_definition`)).rows;
    const byKey = new Map(rows.map((r) => [String(r['parameter_key']), r]));
    const diffs: string[] = [];
    for (const def of this.definitions) {
      const row = byKey.get(def.key);
      if (!row) { diffs.push(`${def.key}: falta en la BD`); continue; }
      for (const [col, expected] of Object.entries(definitionRow(def))) {
        if ((row[col] ?? null) !== expected) diffs.push(`${def.key}.${col}: registro=${String(expected)} BD=${String(row[col])}`);
      }
      byKey.delete(def.key);
    }
    for (const key of byKey.keys()) diffs.push(`${key}: existe en la BD pero no en el registro`);
    return diffs;
  }

  private async assertWritable(client: PoolClient): Promise<void> {
    const diffs = await this.registryDifferences(client);
    if (diffs.length) {
      log.error('plan.catalog.registry_mismatch', 'plan parameter registry and database differ; catalog writes blocked', { differences: diffs.slice(0, 10) });
      throw new AppError(503, DENY_CODES.INTERNAL,
        'El catálogo de planes no coincide con el registro del servidor; las escrituras están bloqueadas hasta corregir la migración.');
    }
  }

  // ------------------------------------------------------------------ lectura

  parameters(): Array<PlanParameterDefinition & { period_label: string }> {
    return this.definitions.map((d) => ({ ...d, period_label: periodLabel(d) })).sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async listPlans(): Promise<unknown[]> {
    const r = await this.pool.query(
      `SELECT p.plan_id, p.name, p.description, p.active, p.is_pilot, p.price_cents, p.created_at, p.updated_at,
              pub.revision_id AS published_revision_id, pub.version AS published_version, pub.published_at,
              dr.revision_id AS draft_revision_id, dr.version AS draft_version, dr.lock_version AS draft_lock_version,
              (SELECT count(*)::int FROM subscription s WHERE s.plan_id = p.plan_id) AS subscriptions,
              (SELECT count(*)::int FROM subscription s WHERE s.plan_id = p.plan_id AND s.plan_revision_id <> pub.revision_id) AS subscriptions_on_older
         FROM plan p
         LEFT JOIN plan_revision pub ON pub.plan_id = p.plan_id AND pub.status = 'PUBLISHED'
         LEFT JOIN plan_revision dr ON dr.plan_id = p.plan_id AND dr.status = 'DRAFT'
        ORDER BY p.active DESC, p.is_pilot DESC, p.name`);
    return r.rows.map((row) => ({ ...row, state: row.published_revision_id ? (row.active ? 'enabled' : 'disabled') : 'draft_only' }));
  }

  private async valueRows(db: Pool | PoolClient, revisionId: string): Promise<ValueRow[]> {
    const r = await db.query<ValueRow & { value_int: number | null; value_bool: boolean | null }>(
      `SELECT parameter_key, value_int, value_bool, source, confirmed_by, confirmed_at, updated_by, updated_at
         FROM plan_parameter_value WHERE revision_id = $1 ORDER BY parameter_key`, [revisionId]);
    return r.rows.map(({ value_int, value_bool, ...rest }) => ({ ...rest, value: value_int ?? value_bool ?? null }));
  }

  /** Suscripciones del plan por revisión fijada: solo recuentos, sin identidades de negocios. */
  private async subscriptionsByRevision(planId: string): Promise<Array<{ revision_id: string; version: number; n: number }>> {
    return (await this.pool.query<{ revision_id: string; version: number; n: number }>(
      `SELECT s.plan_revision_id AS revision_id, r.version, count(*)::int AS n FROM subscription s
         JOIN plan_revision r ON r.revision_id = s.plan_revision_id WHERE s.plan_id = $1 GROUP BY 1,2 ORDER BY 2`, [planId])).rows;
  }

  /**
   * Detalle del plan. `subscriptions_by_revision` (recuentos) siempre; la lista de negocios (`subscriptions`,
   * con id y nombre) solo con `tenantIdentities` (permiso `tenants.read`); sin él sale vacía (BR-0007).
   */
  async planDetail(planId: string, opts: { tenantIdentities: boolean }): Promise<Record<string, unknown> & { subscriptions: unknown[] }> {
    const plan = (await this.pool.query('SELECT plan_id, name, description, active, is_pilot, price_cents, currency, created_by, created_at, updated_at FROM plan WHERE plan_id = $1', [planId])).rows[0];
    if (!plan) throw new AppError(404, DENY_CODES.NOT_FOUND, 'No existe ese plan.');
    const revisions = (await this.pool.query<RevisionRow>('SELECT * FROM plan_revision WHERE plan_id = $1 ORDER BY version DESC', [planId])).rows;
    const withValues = [];
    for (const rev of revisions) withValues.push({ ...rev, values: await this.valueRows(this.pool, rev.revision_id) });
    const subscriptions = opts.tenantIdentities ? (await this.pool.query(
      `SELECT s.tenant_id, c.business_name, s.status, s.plan_revision_id, r.version AS revision_version, s.updated_at
         FROM subscription s JOIN client c ON c.client_id = s.tenant_id JOIN plan_revision r ON r.revision_id = s.plan_revision_id
        WHERE s.plan_id = $1 ORDER BY c.business_name LIMIT 500`, [planId])).rows : [];
    const events = (await this.pool.query(
      `SELECT event_id, at, actor_id, action, revision_id, reason, diff FROM plan_catalog_event WHERE plan_id = $1 ORDER BY at DESC LIMIT 100`, [planId])).rows;
    return {
      plan, revisions: withValues, subscriptions, subscriptions_by_revision: await this.subscriptionsByRevision(planId),
      events, commercial_approval: 'not_approved',
    };
  }

  /** Validación, diff contra la publicada vigente e impacto, para el paso «Revisar y publicar». */
  async review(revisionId: string): Promise<unknown> {
    const rev = (await this.pool.query<RevisionRow>('SELECT * FROM plan_revision WHERE revision_id = $1', [revisionId])).rows[0];
    if (!rev) throw new AppError(404, DENY_CODES.NOT_FOUND, 'No existe esa revisión.');
    const published = (await this.pool.query<RevisionRow>(`SELECT * FROM plan_revision WHERE plan_id = $1 AND status = 'PUBLISHED'`, [rev.plan_id])).rows[0] ?? null;
    const rows = new Map((await this.valueRows(this.pool, revisionId)).map((v) => [v.parameter_key, v]));
    const hasBase = Boolean(published && published.revision_id !== revisionId);
    const base = hasBase ? await revisionValues(this.pool, (published as RevisionRow).revision_id) : new Map<string, ParameterValue>();
    const items: ReviewItem[] = this.parameters().map((def) => {
      const row = rows.get(def.key);
      const value = row?.value ?? null;
      const problem = value === null ? 'Falta el valor.' : (validateValue(def, value) ?? (row?.confirmed_at ? null : 'Falta confirmar este valor.'));
      const baseValue = base.get(def.key) ?? null;
      return { key: def.key, label: def.label, unit: def.unit, period: def.period_label, value, base_value: baseValue, changed: hasBase ? baseValue !== value : rev.status === 'DRAFT', confirmed: Boolean(row?.confirmed_at), source: row?.source ?? null, problem };
    });
    const current = new Map<string, ParameterValue>();
    for (const [k, v] of rows) if (v.value !== null) current.set(k, v.value);
    const subs = await this.subscriptionsByRevision(rev.plan_id);
    return {
      revision: rev,
      published_revision: published,
      items,
      ready: rev.status === 'DRAFT' && items.every((i) => i.problem === null),
      diff: hasBase ? diffValues(base, current, this.definitions) : [],
      checksum_preview: items.every((i) => i.value !== null) ? revisionChecksum(current) : null,
      impact: {
        subscriptions_by_revision: subs,
        note: 'Las suscripciones vigentes siguen fijadas a su revisión: publicar no cambia sus límites. Migrarlas es una acción aparte de MainSpot Administration con vista previa.',
      },
      commercial_approval: 'not_approved',
    };
  }

  // ------------------------------------------------------------------ escritura

  private async lockPlan(client: PoolClient, planId: string): Promise<{ plan_id: string; name: string; active: boolean }> {
    const plan = (await client.query<{ plan_id: string; name: string; active: boolean }>('SELECT plan_id, name, active FROM plan WHERE plan_id = $1 FOR UPDATE', [planId])).rows[0];
    if (!plan) throw new AppError(404, DENY_CODES.NOT_FOUND, 'No existe ese plan.');
    return plan;
  }

  private async lockDraft(client: PoolClient, revisionId: string, lockVersion: unknown): Promise<RevisionRow> {
    const found = (await client.query<{ plan_id: string }>('SELECT plan_id FROM plan_revision WHERE revision_id = $1', [revisionId])).rows[0];
    if (!found) throw new AppError(404, DENY_CODES.NOT_FOUND, 'No existe esa revisión.');
    await this.lockPlan(client, found.plan_id);
    const rev = (await client.query<RevisionRow>('SELECT * FROM plan_revision WHERE revision_id = $1 FOR UPDATE', [revisionId])).rows[0] as RevisionRow;
    if (rev.status !== 'DRAFT') throw new AppError(409, 'validation_error', `Esta revisión está ${rev.status === 'DISCARDED' ? 'descartada' : 'publicada'} y ya no se puede cambiar. Crea una revisión nueva.`);
    if (typeof lockVersion !== 'number' || !Number.isInteger(lockVersion)) throw new AppError(400, 'validation_error', 'Falta la versión del borrador (lock_version) que estabas editando.');
    if (lockVersion !== rev.lock_version) throw conflict();
    return rev;
  }

  private async event(client: PoolClient, actor: PlatformActor, action: string, planId: string, revisionId: string | null, reason: string, diff: unknown, result: string): Promise<void> {
    await client.query(
      `INSERT INTO plan_catalog_event (event_id, actor_id, actor_roles, action, plan_id, revision_id, reason, diff, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [`pce_${randomUUID()}`, actorRef(actor), actor.roles, action, planId, revisionId, reason, JSON.stringify(diff), actor.requestId]);
    await writePlatformAudit(client, {
      actorId: actor.platformUserId, actorRoles: actor.roles, action, resource: revisionId ? `plan_revision/${revisionId}` : `plan/${planId}`,
      decision: 'allow', result, reason, requestId: actor.requestId,
    });
  }

  private async nextVersion(client: PoolClient, planId: string): Promise<number> {
    return Number((await client.query<{ v: number }>('SELECT COALESCE(max(version), 0)::int + 1 AS v FROM plan_revision WHERE plan_id = $1', [planId])).rows[0]?.v ?? 1);
  }

  private async insertRevision(client: PoolClient, input: { planId: string; version: number; origin: RevisionRow['origin']; basedOn: string | null; reason: string; actor: PlatformActor }): Promise<string> {
    const revisionId = `prv_${randomUUID()}`;
    await client.query(
      `INSERT INTO plan_revision (revision_id, plan_id, version, status, origin, based_on_revision_id, registry_version, reason, created_by)
       VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8)`,
      [revisionId, input.planId, input.version, input.origin, input.basedOn, PLAN_REGISTRY_VERSION, input.reason, actorRef(input.actor)]);
    return revisionId;
  }

  /** Valores iniciales de un borrador, todos SIN confirmar (sugeridos o copiados de una revisión). */
  private async seedValues(client: PoolClient, revisionId: string, from: ReadonlyMap<string, ParameterValue> | null, actor: PlatformActor): Promise<void> {
    for (const def of this.definitions) {
      const copied = from?.get(def.key);
      const value = copied !== undefined ? copied : def.suggested;
      const source = copied !== undefined ? 'copied' : 'suggested';
      await client.query(
        `INSERT INTO plan_parameter_value (revision_id, parameter_key, value_int, value_bool, source, updated_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [revisionId, def.key, typeof value === 'number' ? value : null, typeof value === 'boolean' ? value : null, source, actorRef(actor)]);
    }
  }

  /** Crea un plan DESHABILITADO con borrador v1: sugeridos del registro o copia (sin confirmar) de otro plan. */
  async createPlan(input: { name: unknown; description?: unknown; cloneFromPlanId?: unknown; reason: unknown; actor: PlatformActor }): Promise<{ plan_id: string; revision_id: string }> {
    const name = cleanName(input.name);
    const description = cleanDescription(input.description);
    const reason = assertPlatformReason(input.reason);
    const cloneFrom = typeof input.cloneFromPlanId === 'string' && input.cloneFromPlanId ? input.cloneFromPlanId : null;
    return runAtomic(this.pool, async (client) => {
      await this.assertWritable(client);
      if ((await client.query('SELECT 1 FROM plan WHERE lower(name) = lower($1)', [name])).rowCount) {
        throw new AppError(409, 'validation_error', 'Ya existe un plan con ese nombre.');
      }
      let source: Map<string, ParameterValue> | null = null;
      let basedOn: string | null = null;
      if (cloneFrom) {
        // Candado del plan de origen en su propia sentencia (publicar lo toma FOR UPDATE): si se publica a la vez,
        // se espera y se copia la revisión que quedó publicada, leída después con instantánea nueva.
        await client.query('SELECT 1 FROM plan WHERE plan_id = $1 FOR SHARE', [cloneFrom]);
        const pub = (await client.query<{ revision_id: string }>(`SELECT revision_id FROM plan_revision WHERE plan_id = $1 AND status = 'PUBLISHED'`, [cloneFrom])).rows[0];
        if (!pub) throw new AppError(409, 'validation_error', 'El plan de origen no tiene una revisión publicada que copiar.');
        source = await revisionValues(client, pub.revision_id);
        basedOn = pub.revision_id;
      }
      const planId = planIdFor(name);
      await client.query(
        `INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active, created_by) VALUES ($1,$2,$3,NULL,NULL,false,false,$4)`,
        [planId, name, description, actorRef(input.actor)]).catch(duplicateName);
      const revisionId = await this.insertRevision(client, { planId, version: 1, origin: cloneFrom ? 'clone' : 'create', basedOn, reason, actor: input.actor });
      await this.seedValues(client, revisionId, source, input.actor);
      const seeded = new Map((await this.valueRows(client, revisionId)).map((v) => [v.parameter_key, v.value]));
      await this.event(client, input.actor, cloneFrom ? 'plans.plan.clone' : 'plans.plan.create', planId, revisionId, reason,
        { name, clone_from: cloneFrom, values: diffValues(new Map(), seeded, this.definitions), confirmed: 0 }, `draft:v1 unconfirmed:${this.definitions.length}`);
      return { plan_id: planId, revision_id: revisionId };
    });
  }

  /** Nombre y descripción del plan (no versionados; auditados con diff). */
  async updatePlanMeta(input: { planId: string; name?: unknown; description?: unknown; reason: unknown; actor: PlatformActor }): Promise<void> {
    const reason = assertPlatformReason(input.reason);
    await runAtomic(this.pool, async (client) => {
      await this.assertWritable(client);
      const plan = await this.lockPlan(client, input.planId);
      const before = (await client.query<{ name: string; description: string | null }>('SELECT name, description FROM plan WHERE plan_id = $1', [input.planId])).rows[0];
      const name = input.name === undefined ? plan.name : cleanName(input.name);
      const description = input.description === undefined ? before?.description ?? null : cleanDescription(input.description);
      if (name.toLowerCase() !== plan.name.toLowerCase() && (await client.query('SELECT 1 FROM plan WHERE lower(name) = lower($1) AND plan_id <> $2', [name, input.planId])).rowCount) {
        throw new AppError(409, 'validation_error', 'Ya existe un plan con ese nombre.');
      }
      await client.query('UPDATE plan SET name = $2, description = $3, updated_at = now() WHERE plan_id = $1', [input.planId, name, description]).catch(duplicateName);
      await this.event(client, input.actor, 'plans.plan.update', input.planId, null, reason,
        { name: { from: before?.name, to: name }, description: { from: before?.description ?? null, to: description } }, 'meta');
    });
  }

  /** Borrador nuevo desde la revisión publicada vigente (copia SIN confirmar). Uno por plan. */
  async createDraft(input: { planId: string; reason: unknown; actor: PlatformActor }): Promise<{ revision_id: string; version: number }> {
    const reason = assertPlatformReason(input.reason);
    return runAtomic(this.pool, async (client) => {
      await this.assertWritable(client);
      await this.lockPlan(client, input.planId);
      if ((await client.query(`SELECT 1 FROM plan_revision WHERE plan_id = $1 AND status = 'DRAFT'`, [input.planId])).rowCount) {
        throw new AppError(409, 'validation_error', 'Este plan ya tiene un borrador abierto. Termínalo o descártalo antes de crear otro.');
      }
      const pub = (await client.query<{ revision_id: string }>(`SELECT revision_id FROM plan_revision WHERE plan_id = $1 AND status = 'PUBLISHED'`, [input.planId])).rows[0];
      if (!pub) throw new AppError(409, 'validation_error', 'Este plan no tiene una revisión publicada de la que partir.');
      const version = await this.nextVersion(client, input.planId);
      const revisionId = await this.insertRevision(client, { planId: input.planId, version, origin: 'edit', basedOn: pub.revision_id, reason, actor: input.actor });
      await this.seedValues(client, revisionId, await revisionValues(client, pub.revision_id), input.actor);
      await this.event(client, input.actor, 'plans.revision.draft', input.planId, revisionId, reason, { based_on: pub.revision_id }, `draft:v${version}`);
      return { revision_id: revisionId, version };
    });
  }

  /** Cambia valores y confirmaciones de un borrador (control de concurrencia por lock_version). */
  async updateDraft(input: { revisionId: string; lockVersion: unknown; values: unknown; reason: unknown; actor: PlatformActor }): Promise<{ lock_version: number; diff: unknown }> {
    const reason = assertPlatformReason(input.reason);
    if (!Array.isArray(input.values) || input.values.length === 0 || input.values.length > this.definitions.length) {
      throw new AppError(400, 'validation_error', 'Indica los valores a cambiar.');
    }
    const items = input.values as DraftValueInput[];
    const seen = new Set<string>();
    for (const item of items) {
      const def = typeof item?.key === 'string' ? definitionByKey(item.key, this.definitions) : null;
      if (!def) throw new AppError(400, 'validation_error', 'Hay un parámetro que no existe en el registro de planes.');
      if (seen.has(def.key)) throw new AppError(400, 'validation_error', `«${def.label}» aparece dos veces.`);
      seen.add(def.key);
      if ('value' in item && item.value !== null) {
        const problem = validateValue(def, item.value);
        if (problem) throw new AppError(400, 'validation_error', problem);
      }
      if ('confirmed' in item && typeof item.confirmed !== 'boolean') throw new AppError(400, 'validation_error', 'La confirmación debe ser sí o no.');
    }
    return runAtomic(this.pool, async (client) => {
      await this.assertWritable(client);
      const rev = await this.lockDraft(client, input.revisionId, input.lockVersion);
      const before = new Map((await this.valueRows(client, rev.revision_id)).map((v) => [v.parameter_key, v]));
      const changes: Array<{ key: string; label: string; from: ParameterValue | null; to: ParameterValue | null; confirmed_from: boolean; confirmed_to: boolean }> = [];
      for (const item of items) {
        const def = definitionByKey(item.key, this.definitions) as PlanParameterDefinition;
        const prev = before.get(def.key);
        const nextValue = 'value' in item ? (item.value ?? null) : (prev?.value ?? null);
        const valueChanged = nextValue !== (prev?.value ?? null);
        const wasConfirmed = Boolean(prev?.confirmed_at);
        const confirm = 'confirmed' in item ? item.confirmed === true : (wasConfirmed && !valueChanged);
        if (confirm && nextValue === null) throw new AppError(400, 'validation_error', `No se puede confirmar «${def.label}» sin valor.`);
        const valueInt = typeof nextValue === 'number' ? nextValue : null;
        const valueBool = typeof nextValue === 'boolean' ? nextValue : null;
        if (prev) {
          await client.query(
            `UPDATE plan_parameter_value
                SET value_int = $3, value_bool = $4,
                    source = CASE WHEN $5::boolean THEN 'explicit' ELSE source END,
                    confirmed_by = CASE WHEN $6::boolean THEN (CASE WHEN $8::boolean THEN confirmed_by ELSE $7 END) ELSE NULL END,
                    confirmed_at = CASE WHEN $6::boolean THEN (CASE WHEN $8::boolean THEN confirmed_at ELSE clock_timestamp() END) ELSE NULL END,
                    updated_by = $7, updated_at = clock_timestamp()
              WHERE revision_id = $1 AND parameter_key = $2`,
            [rev.revision_id, def.key, valueInt, valueBool, valueChanged, confirm, actorRef(input.actor), confirm && wasConfirmed && !valueChanged && !('confirmed' in item)]);
        } else if (nextValue !== null) {
          // Borrador sin la fila de este parámetro (creado por SQL o con un registro anterior): se inserta; el
          // diff nunca lista un cambio que no quedó guardado.
          await client.query(
            `INSERT INTO plan_parameter_value (revision_id, parameter_key, value_int, value_bool, source, confirmed_by, confirmed_at, updated_by)
             VALUES ($1, $2, $3, $4, 'explicit', CASE WHEN $5::boolean THEN $6 END, CASE WHEN $5::boolean THEN clock_timestamp() END, $6)`,
            [rev.revision_id, def.key, valueInt, valueBool, confirm, actorRef(input.actor)]);
        }
        if (valueChanged || confirm !== wasConfirmed) changes.push({ key: def.key, label: def.label, from: prev?.value ?? null, to: nextValue, confirmed_from: wasConfirmed, confirmed_to: confirm });
      }
      const lockVersion = rev.lock_version + 1;
      await client.query('UPDATE plan_revision SET lock_version = $2, updated_at = now() WHERE revision_id = $1', [rev.revision_id, lockVersion]);
      await this.event(client, input.actor, 'plans.revision.update', rev.plan_id, rev.revision_id, reason, changes, `changes:${changes.length}`);
      return { lock_version: lockVersion, diff: changes };
    });
  }

  /** Publica un borrador completo y confirmado; la publicada anterior pasa a SUPERSEDED. */
  async publish(input: { revisionId: string; lockVersion: unknown; reason: unknown; actor: PlatformActor }): Promise<{ revision_id: string; version: number; checksum: string; diff: DiffEntry[] }> {
    const reason = assertPlatformReason(input.reason);
    return runAtomic(this.pool, async (client) => {
      await this.assertWritable(client);
      const rev = await this.lockDraft(client, input.revisionId, input.lockVersion);
      const rows = new Map((await this.valueRows(client, rev.revision_id)).map((v) => [v.parameter_key, v]));
      const problems: string[] = [];
      const values = new Map<string, ParameterValue>();
      for (const def of this.definitions) {
        const row = rows.get(def.key);
        if (!row || row.value === null) { problems.push(`«${def.label}»: falta el valor`); continue; }
        const invalid = validateValue(def, row.value);
        if (invalid) problems.push(invalid);
        else if (!row.confirmed_at) problems.push(`«${def.label}»: falta confirmarlo`);
        values.set(def.key, row.value);
      }
      if (problems.length) throw new AppError(409, 'validation_error', `No se puede publicar todavía: ${problems.join('; ')}.`);
      const previous = (await client.query<{ revision_id: string }>(`SELECT revision_id FROM plan_revision WHERE plan_id = $1 AND status = 'PUBLISHED' FOR UPDATE`, [rev.plan_id])).rows[0];
      const before = previous ? await revisionValues(client, previous.revision_id) : new Map<string, ParameterValue>();
      if (previous) {
        await client.query(`UPDATE plan_revision SET status = 'SUPERSEDED', superseded_at = now() WHERE revision_id = $1`, [previous.revision_id]);
      }
      const checksum = revisionChecksum(values);
      await client.query(
        `UPDATE plan_revision SET status = 'PUBLISHED', published_by = $2, published_at = now(), publish_reason = $3, checksum = $4 WHERE revision_id = $1`,
        [rev.revision_id, actorRef(input.actor), reason, checksum]);
      await client.query('UPDATE plan SET updated_at = now() WHERE plan_id = $1', [rev.plan_id]);
      const diff = diffValues(before, values, this.definitions);
      await this.event(client, input.actor, 'plans.revision.publish', rev.plan_id, rev.revision_id, reason,
        { superseded: previous?.revision_id ?? null, changes: diff, checksum }, `v${rev.version} checksum:${checksum.slice(0, 12)}`);
      return { revision_id: rev.revision_id, version: rev.version, checksum, diff };
    });
  }

  /**
   * Descarta un borrador. El de un plan que nunca se publicó no se descarta: el plan quedaría sin borrador ni
   * revisión publicada (no se podría abrir otro borrador, publicar ni habilitar) y con su nombre ocupado.
   */
  async discard(input: { revisionId: string; lockVersion: unknown; reason: unknown; actor: PlatformActor }): Promise<void> {
    const reason = assertPlatformReason(input.reason);
    await runAtomic(this.pool, async (client) => {
      await this.assertWritable(client);
      const rev = await this.lockDraft(client, input.revisionId, input.lockVersion);
      if (!(await client.query(`SELECT 1 FROM plan_revision WHERE plan_id = $1 AND status = 'PUBLISHED'`, [rev.plan_id])).rowCount) {
        throw new AppError(409, 'validation_error', 'Este plan todavía no tiene una revisión publicada: corrige los valores de este borrador en lugar de descartarlo.');
      }
      await client.query(`UPDATE plan_revision SET status = 'DISCARDED', discarded_at = now(), updated_at = now() WHERE revision_id = $1`, [rev.revision_id]);
      await this.event(client, input.actor, 'plans.revision.discard', rev.plan_id, rev.revision_id, reason, {}, `discarded:v${rev.version}`);
    });
  }

  /**
   * Rollback: revisión nueva publicada con los valores de una revisión anterior del mismo plan. El
   * operador confirma ese conjunto explícitamente con esta acción (step-up + motivo); el historial
   * conserva todas las revisiones. Requiere que no haya borrador abierto.
   */
  async rollback(input: { planId: string; toRevisionId: unknown; reason: unknown; actor: PlatformActor }): Promise<{ revision_id: string; version: number; checksum: string; diff: DiffEntry[] }> {
    const reason = assertPlatformReason(input.reason);
    return runAtomic(this.pool, async (client) => {
      await this.assertWritable(client);
      await this.lockPlan(client, input.planId);
      const target = (await client.query<RevisionRow>('SELECT * FROM plan_revision WHERE revision_id = $1 AND plan_id = $2', [String(input.toRevisionId ?? ''), input.planId])).rows[0];
      if (!target || target.status !== 'SUPERSEDED') throw new AppError(409, 'validation_error', 'Solo se puede volver a una revisión publicada anteriormente (reemplazada) de este plan.');
      if ((await client.query(`SELECT 1 FROM plan_revision WHERE plan_id = $1 AND status = 'DRAFT'`, [input.planId])).rowCount) {
        throw new AppError(409, 'validation_error', 'Este plan tiene un borrador abierto. Descártalo o publícalo antes de revertir.');
      }
      const values = await revisionValues(client, target.revision_id);
      for (const def of this.definitions) {
        const v = values.get(def.key);
        if (v === undefined || validateValue(def, v)) throw new AppError(409, 'validation_error', `La revisión v${target.version} no tiene un valor válido para «${def.label}» con el registro actual; crea un borrador y corrígelo.`);
      }
      const current = (await client.query<{ revision_id: string }>(`SELECT revision_id FROM plan_revision WHERE plan_id = $1 AND status = 'PUBLISHED' FOR UPDATE`, [input.planId])).rows[0];
      const before = current ? await revisionValues(client, current.revision_id) : new Map<string, ParameterValue>();
      const version = await this.nextVersion(client, input.planId);
      const revisionId = await this.insertRevision(client, { planId: input.planId, version, origin: 'rollback', basedOn: target.revision_id, reason, actor: input.actor });
      for (const def of this.definitions) {
        const v = values.get(def.key) as ParameterValue;
        await client.query(
          `INSERT INTO plan_parameter_value (revision_id, parameter_key, value_int, value_bool, source, confirmed_by, confirmed_at, updated_by)
           VALUES ($1,$2,$3,$4,'rollback',$5,clock_timestamp(),$5)`,
          [revisionId, def.key, typeof v === 'number' ? v : null, typeof v === 'boolean' ? v : null, actorRef(input.actor)]);
      }
      if (current) await client.query(`UPDATE plan_revision SET status = 'SUPERSEDED', superseded_at = now() WHERE revision_id = $1`, [current.revision_id]);
      const checksum = revisionChecksum(values);
      await client.query(
        `UPDATE plan_revision SET status = 'PUBLISHED', published_by = $2, published_at = now(), publish_reason = $3, checksum = $4 WHERE revision_id = $1`,
        [revisionId, actorRef(input.actor), reason, checksum]);
      await client.query('UPDATE plan SET updated_at = now() WHERE plan_id = $1', [input.planId]);
      const diff = diffValues(before, values, this.definitions);
      await this.event(client, input.actor, 'plans.revision.rollback', input.planId, revisionId, reason,
        { restored_from: target.revision_id, superseded: current?.revision_id ?? null, changes: diff, checksum }, `v${version} from:v${target.version}`);
      return { revision_id: revisionId, version, checksum, diff };
    });
  }

  /** Habilitar (asignable) o deshabilitar (no asignable; las suscripciones vigentes no cambian). */
  async setEnabled(input: { planId: string; enabled: unknown; reason: unknown; actor: PlatformActor }): Promise<{ active: boolean }> {
    const reason = assertPlatformReason(input.reason);
    if (typeof input.enabled !== 'boolean') throw new AppError(400, 'validation_error', 'Indica si el plan queda habilitado (sí o no).');
    const enabled = input.enabled;
    return runAtomic(this.pool, async (client) => {
      await this.assertWritable(client);
      const plan = await this.lockPlan(client, input.planId);
      if (enabled && !(await client.query(`SELECT 1 FROM plan_revision WHERE plan_id = $1 AND status = 'PUBLISHED'`, [input.planId])).rowCount) {
        throw new AppError(409, 'validation_error', 'Publica una revisión antes de habilitar el plan.');
      }
      const action = enabled ? 'plans.plan.enable' : 'plans.plan.disable';
      if (plan.active !== enabled) {
        await client.query('UPDATE plan SET active = $2, updated_at = now() WHERE plan_id = $1', [input.planId, enabled]);
        await this.event(client, input.actor, action, input.planId, null, reason, { active: { from: plan.active, to: enabled } }, enabled ? 'enabled' : 'disabled');
      } else {
        // Permitida pero sin cambio: queda en la auditoría de plataforma (el historial del plan no cambia).
        await writePlatformAudit(client, {
          actorId: input.actor.platformUserId, actorRoles: input.actor.roles, action, resource: `plan/${input.planId}`,
          decision: 'allow', result: 'noop', reason, requestId: input.actor.requestId,
        });
      }
      return { active: enabled };
    });
  }
}
