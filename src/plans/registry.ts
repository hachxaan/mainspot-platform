/**
 * Registro tipado de parámetros de plan (FR-0010, DEC-0075): ÚNICA fuente de verdad de qué se
 * configura por plan, con qué tipo, unidad, semántica, periodo, rango y techo de sistema.
 *
 * - La migración 0034 refleja este registro en `plan_parameter_definition` (integridad referencial y
 *   comprobación de rango en la BD). El espejo se compara en cada escritura del catálogo (`assertWritable`,
 *   catalog.ts: si difieren, 503 y nada cambia; el enforcement sigue con lo publicado) y lo informa
 *   `GET /plan-catalog/parameters`. No hay comprobación al arrancar.
 * - Solo entran parámetros con punto de enforcement real (o, para `agents`, la decisión canónica que lo
 *   difiere). Techos técnicos, de proveedor, seguridad, retención o evidencia NO se registran aquí.
 * - Alcance de este incremento (SRC-0013): las seis capacidades existentes con sus valores vigentes,
 *   ningún parámetro nuevo. Las semánticas `stock`, `periodic`, `rate_window` y `eligibility` existen
 *   como mecanismo probado del libro de cuotas; ningún parámetro real las usa (periódicas: HDC-MSP-06).
 * - Agregar un parámetro exige migración que lo refleje y una revisión nueva por plan: las revisiones
 *   publicadas no cambian y un valor ausente siempre deniega (nunca concesión implícita).
 */

export type ParameterSemantics = 'cumulative' | 'stock' | 'periodic' | 'rate_window' | 'eligibility';
export type ParameterValueType = 'int' | 'bool';
export type ParameterPeriod =
  | { readonly kind: 'none' }
  | { readonly kind: 'subscription_month' }
  | { readonly kind: 'sliding_window'; readonly seconds: number };

export interface PlanParameterDefinition {
  /** Clave estable (`quota.<capacidad>.max`). */
  readonly key: string;
  /** Capacidad del libro de cuotas (`quota_reservation.capability`); null solo para elegibilidad pura. */
  readonly capability: string | null;
  readonly category: string;
  readonly label: string;
  readonly description: string;
  readonly unit: string;
  readonly valueType: ParameterValueType;
  readonly semantics: ParameterSemantics;
  readonly period: ParameterPeriod;
  /** Rango admitido (enteros). Para `bool`, 0..1. `max` es el techo de sistema no sobrepasable. */
  readonly min: number;
  readonly max: number;
  readonly ceilingReason: string;
  /** Valor precargado al crear un plan: sugerencia SIN confirmar, nunca una oferta comercial. */
  readonly suggested: number | boolean;
  readonly suggestedReason: string;
  readonly enforcement: { readonly state: 'enforced' | 'not_enforced'; readonly points: readonly string[]; readonly note: string };
  /**
   * Uso para `cumulative`/`stock`: SQL de conteo de filas de dominio del tenant ($1) que corre dentro
   * del candado de cuota. `periodic`/`rate_window` cuentan unidades confirmadas del libro de cuotas.
   */
  readonly usageSql: string | null;
  readonly sortOrder: number;
}

/** Versión del registro: se incrementa con cualquier cambio de definiciones (y su migración). */
export const PLAN_REGISTRY_VERSION = 1;

/**
 * Límite de validación contra errores de captura en recuentos (no es oferta comercial ni techo de
 * proveedor): mantiene los valores dentro de INT4 con amplio margen y evita «ilimitados» implícitos.
 */
export const COUNT_SANITY_MAX = 1_000_000;

const COUNT_CEILING = 'Límite de validación de plataforma (1,000,000) contra errores de captura; no existe «ilimitado» (fail-closed).';
const PILOT_SUGGESTION = 'Valor vigente de plan_piloto_1 (referencia operativa, sin aprobación comercial).';

