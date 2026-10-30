/**
 * Subconjunto de JSON Schema para salidas de IA (ARC-0001).
 *
 * - `validate` aplica TODAS las restricciones (tipos, enum, required, additionalProperties,
 *   longitudes, patrones, rangos y tamaños de arreglos).
 * - `toModelSchema` produce el esquema que se envía al proveedor (`response_format.json_schema`):
 *   modo estricto compatible (todas las propiedades requeridas, sin propiedades extra) y sin las
 *   palabras clave que algunos proveedores rechazan; esas restricciones se aplican aquí al validar.
 */

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface JsonSchema {
  type?: JsonType | JsonType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: ReadonlyArray<string | number | boolean | null>;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

const MODEL_STRIPPED = new Set(['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems']);

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value as JsonType;
}

function typeMatches(expected: JsonType | JsonType[] | undefined, value: unknown): boolean {
  if (!expected) return true;
  const list = Array.isArray(expected) ? expected : [expected];
  const actual = typeOf(value);
  return list.some((t) => t === actual || (t === 'number' && actual === 'integer'));
}

/** Errores de validación (vacío = válido). Las rutas usan la notación `$.a.b[0]`. */
export function validate(schema: JsonSchema, value: unknown, path = '$', errors: string[] = [], limit = 50): string[] {
  if (errors.length >= limit) return errors;
  if (!typeMatches(schema.type, value)) {
    errors.push(`${path}: expected ${Array.isArray(schema.type) ? schema.type.join('|') : schema.type}, got ${typeOf(value)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value as string | number | boolean | null)) {
    errors.push(`${path}: value not in enum`);
  }
  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && len > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => validate(schema.items as JsonSchema, item, `${path}[${i}]`, errors, limit));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required`);
    }
    for (const [key, child] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
        continue;
      }
      validate(sub, child, `${path}.${key}`, errors, limit);
    }
  }
  return errors;
}

/**
 * Esquema para el proveedor: estricto y sin palabras clave que algunos proveedores rechazan.
 * Los anulables `type: [X, 'null']` con enum, objeto o arreglo se expresan como
 * `anyOf: [{…X}, {type:'null'}]` (Anthropic rechaza enum junto a tipos múltiples).
 */
export function toModelSchema(schema: JsonSchema): Record<string, unknown> {
  if (Array.isArray(schema.type) && schema.type.includes('null') && schema.type.length === 2) {
    const base = schema.type.find((t) => t !== 'null') as JsonType;
    if (schema.enum || base === 'object' || base === 'array') {
      const inner: JsonSchema = { ...schema, type: base };
      if (schema.enum) inner.enum = schema.enum.filter((e) => e !== null);
      const { description, ...rest } = inner;
      return { ...(description ? { description } : {}), anyOf: [toModelSchema(rest), { type: 'null' }] };
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (MODEL_STRIPPED.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, JsonSchema>).map(([k, v]) => [k, toModelSchema(v)]));
    } else if (key === 'items' && value && typeof value === 'object') {
      out.items = toModelSchema(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }
  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
    out.additionalProperties = false;
    out.required = Object.keys(schema.properties ?? {});
  }
  return out;
}

/** Extrae el primer objeto JSON de un texto (algunos modelos envuelven la salida en ```json). */
export function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = /```(?:json)?\s*([\s\S]*?)```/u.exec(trimmed);
    if (fence?.[1]) return JSON.parse(fence[1]);
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new SyntaxError('no JSON object in model output');
  }
}
