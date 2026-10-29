/**
 * Teléfonos de contacto del negocio (DEV-E2E-02, SHARED-CONTRACT §A).
 *
 * - `primary_phone`: teléfono principal editable del negocio.
 * - Cada integración (`website`, `google_business_profile`, `facebook`) guarda su PROPIO
 *   `mode: own | other` y su PROPIO `other_phone`. No existe un número alternativo global.
 * - effective_phone(channel) = primary cuando mode=own; si no, el other_phone de ese canal.
 * - Cambiar el principal solo cambia el efectivo de los canales `own`; nunca toca los
 *   overrides. Actualizar un canal nunca pisa a los demás (UPSERT por (tenant, channel)).
 * - other→own conserva el override del canal (para retomarlo); solo se borra con
 *   `other_phone: null` explícito.
 * - Validación E.164 con libphonenumber-js (metadatos completos), no reglas fijas de dígitos.
 * - Auditoría sin PII: modo y canal, nunca dígitos.
 * - El teléfono público NO es destino de Telegram/WhatsApp/SMS (las alertas usan el chat vinculado).
 */

import type { Pool, PoolClient } from 'pg';
import { getCountryCallingCode, isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import type { AuditSink } from '../audit/sink.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { AppError } from '../shared/errors.ts';

export const PHONE_CHANNELS = ['website', 'google_business_profile', 'facebook'] as const;
export type PhoneChannel = (typeof PHONE_CHANNELS)[number];
export type PhoneMode = 'own' | 'other';

export interface PhoneValue {
  country_iso2: string;
  calling_code: string;
  national_number: string;
  e164: string;
}

export type SyncMode = 'internal' | 'simulated' | 'not_verified';

export interface IntegrationPhoneView {
  mode: PhoneMode;
  /** Override guardado de ESTE canal (se conserva aunque mode=own; no es contacto activo en ese caso). */
  other_phone: PhoneValue | null;
  effective_phone: string | null;
  effective_source: 'primary' | 'other' | null;
  /** mode=own sin teléfono principal capturado: la UI debe pedirlo (nunca se inventa uno). */
  needs_primary: boolean;
  sync: { mode: SyncMode; status: string; synced_at: string | null };
}

export interface ContactPhonesView {
  tenant_id: string;
  primary_phone: PhoneValue | null;
  integration_phones: Record<PhoneChannel, IntegrationPhoneView>;
}

export class PhoneValidationError extends AppError {
  readonly fields: Array<{ field: string; message: string }>;

  constructor(fields: Array<{ field: string; message: string }>) {
    super(400, 'validation_error', fields[0]?.message ?? 'El teléfono no es válido.');
    this.fields = fields;
  }
}

export function isPhoneChannel(value: string): value is PhoneChannel {
  return (PHONE_CHANNELS as readonly string[]).includes(value);
}

/**
 * Normaliza y valida un teléfono. Acepta `{country_iso2, national_number[, calling_code]}` o
 * `{e164[, country_iso2]}`. El prefijo, si llega, debe corresponder al país.
 */
export function normalizePhone(input: unknown, field: string): PhoneValue {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PhoneValidationError([{ field, message: 'Indica el país y el número de teléfono.' }]);
  }
  const raw = input as Record<string, unknown>;
  const country = typeof raw['country_iso2'] === 'string' ? raw['country_iso2'].trim().toUpperCase() : '';
  const national = typeof raw['national_number'] === 'string' ? raw['national_number'].trim() : '';
  const e164 = typeof raw['e164'] === 'string' ? raw['e164'].trim() : '';
  const callingCode = typeof raw['calling_code'] === 'string' ? raw['calling_code'].trim() : '';

  if (country && !isSupportedCountry(country)) {
    throw new PhoneValidationError([{ field: `${field}.country_iso2`, message: 'Elige un país de la lista.' }]);
  }
  if (country && callingCode && callingCode !== `+${getCountryCallingCode(country as CountryCode)}`) {
    throw new PhoneValidationError([{ field: `${field}.calling_code`, message: 'El prefijo no corresponde al país elegido.' }]);
  }
  if (!national && !e164) {
    throw new PhoneValidationError([{ field: `${field}.national_number`, message: 'Escribe el número de teléfono.' }]);
  }
  if (national && !country) {
    throw new PhoneValidationError([{ field: `${field}.country_iso2`, message: 'Elige el país del número.' }]);
  }
  if (national && /[^0-9\s()+.-]/.test(national)) {
    throw new PhoneValidationError([{ field: `${field}.national_number`, message: 'El número solo puede tener dígitos.' }]);
  }
  const parsed = national
    ? parsePhoneNumberFromString(national, country as CountryCode)
    : parsePhoneNumberFromString(e164);
  if (!parsed || !parsed.isValid()) {
    throw new PhoneValidationError([{ field: `${field}.national_number`, message: 'Ese número no es válido para el país elegido. Revisa los dígitos.' }]);
  }
  if (country && parsed.country && parsed.country !== country) {
    throw new PhoneValidationError([{ field: `${field}.country_iso2`, message: 'El número no corresponde al país elegido.' }]);
  }
  const resolvedCountry = parsed.country ?? country;
  if (!resolvedCountry) {
    throw new PhoneValidationError([{ field: `${field}.country_iso2`, message: 'Elige el país del número.' }]);
  }
  return {
    country_iso2: resolvedCountry,
    calling_code: `+${parsed.countryCallingCode}`,
    national_number: String(parsed.nationalNumber),
    e164: parsed.number,
  };
}

