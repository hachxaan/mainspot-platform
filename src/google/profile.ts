/**
 * Ficha de Google Business Profile / presencia en Maps en SIMULACIÓN (DEV-E2E-02).
 *
 * Datos básicos, ubicación y horarios editables por el dueño; el teléfono público de la ficha es
 * el efectivo del canal `google_business_profile` (principal u «Otro número» propio de Google).
 * No hay llamada a la API de Google: el estado de sincronización se marca `simulated_*`. Cambiar
 * nombre o dirección deja la ficha en `simulated_pending_verification`, porque en Google real
 * esos cambios pueden requerir verificación del proveedor.
 */

import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import type { ContactPhoneService } from '../contact/phones.ts';
import { AppError } from '../shared/errors.ts';

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
  sync_mode: 'simulated' | 'not_verified';
  sync_status: 'simulated_synced' | 'simulated_pending_verification' | 'not_verified';
  synced_at: string | null;
  updated_by: string;
  updated_at: string;
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

export class GbpProfileService {
  private readonly pool: Pool;
  private readonly sink: AuditSink;
  private readonly phones: ContactPhoneService;
  private readonly mode: 'simulated' | 'not_verified';

  constructor(deps: { pool: Pool; sink: AuditSink; phones: ContactPhoneService; mode: 'simulated' | 'not_verified' }) {
    this.pool = deps.pool;
    this.sink = deps.sink;
    this.phones = deps.phones;
    this.mode = deps.mode;
  }

  async view(tenantId: string): Promise<{ profile: GbpProfileRow | null; phone: { effective_phone: string | null; mode: string; source: string | null }; provider_mode: string }> {
    const res = await this.pool.query<GbpProfileRow>('SELECT * FROM gbp_profile WHERE tenant_id = $1', [tenantId]);
    const phones = await this.phones.view(tenantId);
    const g = phones.integration_phones.google_business_profile;
    return {
      profile: res.rows[0] ?? null,
      phone: { effective_phone: g.effective_phone, mode: g.mode, source: g.effective_source },
      provider_mode: this.mode,
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
      business_name: str(b, 'business_name', 120, true),
      primary_category: str(b, 'primary_category', 80, true),
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
    const status = this.mode === 'not_verified' ? 'not_verified' : needsVerification ? 'simulated_pending_verification' : 'simulated_synced';
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
        values.website_url, this.mode, status, actor.userId]);
    await this.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'google.profile.updated', resource: 'gbp_profile', request_id: actor.requestId,
      decision: 'allow', result: status,
    }, this.pool, true);
    return res.rows[0] as GbpProfileRow;
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
