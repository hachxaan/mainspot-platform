/**
 * Zona horaria de las publicaciones programadas (DEV-E2E-04, P4).
 *
 * MainSpot guarda SIEMPRE instantes UTC (TIMESTAMPTZ); la hora que escribe la persona se
 * interpreta en la zona horaria del negocio (SOCIAL_SCHEDULER_TIMEZONE, por defecto
 * America/Cancun) con las reglas de horario de verano de la base IANA que trae Node
 * (Intl). Sin dependencias: la conversión «hora de pared → UTC» se resuelve con el offset
 * real de la zona en ese instante y se verifica formateando de vuelta.
 *
 * Casos límite del horario de verano:
 *  - Hora inexistente o ambigua: se rechaza; no se desplaza ni elige otra hora sin permiso.
 *  - Fechas imposibles: se rechazan, no se normalizan al mes siguiente.
 */

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

export const DEFAULT_SCHEDULER_TIMEZONE = 'America/Cancun';

/** Lanza si la zona no existe en la base IANA del runtime (fail-fast al arrancar). */
export function assertTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`SOCIAL_SCHEDULER_TIMEZONE is not a valid IANA time zone: ${tz}`);
  }
  return tz;
}

interface WallParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function partsInZone(date: Date, tz: string): WallParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour! === 24 ? 0 : out.hour!, minute: out.minute!, second: out.second! };
}

function utcOf(p: WallParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Offset (ms) de la zona respecto a UTC en el instante dado (positivo al este de Greenwich). */
export function zoneOffsetMs(date: Date, tz: string): number {
  return utcOf(partsInZone(date, tz)) - date.getTime();
}

/**
 * Convierte una hora de pared `YYYY-MM-DDTHH:mm[:ss]` de la zona `tz` a un instante UTC.
 * null si el formato/calendario no es válido o la hora local no identifica un instante único.
 */
export function wallTimeToUtc(wall: string, tz: string): Date | null {
  const m = WALL_RE.exec(wall.trim());
  if (!m) return null;
  const want: WallParts = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? '0') };
  if (want.month < 1 || want.month > 12 || want.day < 1 || want.day > 31 || want.hour > 23 || want.minute > 59 || want.second > 59) return null;
  const asUtc = utcOf(want);
  const normalized = new Date(asUtc);
  if (Number.isNaN(asUtc) || normalized.getUTCFullYear() !== want.year || normalized.getUTCMonth() + 1 !== want.month || normalized.getUTCDate() !== want.day) return null;
  // Muestrear ambos lados del cambio: la propia hora UTC aproximada puede caer antes del DST.
  const day = 24 * 60 * 60_000;
  const offsets = new Set([-day, 0, day].map((delta) => zoneOffsetMs(new Date(asUtc + delta), tz)));
  const exact = [...offsets].map((offset) => asUtc - offset)
    .filter((candidate) => utcOf(partsInZone(new Date(candidate), tz)) === asUtc);
  return exact.length === 1 ? new Date(exact[0]!) : null;
}

/** `YYYY-MM-DD HH:mm` en la zona (para respuestas y avisos legibles). */
export function formatInZone(date: Date, tz: string): string {
  const p = partsInZone(date, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
