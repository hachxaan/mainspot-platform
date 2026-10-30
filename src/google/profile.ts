/**
 * Ficha de Google Business Profile / presencia en Maps (DEV-E2E-02 simulación; DEV-E2E-04 modo real).
 *
 * Datos básicos, ubicación y horarios editables por el dueño; el teléfono público de la ficha es
 * el efectivo del canal `google_business_profile` (principal u «Otro número» propio de Google).
 *  - `simulated`: sin llamada a Google; el estado se marca `simulated_*`. Cambiar nombre o
 *    dirección deja la ficha en `simulated_pending_verification`.
 *  - `not_verified`: hay proveedor real configurado pero este negocio no tiene conexión.
 *  - `real` (DEV-E2E-04 §2A): con conexión `connected`, la ficha se lee de Google y cada guardado
 *    aplica los campos soportados con updateMask y confirma con nueva lectura (synced / partial si
 *    algún campo quedó `unsupported` / failed si la lectura no coincide). Nunca `simulated_synced`.
 */

import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import type { ProviderConnectionRepository } from '../connectors/repository.ts';
import type { ContactPhoneService } from '../contact/phones.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { GOOGLE_PROVIDER, GoogleApiError } from './client.ts';
import type { ApplyResult, GoogleLocationService, GoogleLocationView } from './location.ts';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface HoursEntry {
  day: (typeof DAYS)[number];
  open?: string;
  close?: string;
  closed?: boolean;
}

export interface GbpProfileRow {
  tenant_id: string;
  business_name: string;
  primary_category: string;
  description: string | null;
  address_line: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  country_iso2: string | null;
  latitude: string | null;
  longitude: string | null;
  hours: HoursEntry[];
  website_url: string | null;
  sync_mode: 'simulated' | 'not_verified' | 'real';
  sync_status: 'simulated_synced' | 'simulated_pending_verification' | 'not_verified' | 'synced' | 'partial' | 'failed';
  synced_at: string | null;
  updated_by: string;
  updated_at: string;
  /** DEV-E2E-04: recurso de Google del que se leyó (locations/{id}), detalle del último guardado y última lectura. */
  google_location_name: string | null;
  sync_detail: Record<string, unknown>;
  last_read_at: string | null;
}

function str(b: Record<string, unknown>, key: string, max: number, required = false): string | null {
  const v = b[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new AppError(400, 'validation_error', `Completa el campo ${key}.`);
    return null;
  }
  if (typeof v !== 'string' || v.trim().length > max) throw new AppError(400, 'validation_error', `El campo ${key} admite hasta ${max} caracteres.`);
  return v.trim();
}

function coord(b: Record<string, unknown>, key: string, limit: number): number | null {
  const v = b[key];
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw new AppError(400, 'validation_error', `La coordenada ${key} no es válida.`);
  return n;
}

function parseHours(raw: unknown): HoursEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 7) throw new AppError(400, 'validation_error', 'El horario debe tener como máximo un renglón por día.');
  const seen = new Set<string>();
  return raw.map((entry) => {
    const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const day = e['day'];
    if (typeof day !== 'string' || !(DAYS as readonly string[]).includes(day) || seen.has(day)) {
      throw new AppError(400, 'validation_error', 'Cada día del horario debe aparecer una sola vez (mon…sun).');
    }
    seen.add(day);
    if (e['closed'] === true) return { day: day as HoursEntry['day'], closed: true };
    const open = e['open'];
    const close = e['close'];
    if (typeof open !== 'string' || typeof close !== 'string' || !TIME_RE.test(open) || !TIME_RE.test(close) || open >= close) {
      throw new AppError(400, 'validation_error', `Revisa el horario de ${day}: usa HH:MM y que el cierre sea después de la apertura.`);
    }
    return { day: day as HoursEntry['day'], open, close };
  });
}

export type GbpProfileMode = 'simulated' | 'not_verified' | 'real';

export interface GbpProfileViewGoogle {
  /** Estado de la conexión del negocio con Google (vocabulario de provider_connection). */
  connection_status: string;
  location: GoogleLocationView | null;
  /** Código del fallo de lectura en vivo (p. ej. permission_missing:PERMISSION_DENIED). */
  error: string | null;
}

export interface GbpProfileView {
  profile: GbpProfileRow | null;
  phone: { effective_phone: string | null; mode: string; source: string | null };
  /** simulated | not_verified | real (real solo si este negocio está conectado). */
  provider_mode: string;
  google: GbpProfileViewGoogle | null;
}