export const PLAN_PARAMETERS = [
  {
    key: 'quota.website.max', capability: 'website', category: 'Página web',
    label: 'Páginas web', unit: 'páginas',
    description: 'Páginas web que el negocio puede crear. Cuenta cada página creada durante toda la suscripción (no se reinicia).',
    valueType: 'int', semantics: 'cumulative', period: { kind: 'none' }, min: 0, max: 1,
    ceilingReason: 'Techo técnico 1: client_website.tenant_id es UNIQUE (migración 0005) y el código asume una sola página por negocio; multi-sitio exige cambio de esquema.',
    suggested: 1, suggestedReason: PILOT_SUGGESTION,
    enforcement: { state: 'enforced', points: ['src/api/conversation-routes.ts (creación de la página, consumo en la misma transacción)'], note: 'Consumo atómico al crear la página.' },
    usageSql: 'SELECT count(*) AS n FROM client_website WHERE tenant_id = $1', sortOrder: 10,
  },
  {
    key: 'quota.social_posts.max', capability: 'social_posts', category: 'Redes sociales',
    label: 'Publicaciones en redes', unit: 'publicaciones',
    description: 'Borradores de publicación que el negocio puede crear (cualquier estado). Cuenta durante toda la suscripción; no se reinicia ni se libera al rechazar o fallar.',
    valueType: 'int', semantics: 'cumulative', period: { kind: 'none' }, min: 0, max: COUNT_SANITY_MAX,
    ceilingReason: COUNT_CEILING, suggested: 10, suggestedReason: PILOT_SUGGESTION,
    enforcement: { state: 'enforced', points: ['src/social/service.ts (createDraft, consumo en la misma transacción)'], note: 'Se consume al crear el borrador, no al publicar.' },
    usageSql: "SELECT count(*) AS n FROM social_post WHERE tenant_id = $1 AND content_type = 'post'", sortOrder: 20,
  },
  {
    key: 'quota.social_ads.max', capability: 'social_ads', category: 'Redes sociales',
    label: 'Anuncios en redes', unit: 'anuncios',
    description: 'Borradores de anuncio que el negocio puede crear. Cuenta durante toda la suscripción. 0 = sin anuncios. La entrega real de anuncios no está disponible (sin gasto).',
    valueType: 'int', semantics: 'cumulative', period: { kind: 'none' }, min: 0, max: COUNT_SANITY_MAX,
    ceilingReason: COUNT_CEILING, suggested: 5, suggestedReason: PILOT_SUGGESTION,
    enforcement: { state: 'enforced', points: ['src/social/service.ts (createDraft con content_type ad)'], note: 'El adaptador real de Meta no publica anuncios; ningún valor autoriza gasto.' },
    usageSql: "SELECT count(*) AS n FROM social_post WHERE tenant_id = $1 AND content_type = 'ad'", sortOrder: 30,
  },
  {
    key: 'quota.reviews_managed.max', capability: 'reviews_managed', category: 'Reseñas',
    label: 'Reseñas gestionadas', unit: 'reseñas',
    description: 'Reseñas que MainSpot puede ingerir y gestionar. Cuenta todas las reseñas ingeridas durante toda la suscripción; cada sincronización consume el lote completo o nada.',
    valueType: 'int', semantics: 'cumulative', period: { kind: 'none' }, min: 0, max: COUNT_SANITY_MAX,
    ceilingReason: COUNT_CEILING, suggested: 20, suggestedReason: PILOT_SUGGESTION,
    enforcement: { state: 'enforced', points: ['src/reputation/engine.ts (sync, lote atómico)'], note: 'La purga de retención solo redacta el texto; la reseña sigue contando.' },
    usageSql: 'SELECT count(*) AS n FROM review WHERE tenant_id = $1', sortOrder: 40,
  },
  {
    key: 'quota.conversations.max', capability: 'conversations', category: 'Asistente',
    label: 'Solicitudes al asistente', unit: 'solicitudes',
    description: 'Solicitudes registradas del negocio (mensajes al asistente y solicitudes internas). Cuenta durante toda la suscripción. 0 = el negocio no puede enviar mensajes al asistente.',
    valueType: 'int', semantics: 'cumulative', period: { kind: 'none' }, min: 0, max: COUNT_SANITY_MAX,
    ceilingReason: COUNT_CEILING, suggested: 500, suggestedReason: PILOT_SUGGESTION,
    enforcement: { state: 'enforced', points: ['src/conversation/pipeline.ts (reserva antes de clasificar, commit con la solicitud)'], note: 'Solo el mensaje del dueño al asistente consume; otras rutas crean solicitudes que también cuentan como uso.' },
    usageSql: 'SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1', sortOrder: 50,
  },
  {
    key: 'quota.agents.max', capability: 'agents', category: 'Equipo',
    label: 'Usuarios del panel', unit: 'usuarios',
    description: 'Usuarios internos del panel del negocio. Hoy NO se aplica: dar de alta usuarios no consume esta cuota (DEC-0006/DEC-0017 difieren el enforcement).',
    valueType: 'int', semantics: 'cumulative', period: { kind: 'none' }, min: 0, max: COUNT_SANITY_MAX,
    ceilingReason: COUNT_CEILING, suggested: 5, suggestedReason: PILOT_SUGGESTION,
    enforcement: { state: 'not_enforced', points: [], note: 'Enforcement diferido por canon (DEC-0006, DEC-0017); no equivale a agentes de IA.' },
    usageSql: 'SELECT count(*) AS n FROM internal_user WHERE tenant_id = $1', sortOrder: 60,
  },
] as const satisfies readonly PlanParameterDefinition[];