interface ContactRow {
  primary_country_iso2: string;
  primary_calling_code: string;
  primary_national_number: string;
  primary_e164: string;
}

interface IntegrationRow {
  channel: PhoneChannel;
  mode: PhoneMode;
  other_country_iso2: string | null;
  other_calling_code: string | null;
  other_national_number: string | null;
  other_e164: string | null;
  sync_status: string;
  synced_at: Date | string | null;
}

export interface ContactPhoneServiceDeps {
  pool: Pool;
  sink: AuditSink;
  /** Modo de cada proveedor externo: 'simulated' sin credenciales; con credenciales nunca se afirma sincronía real. */
  providerModes: { google_business_profile: 'simulated' | 'real'; facebook: 'simulated' | 'real' };
}

type Db = Pool | PoolClient;

export class ContactPhoneService {
  private readonly deps: ContactPhoneServiceDeps;

  constructor(deps: ContactPhoneServiceDeps) {
    this.deps = deps;
  }

  private syncFor(channel: PhoneChannel): { mode: SyncMode; status: IntegrationRow['sync_status'] } {
    if (channel === 'website') return { mode: 'internal', status: 'applies_on_publish' };
    return this.deps.providerModes[channel] === 'simulated'
      ? { mode: 'simulated', status: 'simulated_synced' }
      : { mode: 'not_verified', status: 'not_verified' };
  }

  async view(tenantId: string, db: Db = this.deps.pool): Promise<ContactPhonesView> {
    if (!tenantId) throw new Error('FAIL-CLOSED: contact phones require a tenant context');
    const contact = await db.query<ContactRow>('SELECT * FROM business_contact WHERE tenant_id = $1', [tenantId]);
    const rows = await db.query<IntegrationRow>('SELECT * FROM integration_phone WHERE tenant_id = $1', [tenantId]);
    const c = contact.rows[0];
    const primary: PhoneValue | null = c
      ? { country_iso2: c.primary_country_iso2, calling_code: c.primary_calling_code, national_number: c.primary_national_number, e164: c.primary_e164 }
      : null;
    const byChannel = new Map(rows.rows.map((r) => [r.channel, r]));
    const integration = {} as Record<PhoneChannel, IntegrationPhoneView>;
    for (const channel of PHONE_CHANNELS) {
      const r = byChannel.get(channel);
      const other: PhoneValue | null = r?.other_e164
        ? { country_iso2: r.other_country_iso2 as string, calling_code: r.other_calling_code as string, national_number: r.other_national_number as string, e164: r.other_e164 }
        : null;
      const mode: PhoneMode = r?.mode ?? 'own';
      const effective = mode === 'other' ? other?.e164 ?? null : primary?.e164 ?? null;
      const sync = this.syncFor(channel);
      integration[channel] = {
        mode,
        other_phone: other,
        effective_phone: effective,
        effective_source: effective ? (mode === 'other' ? 'other' : 'primary') : null,
        needs_primary: mode === 'own' && !primary,
        sync: {
          mode: sync.mode,
          status: r ? r.sync_status : (sync.mode === 'internal' ? 'applies_on_publish' : 'pending'),
          synced_at: r?.synced_at ? new Date(r.synced_at).toISOString() : null,
        },
      };
    }
    return { tenant_id: tenantId, primary_phone: primary, integration_phones: integration };
  }

  /** Teléfono efectivo de un canal (o null si no hay nada configurado). */
  async effectivePhone(tenantId: string, channel: PhoneChannel, db: Db = this.deps.pool): Promise<string | null> {
    const view = await this.view(tenantId, db);
    return view.integration_phones[channel].effective_phone;
  }