export class GbpProfileService {
  private readonly pool: Pool;
  private readonly sink: AuditSink;
  private readonly phones: ContactPhoneService;
  private readonly mode: GbpProfileMode;
  private readonly google: GoogleLocationService | null;
  private readonly connections: ProviderConnectionRepository | null;

  constructor(deps: { pool: Pool; sink: AuditSink; phones: ContactPhoneService; mode: GbpProfileMode; google?: GoogleLocationService; connections?: ProviderConnectionRepository }) {
    this.pool = deps.pool;
    this.sink = deps.sink;
    this.phones = deps.phones;
    this.mode = deps.mode;
    this.google = deps.google ?? null;
    this.connections = deps.connections ?? null;
    if (deps.mode === 'real' && (!this.google || !this.connections)) throw new Error('GbpProfileService real mode requires google and connections');
  }

  /** Ubicación de Google del negocio cuando el modo real está activo y la conexión es `connected`. */
  private async realTarget(tenantId: string): Promise<{ locationName: string; status: string } | null> {
    if (this.mode !== 'real' || !this.connections) return null;
    const conn = await this.connections.get(tenantId, GOOGLE_PROVIDER);
    if (!conn) return null;
    return conn.status === 'connected' && conn.external_resource_id ? { locationName: conn.external_resource_id, status: conn.status } : { locationName: '', status: conn.status };
  }

  async view(tenantId: string): Promise<GbpProfileView> {
    const res = await this.pool.query<GbpProfileRow>('SELECT * FROM gbp_profile WHERE tenant_id = $1', [tenantId]);
    const phones = await this.phones.view(tenantId);
    const g = phones.integration_phones.google_business_profile;
    const target = await this.realTarget(tenantId);
    let google: GbpProfileViewGoogle | null = null;
    let providerMode: string = this.mode;
    if (this.mode === 'real') {
      providerMode = target?.locationName ? 'real' : 'not_verified';
      google = { connection_status: target?.status ?? 'disconnected', location: null, error: null };
      if (target?.locationName) {
        try {
          google.location = await this.google!.read(tenantId, target.locationName);
          await this.pool.query('UPDATE gbp_profile SET last_read_at = now(), google_location_name = $2 WHERE tenant_id = $1', [tenantId, target.locationName]);
        } catch (err) {
          if (!(err instanceof GoogleApiError)) throw err;
          google.error = `${err.kind}:${err.reason}`;
        }
      }
    }
    return {
      profile: res.rows[0] ?? null,
      phone: { effective_phone: g.effective_phone, mode: g.mode, source: g.effective_source },
      provider_mode: providerMode,
      google,
    };
  }

