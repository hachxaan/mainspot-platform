/**
 * DEV-E2E-04 §2A — ficha REAL de Google Business Profile (Business Information API v1).
 *
 * Lee la ubicación conectada con `readMask` y aplica cambios con `updateMask` SOLO sobre los campos
 * que la API permite editar desde MainSpot sin verificación adicional: nombre (title), descripción
 * (profile.description), sitio web (websiteUri), horario (regularHours) y teléfono principal
 * (phoneNumbers.primaryPhone). Tras el PATCH se vuelve a leer y cada campo se confirma contra lo
 * enviado. Campos restringidos (categoría, dirección, coordenadas) se reportan `unsupported` con
 * explicación; nunca se marcan como sincronizados.
 */

import type { HoursEntry } from './profile.ts';
import { GoogleBusinessClient, LOCATION_READ_MASK, type GoogleLocation, type GoogleTimePeriod } from './client.ts';

export const SUPPORTED_FIELDS = ['title', 'profile.description', 'websiteUri', 'regularHours', 'phoneNumbers.primaryPhone'] as const;
export type SupportedField = (typeof SUPPORTED_FIELDS)[number];

export interface GoogleLocationView {
  name: string;
  title: string | null;
  primary_category: string | null;
  description: string | null;
  address_line: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  country_iso2: string | null;
  latitude: number | null;
  longitude: number | null;
  hours: HoursEntry[];
  website_url: string | null;
  primary_phone: string | null;
  verified: boolean;
  maps_uri: string | null;
}

/** Valores locales que se quieren reflejar en Google (los de gbp_profile + teléfono efectivo). */
export interface DesiredProfile {
  business_name: string;
  primary_category: string;
  description: string | null;
  address_line: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  country_iso2: string | null;
  latitude: number | null;
  longitude: number | null;
  hours: HoursEntry[];
  website_url: string | null;
  /** null ⇒ no tocar el teléfono en Google. */
  primary_phone: string | null;
}

export interface UnsupportedField { field: string; reason: string }

export interface ApplyResult {
  /** synced: todo confirmado; partial: hubo campos no soportados pendientes; failed: la lectura posterior no coincide. */
  status: 'synced' | 'partial' | 'failed';
  applied: SupportedField[];
  confirmed: SupportedField[];
  mismatched: SupportedField[];
  unsupported: UnsupportedField[];
  location: GoogleLocationView;
}

const DAY_TO_GOOGLE: Record<HoursEntry['day'], string> = { mon: 'MONDAY', tue: 'TUESDAY', wed: 'WEDNESDAY', thu: 'THURSDAY', fri: 'FRIDAY', sat: 'SATURDAY', sun: 'SUNDAY' };
const GOOGLE_TO_DAY = Object.fromEntries(Object.entries(DAY_TO_GOOGLE).map(([k, v]) => [v, k])) as Record<string, HoursEntry['day']>;

function hhmm(t: { hours?: number; minutes?: number } | undefined): string {
  return `${String(t?.hours ?? 0).padStart(2, '0')}:${String(t?.minutes ?? 0).padStart(2, '0')}`;
}

export function hoursToPeriods(hours: HoursEntry[]): GoogleTimePeriod[] {
  const out: GoogleTimePeriod[] = [];
  for (const h of hours) {
    if (h.closed || !h.open || !h.close) continue;
    const [oh, om] = h.open.split(':').map(Number);
    const [ch, cm] = h.close.split(':').map(Number);
    out.push({ openDay: DAY_TO_GOOGLE[h.day], openTime: { hours: oh, minutes: om }, closeDay: DAY_TO_GOOGLE[h.day], closeTime: { hours: ch, minutes: cm } });
  }
  return out;
}

/** Primer periodo de cada día (MainSpot modela un tramo por día); días sin periodo ⇒ cerrado. */
export function periodsToHours(periods: GoogleTimePeriod[] | undefined): HoursEntry[] {
  const byDay = new Map<HoursEntry['day'], HoursEntry>();
  for (const p of periods ?? []) {
    const day = GOOGLE_TO_DAY[p.openDay];
    if (!day || byDay.has(day)) continue;
    byDay.set(day, { day, open: hhmm(p.openTime), close: hhmm(p.closeTime) });
  }
  return (Object.keys(DAY_TO_GOOGLE) as HoursEntry['day'][]).map((d) => byDay.get(d) ?? { day: d, closed: true });
}

/** Clave de comparación de horarios: solo los días abiertos, ordenados. */
function hoursKey(hours: HoursEntry[]): string {
  return hours.filter((h) => !h.closed && h.open && h.close).map((h) => `${h.day}:${h.open}-${h.close}`).sort().join('|');
}