/** Capacidades del libro de cuotas que existen hoy (derivadas del registro). */
export type CapabilityName = (typeof PLAN_PARAMETERS)[number]['capability'];
export const KNOWN_CAPABILITIES: readonly CapabilityName[] = Object.freeze(PLAN_PARAMETERS.map((d) => d.capability));

export function definitionByKey(key: string, defs: readonly PlanParameterDefinition[] = PLAN_PARAMETERS): PlanParameterDefinition | null {
  return defs.find((d) => d.key === key) ?? null;
}

export function definitionByCapability(capability: string, defs: readonly PlanParameterDefinition[] = PLAN_PARAMETERS): PlanParameterDefinition | null {
  return defs.find((d) => d.capability === capability) ?? null;
}

/** Valor tipado de un parámetro: entero o booleano. */
export type ParameterValue = number | boolean;

/**
 * Valida un valor contra su definición. Devuelve el mensaje de error (en español) o null.
 * Nunca convierte: un string, un decimal o un booleano para un entero son inválidos.
 */
export function validateValue(def: PlanParameterDefinition, value: unknown): string | null {
  if (def.valueType === 'bool') {
    return typeof value === 'boolean' ? null : `«${def.label}» debe ser sí o no.`;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) return `«${def.label}» debe ser un número entero.`;
  if (value < def.min) return `«${def.label}» no puede ser menor que ${def.min}.`;
  if (value > def.max) return `«${def.label}» no puede superar el techo de sistema (${def.max} ${def.unit}).`;
  return null;
}

/** Periodo legible: «en toda la suscripción», «por ciclo mensual»… (UI y mensajes de límite). */
export function periodLabel(def: PlanParameterDefinition): string {
  switch (def.semantics) {
    case 'cumulative': return 'en toda la suscripción (no se reinicia)';
    case 'stock': return 'activos a la vez (se libera al archivar)';
    case 'eligibility': return 'incluido o no en el plan';
    case 'periodic': return 'por ciclo mensual de la suscripción (UTC)';
    case 'rate_window': return def.period.kind === 'sliding_window' ? `por ventana móvil de ${Math.round(def.period.seconds / 60)} min` : 'por ventana móvil';
  }
}

/** Fila de `plan_parameter_definition` que corresponde a una definición (comparación del espejo). */
export function definitionRow(def: PlanParameterDefinition): Record<string, string | number | boolean | null> {
  return {
    parameter_key: def.key,
    capability: def.capability,
    value_type: def.valueType,
    semantics: def.semantics,
    period_kind: def.period.kind,
    window_seconds: def.period.kind === 'sliding_window' ? def.period.seconds : null,
    min_value: def.min,
    max_value: def.max,
    suggested_int: def.valueType === 'int' ? Number(def.suggested) : null,
    suggested_bool: def.valueType === 'bool' ? Boolean(def.suggested) : null,
    enforcement_state: def.enforcement.state,
    registry_version: PLAN_REGISTRY_VERSION,
  };
}