  async setPrimary(
    actor: { tenantId: string; userId: string; role: string | null; requestId: string },
    input: unknown,
  ): Promise<ContactPhonesView> {
    const phone = normalizePhone(input, 'primary_phone');
    return runAtomic(this.deps.pool, async (client) => {
      await client.query(
        `INSERT INTO business_contact (tenant_id, primary_country_iso2, primary_calling_code, primary_national_number, primary_e164, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id) DO UPDATE SET
           primary_country_iso2 = EXCLUDED.primary_country_iso2,
           primary_calling_code = EXCLUDED.primary_calling_code,
           primary_national_number = EXCLUDED.primary_national_number,
           primary_e164 = EXCLUDED.primary_e164,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [actor.tenantId, phone.country_iso2, phone.calling_code, phone.national_number, phone.e164, actor.userId],
      );
      // Los canales `own` cambian su efectivo: se marcan para re-sincronizar (simulado).
      for (const channel of PHONE_CHANNELS) {
        const sync = this.syncFor(channel);
        await client.query(
          `UPDATE integration_phone SET sync_status = $3, synced_at = CASE WHEN $3 = 'simulated_synced' THEN now() ELSE NULL END, updated_at = now()
            WHERE tenant_id = $1 AND channel = $2 AND mode = 'own'`,
          [actor.tenantId, channel, sync.status],
        );
      }
      await this.deps.sink.write({
        tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
        action: 'contact.phone.updated', resource: 'contact_phone/primary',
        request_id: actor.requestId, decision: 'allow', result: 'primary_set',
      }, client, true);
      return this.view(actor.tenantId, client);
    });
  }

  /**
   * Actualiza SOLO el canal indicado. Cuerpo: `{ mode, other_phone? }`.
   * - mode=other + other_phone → guarda el override de este canal.
   * - mode=other sin other_phone → reutiliza el override conservado del canal (o 400 si no hay).
   * - mode=own → el efectivo pasa a ser el principal; el override se conserva.
   * - other_phone: null (con mode=own) → borra el override de forma explícita.
   */
  async setIntegration(
    actor: { tenantId: string; userId: string; role: string | null; requestId: string },
    channel: PhoneChannel,
    body: unknown,
  ): Promise<ContactPhonesView> {
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const mode = b['mode'];
    if (mode !== 'own' && mode !== 'other') {
      throw new PhoneValidationError([{ field: 'mode', message: 'Elige «Usar mi número» u «Otro número».' }]);
    }
    const hasOther = Object.prototype.hasOwnProperty.call(b, 'other_phone');
    const clear = hasOther && b['other_phone'] === null;
    if (clear && mode === 'other') {
      throw new PhoneValidationError([{ field: 'other_phone', message: 'Para borrar el otro número, elige «Usar mi número».' }]);
    }
    const phone = hasOther && !clear ? normalizePhone(b['other_phone'], 'other_phone') : null;
    const sync = this.syncFor(channel);

    return runAtomic(this.deps.pool, async (client) => {
      const current = await client.query<IntegrationRow>(
        'SELECT * FROM integration_phone WHERE tenant_id = $1 AND channel = $2 FOR UPDATE', [actor.tenantId, channel]);
      const prev = current.rows[0];
      let other: PhoneValue | null = prev?.other_e164
        ? { country_iso2: prev.other_country_iso2 as string, calling_code: prev.other_calling_code as string, national_number: prev.other_national_number as string, e164: prev.other_e164 }
        : null;
      if (phone) other = phone;
      if (clear) other = null;
      if (mode === 'other' && !other) {
        throw new PhoneValidationError([{ field: 'other_phone', message: 'Escribe el otro número para este canal.' }]);
      }
      await client.query(
        `INSERT INTO integration_phone
           (tenant_id, channel, mode, other_country_iso2, other_calling_code, other_national_number, other_e164, sync_status, synced_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8 = 'simulated_synced' THEN now() ELSE NULL END, $9)
         ON CONFLICT (tenant_id, channel) DO UPDATE SET
           mode = EXCLUDED.mode,
           other_country_iso2 = EXCLUDED.other_country_iso2,
           other_calling_code = EXCLUDED.other_calling_code,
           other_national_number = EXCLUDED.other_national_number,
           other_e164 = EXCLUDED.other_e164,
           sync_status = EXCLUDED.sync_status,
           synced_at = EXCLUDED.synced_at,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [actor.tenantId, channel, mode, other?.country_iso2 ?? null, other?.calling_code ?? null,
          other?.national_number ?? null, other?.e164 ?? null, sync.status, actor.userId],
      );
      await this.deps.sink.write({
        tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
        action: 'contact.phone.updated', resource: `contact_phone/${channel}`,
        request_id: actor.requestId, decision: 'allow',
        result: `mode:${mode}${clear ? ':override_cleared' : phone ? ':override_set' : ''}`,
      }, client, true);
      return this.view(actor.tenantId, client);
    });
  }
}

/** Formato internacional legible (p. ej. «+52 983 000 0000») para mostrar en la web. */
export function formatInternational(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}

/**
 * Aplica el teléfono efectivo del canal website a los datos del sitio. Sin configuración de
 * teléfonos (tenant previo a esta función) conserva el teléfono existente del sitio.
 */
export async function withEffectivePhone<T extends { phone: string }>(
  phones: ContactPhoneService | undefined, tenantId: string, data: T, db?: Pool | PoolClient,
): Promise<T> {
  if (!phones) return data;
  const effective = await phones.effectivePhone(tenantId, 'website', db);
  return effective ? { ...data, phone: formatInternational(effective) } : data;
}
