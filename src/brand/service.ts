/**
 * Brand Studio y Base de Hechos Verificados (FR-0013).
 *
 * - Cada cambio es una fila nueva de `brand_fact` (append-only) con origen, estado y confianza;
 *   el lote de cambios incrementa `brand_profile.brand_version`.
 * - `confirmed` solo lo fija una persona con `brand.manage`; lo sugerido por IA nace `unconfirmed`.
 * - La IA recibe únicamente las claves que necesita (recuperación mínima) y los no confirmados
 *   van aparte, marcados solo como inspiración de tono.
 * - Un borrador es «desactualizado» si alguna clave que usó cambió después de su versión: se
 *   calcula al leer, nunca se reescribe nada aprobado.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { AppError } from '../shared/errors.ts';

export const FACT_KEYS = [
  'name', 'category', 'description', 'value_proposition', 'voice', 'audience', 'language', 'avoid_tones',
  'palette', 'fonts', 'services', 'locations', 'address', 'hours', 'channels', 'cta', 'prices', 'promotions', 'restrictions',
] as const;
export type FactKey = (typeof FACT_KEYS)[number];

export const FACT_LABELS: Record<FactKey, string> = {
  name: 'Nombre del negocio', category: 'Giro', description: 'Descripción', value_proposition: 'Lo que te hace diferente',
  voice: 'Cómo hablas con tus clientes', audience: 'A quién atiendes', language: 'Idioma', avoid_tones: 'Lo que nunca dirías',
  palette: 'Colores de tu marca', fonts: 'Tipografías', services: 'Lo que vendes', locations: 'Sucursales', address: 'Dirección',
  hours: 'Horario', channels: 'Canales', cta: 'Llamada a la acción preferida', prices: 'Precios confirmados',
  promotions: 'Promociones vigentes', restrictions: 'Restricciones',
};

export interface FactRow {
  fact_id: string; tenant_id: string; fact_key: FactKey; value: unknown; source: 'owner' | 'import' | 'ai_suggested' | 'system';
  status: 'confirmed' | 'unconfirmed' | 'rejected'; confidence: string | null; valid_from: string | null; valid_until: string | null;
  brand_version: number; created_by: string; created_at: string;
}

export interface Promotion { text: string; valid_from: string | null; valid_until: string | null }
export interface PriceFact { item: string; price: string }

const HEX = /^#[0-9a-fA-F]{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown, max: number, label: string): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new AppError(400, 'validation_error', `${label}: escribe de 1 a ${max} caracteres.`);
  return v.trim();
}
function list(v: unknown, maxItems: number, maxLen: number, label: string): string[] {
  if (!Array.isArray(v) || v.length > maxItems) throw new AppError(400, 'validation_error', `${label}: hasta ${maxItems} elementos.`);
  return v.map((x) => str(x, maxLen, label));
}

/** Normaliza y valida el valor de cada clave (fail-closed ante formas desconocidas). */
export function normalizeFact(key: FactKey, value: unknown): unknown {
  const label = FACT_LABELS[key];
  switch (key) {
    case 'name': return str(value, 120, label);
    case 'category': return str(value, 80, label);
    case 'description': return str(value, 700, label);
    case 'value_proposition': return str(value, 240, label);
    case 'voice': return str(value, 200, label);
    case 'audience': return str(value, 240, label);
    case 'language': return str(value, 40, label);
    case 'avoid_tones': return str(value, 240, label);
    case 'cta': return str(value, 60, label);
    case 'restrictions': return str(value, 400, label);
    case 'address': return str(value, 200, label);
    case 'hours': return str(value, 240, label);
    case 'palette': {
      const colors = list(value, 6, 7, label);
      if (colors.some((c) => !HEX.test(c))) throw new AppError(400, 'validation_error', 'Colores: usa el formato #RRGGBB.');
      return colors;
    }
    case 'fonts': return list(value, 3, 40, label);
    case 'services': return list(value, 20, 80, label);
    case 'locations': return list(value, 10, 200, label);
    case 'channels': return list(value, 8, 60, label);
    case 'prices': {
      if (!Array.isArray(value) || value.length > 30) throw new AppError(400, 'validation_error', 'Precios: hasta 30.');
      return value.map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        return { item: str(o['item'], 80, 'Producto'), price: str(o['price'], 40, 'Precio') } satisfies PriceFact;
      });
    }
    case 'promotions': {
      if (!Array.isArray(value) || value.length > 10) throw new AppError(400, 'validation_error', 'Promociones: hasta 10.');
      return value.map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        const from = o['valid_from'] == null || o['valid_from'] === '' ? null : String(o['valid_from']);
        const until = o['valid_until'] == null || o['valid_until'] === '' ? null : String(o['valid_until']);
        if ((from && !DATE.test(from)) || (until && !DATE.test(until))) throw new AppError(400, 'validation_error', 'Promociones: fechas AAAA-MM-DD.');
        if (!until) throw new AppError(400, 'validation_error', 'Cada promoción necesita fecha de fin (vigencia).');
        return { text: str(o['text'], 160, 'Promoción'), valid_from: from, valid_until: until } satisfies Promotion;
      });
    }
  }
}