export function normalizeLocation(loc: GoogleLocation): GoogleLocationView {
  const a = loc.storefrontAddress;
  return {
    name: loc.name,
    title: loc.title ?? null,
    primary_category: loc.categories?.primaryCategory?.displayName ?? null,
    description: loc.profile?.description ?? null,
    address_line: a?.addressLines?.length ? a.addressLines.join(', ') : null,
    locality: a?.locality ?? null,
    region: a?.administrativeArea ?? null,
    postal_code: a?.postalCode ?? null,
    country_iso2: a?.regionCode ?? null,
    latitude: loc.latlng?.latitude ?? null,
    longitude: loc.latlng?.longitude ?? null,
    hours: periodsToHours(loc.regularHours?.periods),
    website_url: loc.websiteUri ?? null,
    primary_phone: loc.phoneNumbers?.primaryPhone ?? null,
    verified: loc.metadata?.hasVoiceOfMerchant === true,
    maps_uri: loc.metadata?.mapsUri ?? null,
  };
}

/** Valor comparable de un campo soportado en una lectura de Google. */
function fieldValue(view: GoogleLocationView, field: SupportedField): string {
  switch (field) {
    case 'title': return view.title ?? '';
    case 'profile.description': return view.description ?? '';
    case 'websiteUri': return view.website_url ?? '';
    case 'regularHours': return hoursKey(view.hours);
    case 'phoneNumbers.primaryPhone': return view.primary_phone ?? '';
  }
}

function desiredValue(d: DesiredProfile, field: SupportedField): string | null {
  switch (field) {
    case 'title': return d.business_name;
    case 'profile.description': return d.description ?? '';
    case 'websiteUri': return d.website_url ?? '';
    case 'regularHours': return hoursKey(d.hours);
    case 'phoneNumbers.primaryPhone': return d.primary_phone;
  }
}

export function unsupportedChanges(current: GoogleLocationView, d: DesiredProfile): UnsupportedField[] {
  const out: UnsupportedField[] = [];
  if (d.primary_category && (current.primary_category ?? '') !== d.primary_category) {
    out.push({ field: 'primary_category', reason: 'Google exige una categoría de su propio catálogo; se cambia desde Google Business Profile.' });
  }
  const addrChanged = [
    [d.address_line, current.address_line], [d.locality, current.locality], [d.region, current.region],
    [d.postal_code, current.postal_code], [d.country_iso2, current.country_iso2],
  ].some(([mine, theirs]) => mine !== null && mine !== '' && (theirs ?? '') !== mine);
  if (addrChanged) {
    out.push({ field: 'address', reason: 'Cambiar la dirección puede exigir una nueva verificación de Google; se gestiona desde Google Business Profile.' });
  }
  if ((d.latitude !== null && d.latitude !== current.latitude) || (d.longitude !== null && d.longitude !== current.longitude)) {
    out.push({ field: 'coordinates', reason: 'Google fija el punto del mapa a partir de la dirección verificada.' });
  }
  return out;
}

export class GoogleLocationService {
  private readonly client: GoogleBusinessClient;

  constructor(client: GoogleBusinessClient) {
    this.client = client;
  }

  async read(tenantId: string, locationName: string): Promise<GoogleLocationView> {
    return normalizeLocation(await this.client.getLocation(tenantId, locationName, LOCATION_READ_MASK));
  }

  /** PATCH con updateMask de los campos soportados que difieren; lectura posterior de confirmación. */
  async apply(tenantId: string, locationName: string, desired: DesiredProfile): Promise<ApplyResult> {
    const current = normalizeLocation(await this.client.getLocation(tenantId, locationName, LOCATION_READ_MASK));
    const patch: Partial<GoogleLocation> = {};
    const mask: SupportedField[] = [];
    for (const field of SUPPORTED_FIELDS) {
      const want = desiredValue(desired, field);
      if (want === null || want === fieldValue(current, field)) continue;
      mask.push(field);
      switch (field) {
        case 'title': patch.title = want; break;
        case 'profile.description': patch.profile = { description: want }; break;
        case 'websiteUri': patch.websiteUri = want; break;
        case 'regularHours': patch.regularHours = { periods: hoursToPeriods(desired.hours) }; break;
        case 'phoneNumbers.primaryPhone': patch.phoneNumbers = { primaryPhone: want }; break;
      }
    }
    const unsupported = unsupportedChanges(current, desired);
    if (mask.length === 0) {
      return { status: unsupported.length ? 'partial' : 'synced', applied: [], confirmed: [], mismatched: [], unsupported, location: current };
    }
    await this.client.patchLocation(tenantId, locationName, mask.join(','), patch);
    const after = normalizeLocation(await this.client.getLocation(tenantId, locationName, LOCATION_READ_MASK));
    const confirmed = mask.filter((f) => fieldValue(after, f) === desiredValue(desired, f));
    const mismatched = mask.filter((f) => !confirmed.includes(f));
    return {
      status: mismatched.length ? 'failed' : unsupported.length ? 'partial' : 'synced',
      applied: mask, confirmed, mismatched, unsupported, location: after,
    };
  }
}