  async save(actor: { tenantId: string; userId: string; role: string | null; requestId: string }, body: unknown): Promise<GbpProfileRow> {
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if ('phone' in b || 'primary_phone' in b) {
      throw new AppError(400, 'validation_error', 'El teléfono de la ficha se configura en «Teléfonos» (Usar mi número u Otro número de Google).');
    }
    const country = str(b, 'country_iso2', 2);
    if (country && !/^[A-Z]{2}$/.test(country)) throw new AppError(400, 'validation_error', 'El país debe ser un código de 2 letras.');
    const website = str(b, 'website_url', 300);
    if (website && !/^https?:\/\//.test(website)) throw new AppError(400, 'validation_error', 'La página web debe empezar con http:// o https://.');
    const values = {
      business_name: str(b, 'business_name', 120, true) as string,
      primary_category: str(b, 'primary_category', 80, true) as string,
      description: str(b, 'description', 750),
      address_line: str(b, 'address_line', 200),
      locality: str(b, 'locality', 80),
      region: str(b, 'region', 80),
      postal_code: str(b, 'postal_code', 12),
      country_iso2: country,
      latitude: coord(b, 'latitude', 90),
      longitude: coord(b, 'longitude', 180),
      hours: parseHours(b['hours']),
      website_url: website,
    };
    const prev = await this.pool.query<GbpProfileRow>('SELECT * FROM gbp_profile WHERE tenant_id = $1', [actor.tenantId]);
    const p = prev.rows[0];
    const needsVerification = Boolean(p && (p.business_name !== values.business_name || p.address_line !== values.address_line));
    const target = await this.realTarget(actor.tenantId);
    const real = Boolean(target?.locationName);
    const syncMode: GbpProfileRow['sync_mode'] = this.mode === 'simulated' ? 'simulated' : real ? 'real' : 'not_verified';
    // En modo real el estado definitivo lo fija la lectura posterior a Google (más abajo).
    let status: GbpProfileRow['sync_status'] = syncMode === 'simulated'
      ? (needsVerification ? 'simulated_pending_verification' : 'simulated_synced')
      : syncMode === 'real' ? 'failed' : 'not_verified';
    const res = await this.pool.query<GbpProfileRow>(
      `INSERT INTO gbp_profile (tenant_id, business_name, primary_category, description, address_line, locality, region, postal_code,
         country_iso2, latitude, longitude, hours, website_url, sync_mode, sync_status, synced_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, CASE WHEN $15 = 'simulated_synced' THEN now() ELSE NULL END, $16)
       ON CONFLICT (tenant_id) DO UPDATE SET business_name = EXCLUDED.business_name, primary_category = EXCLUDED.primary_category,
         description = EXCLUDED.description, address_line = EXCLUDED.address_line, locality = EXCLUDED.locality, region = EXCLUDED.region,
         postal_code = EXCLUDED.postal_code, country_iso2 = EXCLUDED.country_iso2, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
         hours = EXCLUDED.hours, website_url = EXCLUDED.website_url, sync_mode = EXCLUDED.sync_mode, sync_status = EXCLUDED.sync_status,
         synced_at = EXCLUDED.synced_at, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`,
      [actor.tenantId, values.business_name, values.primary_category, values.description, values.address_line, values.locality,
        values.region, values.postal_code, values.country_iso2, values.latitude, values.longitude, JSON.stringify(values.hours),
        values.website_url, syncMode, status, actor.userId]);
    let row = res.rows[0] as GbpProfileRow;
    if (real) {
      row = await this.syncToGoogle(actor.tenantId, target!.locationName, values);
      status = row.sync_status;
    }
    await this.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'google.profile.updated', resource: 'gbp_profile', request_id: actor.requestId,
      decision: 'allow', result: status,
    }, this.pool, true);
    return row;
  }

  /**
   * Modo real: aplica a Google los campos soportados (updateMask) y confirma con nueva lectura. Un
   * fallo de Google deja la copia local guardada con sync_status='failed' y el código del error;
   * nunca se finge sincronización.
   */
  private async syncToGoogle(tenantId: string, locationName: string, values: Omit<Parameters<GoogleLocationService['apply']>[2], 'primary_phone'>): Promise<GbpProfileRow> {
    const phones = await this.phones.view(tenantId);
    const phone = phones.integration_phones.google_business_profile.effective_phone;
    let detail: Record<string, unknown>;
    let status: GbpProfileRow['sync_status'];
    try {
      const result: ApplyResult = await this.google!.apply(tenantId, locationName, { ...values, primary_phone: phone });
      status = result.status;
      detail = { applied: result.applied, confirmed: result.confirmed, mismatched: result.mismatched, unsupported: result.unsupported };
    } catch (err) {
      if (!(err instanceof GoogleApiError)) throw err;
      status = 'failed';
      detail = { error: `${err.kind}:${err.reason}`, retryable: err.retryable };
      log.warn('google.profile.sync_failed', 'location patch/read failed', { tenant_id: tenantId, kind: err.kind, reason: err.reason });
    }
    const upd = await this.pool.query<GbpProfileRow>(
      `UPDATE gbp_profile SET sync_status = $2, synced_at = CASE WHEN $2 IN ('synced','partial') THEN now() ELSE NULL END,
         sync_detail = $3::jsonb, google_location_name = $4, last_read_at = CASE WHEN $2 = 'failed' THEN last_read_at ELSE now() END, updated_at = now()
       WHERE tenant_id = $1 RETURNING *`, [tenantId, status, JSON.stringify(detail), locationName]);
    return upd.rows[0] as GbpProfileRow;
  }

  /** Simula que Google confirmó la verificación pendiente (solo desarrollo). */
  async simulateVerification(actor: { tenantId: string; userId: string; role: string | null; requestId: string }): Promise<GbpProfileRow | null> {
    if (this.mode !== 'simulated') throw new AppError(409, 'validation_error', 'La verificación real de Google no está conectada.');
    const res = await this.pool.query<GbpProfileRow>(
      `UPDATE gbp_profile SET sync_status = 'simulated_synced', synced_at = now(), updated_at = now()
        WHERE tenant_id = $1 RETURNING *`, [actor.tenantId]);
    await this.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'google.profile.verified_simulated', resource: 'gbp_profile', request_id: actor.requestId,
      decision: 'allow', result: res.rows[0] ? 'simulated_synced' : 'not_found',
    });
    return res.rows[0] ?? null;
  }
}