export interface Actor { tenantId: string; userId: string; role: string | null; requestId: string }

type Db = Pool | PoolClient;

export class BrandService {
  private readonly pool: Pool;
  private readonly sink: AuditSink;

  constructor(deps: { pool: Pool; sink: AuditSink }) {
    this.pool = deps.pool;
    this.sink = deps.sink;
  }

  async version(tenantId: string, db: Db = this.pool): Promise<number> {
    const r = await db.query<{ brand_version: number }>('SELECT brand_version FROM brand_profile WHERE tenant_id = $1', [tenantId]);
    return r.rows[0]?.brand_version ?? 0;
  }

  /** Último valor (no rechazado) de cada clave. */
  async current(tenantId: string, db: Db = this.pool): Promise<{ version: number; facts: Partial<Record<FactKey, FactRow>> }> {
    const r = await db.query<FactRow>(
      `SELECT DISTINCT ON (fact_key) * FROM brand_fact WHERE tenant_id = $1
        ORDER BY fact_key, brand_version DESC, created_at DESC`, [tenantId]);
    const facts: Partial<Record<FactKey, FactRow>> = {};
    for (const row of r.rows) if (row.status !== 'rejected') facts[row.fact_key] = row;
    return { version: await this.version(tenantId, db), facts };
  }

  /**
   * Cambios del dueño (confirmados) o sugerencias (unconfirmed). Un lote = una versión.
   * `status: 'rejected'` descarta una sugerencia sin borrar historial.
   */
  async update(actor: Actor, changes: Array<{ key: unknown; value?: unknown; status?: unknown }>, opts: { source?: FactRow['source']; db?: PoolClient } = {}): Promise<{ version: number; changed: FactKey[] }> {
    if (!Array.isArray(changes) || !changes.length || changes.length > FACT_KEYS.length) throw new AppError(400, 'validation_error', 'Indica qué datos de tu marca cambian.');
    const source = opts.source ?? 'owner';
    const prepared = changes.map((c) => {
      const key = c.key as FactKey;
      if (!FACT_KEYS.includes(key)) throw new AppError(400, 'validation_error', 'Ese dato de marca no existe.');
      const status = (c.status ?? (source === 'ai_suggested' ? 'unconfirmed' : 'confirmed')) as FactRow['status'];
      if (!['confirmed', 'unconfirmed', 'rejected'].includes(status)) throw new AppError(400, 'validation_error', 'Estado inválido.');
      // Solo una persona confirma: lo sugerido por IA nunca entra como confirmado (NFR-0007).
      if (source === 'ai_suggested' && status === 'confirmed') throw new AppError(400, 'validation_error', 'Una sugerencia no puede confirmarse sola.');
      const value = status === 'rejected' ? (c.value ?? null) : normalizeFact(key, c.value);
      return { key, value, status };
    });
    const exec = async (client: PoolClient) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`brand:${actor.tenantId}`]);
      const v = await client.query<{ brand_version: number }>(
        `INSERT INTO brand_profile (tenant_id, brand_version) VALUES ($1, 1)
         ON CONFLICT (tenant_id) DO UPDATE SET brand_version = brand_profile.brand_version + 1, updated_at = now()
         RETURNING brand_version`, [actor.tenantId]);
      const version = v.rows[0]?.brand_version ?? 1;
      for (const p of prepared) {
        const promos = p.key === 'promotions' && Array.isArray(p.value) ? (p.value as Promotion[]) : [];
        await client.query(
          `INSERT INTO brand_fact (fact_id, tenant_id, fact_key, value, source, status, confidence, valid_from, valid_until, brand_version, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [`bf_${randomUUID()}`, actor.tenantId, p.key, JSON.stringify(p.value), source, p.status,
            p.status === 'confirmed' ? 1 : 0.5,
            promos.length ? promos.map((x) => x.valid_from).filter(Boolean).sort()[0] ?? null : null,
            promos.length ? promos.map((x) => x.valid_until).filter(Boolean).sort().reverse()[0] ?? null : null,
            version, actor.userId]);
      }
      await this.sink.write({
        tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role, action: 'brand.facts.updated',
        resource: `brand_profile/v${version}`, request_id: actor.requestId, decision: 'allow',
        result: `${source}:${prepared.map((p) => `${p.key}=${p.status}`).join(',')}`.slice(0, 200),
      }, client);
      return { version, changed: prepared.map((p) => p.key) };
    };
    return opts.db ? exec(opts.db) : runAtomic(this.pool, exec);
  }

  /** Hechos confirmados (solo las claves pedidas) en forma simple para prompts y renders. */
  async confirmed(tenantId: string, keys: readonly FactKey[] = FACT_KEYS, today = new Date()): Promise<{ version: number; facts: Partial<Record<FactKey, unknown>> }> {
    const cur = await this.current(tenantId);
    const out: Partial<Record<FactKey, unknown>> = {};
    for (const k of keys) {
      const f = cur.facts[k];
      if (!f || f.status !== 'confirmed') continue;
      out[k] = k === 'promotions' ? activePromotions(f.value as Promotion[], today) : f.value;
    }
    return { version: cur.version, facts: out };
  }

  /** No confirmados: solo para tono; nunca como dato. */
  async unconfirmed(tenantId: string): Promise<Partial<Record<FactKey, unknown>>> {
    const cur = await this.current(tenantId);
    const out: Partial<Record<FactKey, unknown>> = {};
    for (const [k, f] of Object.entries(cur.facts) as Array<[FactKey, FactRow]>) if (f.status === 'unconfirmed') out[k] = f.value;
    return out;
  }

  /** ¿Cambió alguna de estas claves después de `version`? (borrador desactualizado) */
  async changedSince(tenantId: string, version: number | null, keys: readonly FactKey[] = FACT_KEYS): Promise<FactKey[]> {
    if (version === null) return [];
    const r = await this.pool.query<{ fact_key: FactKey }>(
      'SELECT DISTINCT fact_key FROM brand_fact WHERE tenant_id = $1 AND brand_version > $2 AND fact_key = ANY($3::text[])', [tenantId, version, keys]);
    return r.rows.map((x) => x.fact_key);
  }

  /** Cadenas de precio/promoción confirmadas que pueden citarse literalmente. */
  async allowedPriceStrings(tenantId: string): Promise<string[]> {
    const c = await this.confirmed(tenantId, ['prices', 'promotions']);
    const prices = ((c.facts.prices as PriceFact[] | undefined) ?? []).flatMap((p) => [p.price, `${p.item} ${p.price}`]);
    const promos = ((c.facts.promotions as Promotion[] | undefined) ?? []).map((p) => p.text);
    return [...prices, ...promos];
  }

  /**
   * Importa como confirmados los datos que el dueño escribió al crear su página (dato propio, no
   * inferido). Solo llena claves vacías: nunca pisa la marca.
   */
  async importFromWebsite(actor: Actor, data: { name?: string; line?: string; about?: string; address?: string; hours?: string; services?: string[]; email?: string }): Promise<number | null> {
    const cur = await this.current(actor.tenantId);
    const changes: Array<{ key: FactKey; value: unknown }> = [];
    const add = (key: FactKey, value: unknown) => {
      if (cur.facts[key] || value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return;
      changes.push({ key, value });
    };
    add('name', data.name);
    add('value_proposition', data.line?.slice(0, 240));
    add('description', data.about?.slice(0, 700));
    add('address', data.address?.slice(0, 200));
    add('hours', data.hours?.slice(0, 240));
    add('services', data.services?.slice(0, 20));
    if (!changes.length) return null;
    return (await this.update(actor, changes, { source: 'import' })).version;
  }
}

export function activePromotions(promos: Promotion[] | undefined, today = new Date()): Promotion[] {
  const d = today.toISOString().slice(0, 10);
  return (promos ?? []).filter((p) => (!p.valid_from || p.valid_from <= d) && (!p.valid_until || p.valid_until >= d));
}
