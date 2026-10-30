/**
 * Contratos de salida por caso de uso (FR-0012, ARC-0001). Cada esquema es compatible con modo
 * estricto (todas las propiedades requeridas; opcionales como null). Los validadores de dominio
 * añaden reglas que un esquema no expresa (hechos inventados, límites de emojis, operaciones).
 */

import type { JsonSchema } from './schema.ts';
import { BLOCK_SCHEMA, DESIGN_SCHEMA, factViolations, ICONS, type FactAllowance } from '../website/design.ts';

export const USE_CASES = [
  'conversation.intent.classify',
  'conversation.owner.assistant',
  'website.initial.design',
  'website.edit.simple',
  'website.edit.complex',
  'website.image.generate',
  'social.facebook.post.compose',
  'social.facebook.image.generate',
  'engagement.facebook.comment.classify',
  'engagement.google.review.classify',
  'engagement.facebook.comment.reply',
  'engagement.google.review.reply',
  'marketing.campaign.plan',
  'marketing.campaign.creatives',
  'business.insights.generate',
  'editorial.calendar.suggest',
] as const;
export type UseCaseId = (typeof USE_CASES)[number];

const str = (max: number, min = 1): JsonSchema => ({ type: 'string', minLength: min, maxLength: max });
const nstr = (max: number): JsonSchema => ({ type: ['string', 'null'], maxLength: max });

// ------------------------------------------------------------------ web: edición (parche tipado)

export const EDIT_FIELDS = ['heading', 'subheading', 'body', 'cta_label', 'cta_action', 'tone', 'variant'] as const;
export const THEME_FIELDS = ['palette.primary', 'palette.secondary', 'palette.accent', 'palette.background', 'palette.surface', 'palette.text', 'heading_font', 'body_font', 'radius', 'density', 'mood'] as const;
export const FACT_FIELDS = ['hours', 'address', 'email', 'line', 'about'] as const;

export const EDIT_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['summary', 'operations', 'needs_clarification'],
  properties: {
    summary: str(240),
    needs_clarification: nstr(240),
    operations: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object', additionalProperties: false,
        required: ['op', 'block_index', 'field', 'theme_field', 'fact_field', 'value', 'block', 'items', 'to_index'],
        properties: {
          op: { type: 'string', enum: ['set_block_field', 'set_theme', 'set_fact', 'add_block', 'remove_block', 'move_block', 'set_items'] },
          block_index: { type: ['integer', 'null'], minimum: 0, maximum: 9 },
          field: { type: ['string', 'null'], enum: [...EDIT_FIELDS, null] },
          theme_field: { type: ['string', 'null'], enum: [...THEME_FIELDS, null] },
          fact_field: { type: ['string', 'null'], enum: [...FACT_FIELDS, null] },
          value: nstr(700),
          block: { ...BLOCK_SCHEMA, type: ['object', 'null'] },
          items: {
            type: ['array', 'null'], maxItems: 8,
            items: {
              type: 'object', additionalProperties: false, required: ['title', 'text', 'icon'],
              properties: { title: str(80), text: str(280, 0), icon: { type: ['string', 'null'], enum: [...ICONS, null] } },
            },
          },
          to_index: { type: ['integer', 'null'], minimum: 0, maximum: 9 },
        },
      },
    },
  },
};

export interface EditOperation {
  op: 'set_block_field' | 'set_theme' | 'set_fact' | 'add_block' | 'remove_block' | 'move_block' | 'set_items';
  block_index: number | null;
  field: (typeof EDIT_FIELDS)[number] | null;
  theme_field: (typeof THEME_FIELDS)[number] | null;
  fact_field: (typeof FACT_FIELDS)[number] | null;
  value: string | null;
  block: Record<string, unknown> | null;
  items: Array<{ title: string; text: string; icon: string | null }> | null;
  to_index: number | null;
}
export interface EditOutput { summary: string; needs_clarification: string | null; operations: EditOperation[] }

// ------------------------------------------------------------------ social

export const COMPOSE_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['variants', 'image', 'suggested_slot', 'warnings'],
  properties: {
    variants: {
      type: 'array', minItems: 2, maxItems: 3,
      items: {
        type: 'object', additionalProperties: false, required: ['angle', 'text', 'cta', 'hashtags'],
        properties: {
          angle: str(80), text: str(700, 20), cta: str(60),
          hashtags: { type: 'array', maxItems: 4, items: { type: 'string', pattern: '^#[\\p{L}\\p{N}_]{2,30}$' } },
        },
      },
    },
    image: {
      type: ['object', 'null'], additionalProperties: false, required: ['subject', 'style', 'alt'],
      properties: { subject: str(400, 10), style: str(200, 3), alt: str(140, 5) },
    },
    suggested_slot: {
      type: ['object', 'null'], additionalProperties: false, required: ['weekday', 'hour', 'why'],
      properties: {
        weekday: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
        hour: { type: 'integer', minimum: 7, maximum: 21 }, why: str(160),
      },
    },
    warnings: { type: 'array', maxItems: 4, items: str(200) },
  },
};
export interface ComposeOutput {
  variants: Array<{ angle: string; text: string; cta: string; hashtags: string[] }>;
  image: { subject: string; style: string; alt: string } | null;
  suggested_slot: { weekday: string; hour: number; why: string } | null;
  warnings: string[];
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
export function emojiCount(text: string): number {
  return (text.match(EMOJI_RE) ?? []).length;
}

// ------------------------------------------------------------------ atención

export const REPLY_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['reply', 'facts_used', 'needs_human', 'reason'],
  properties: {
    reply: str(600, 5),
    facts_used: { type: 'array', maxItems: 6, items: { type: 'string', enum: ['name', 'phone', 'address', 'hours', 'services', 'none'] } },
    needs_human: { type: 'boolean' },
    reason: nstr(200),
  },
};
export interface ReplyOutput { reply: string; facts_used: string[]; needs_human: boolean; reason: string | null }

// ------------------------------------------------------------------ asistente

export const ASSISTANT_TOOLS = ['account_status', 'website_status', 'social_posts', 'attention_cases', 'activity_metrics', 'connections_status', 'brand_facts'] as const;
export const ASSISTANT_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['answer', 'evidence', 'suggested_action'],
  properties: {
    answer: str(1400, 2),
    evidence: {
      type: 'array', maxItems: 6,
      items: { type: 'object', additionalProperties: false, required: ['tool', 'summary'], properties: { tool: { type: 'string', enum: [...ASSISTANT_TOOLS] }, summary: str(200) } },
    },
    suggested_action: { type: 'string', enum: ['none', 'open_page', 'review_pending', 'review_cases', 'create_post', 'plan_campaign', 'edit_brand'] },
  },
};
export interface AssistantOutput { answer: string; evidence: Array<{ tool: string; summary: string }>; suggested_action: string }

// ------------------------------------------------------------------ marketing e insights

export const CAMPAIGN_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['name', 'objective', 'audience', 'channels', 'duration_days', 'budget', 'creatives', 'kpis', 'risks', 'requires_authorization'],
  properties: {
    name: str(80),
    objective: { type: 'string', enum: ['awareness', 'visits', 'messages', 'sales'] },
    audience: {
      type: 'object', additionalProperties: false, required: ['description', 'location', 'interests'],
      properties: { description: str(300), location: str(120), interests: { type: 'array', maxItems: 6, items: str(40) } },
    },
    channels: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['facebook_post', 'facebook_ads'] } },
    duration_days: { type: 'integer', minimum: 1, maximum: 60 },
    budget: {
      type: 'object', additionalProperties: false, required: ['proposed_total_mxn', 'rationale'],
      properties: { proposed_total_mxn: { type: ['number', 'null'], minimum: 0, maximum: 100000 }, rationale: str(300) },
    },
    creatives: {
      type: 'array', minItems: 1, maxItems: 3,
      items: {
        type: 'object', additionalProperties: false, required: ['headline', 'primary_text', 'cta', 'image_subject', 'image_alt'],
        properties: { headline: str(60), primary_text: str(400), cta: str(40), image_subject: nstr(300), image_alt: nstr(140) },
      },
    },
    kpis: { type: 'array', minItems: 1, maxItems: 4, items: str(120) },
    risks: { type: 'array', maxItems: 4, items: str(160) },
    requires_authorization: { type: 'array', minItems: 1, maxItems: 5, items: str(160) },
  },
};
export interface CampaignOutput {
  name: string; objective: string;
  audience: { description: string; location: string; interests: string[] };
  channels: string[]; duration_days: number;
  budget: { proposed_total_mxn: number | null; rationale: string };
  creatives: Array<{ headline: string; primary_text: string; cta: string; image_subject: string | null; image_alt: string | null }>;
  kpis: string[]; risks: string[]; requires_authorization: string[];
}

/** Regla del prompt de insights: con menos días con actividad se abstiene (cifra citable). */
export const INSIGHTS_MIN_ACTIVE_DAYS = 7;

export const INSIGHTS_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['status', 'summary', 'highlights', 'recommendations', 'abstain_reason'],
  properties: {
    status: { type: 'string', enum: ['generated', 'abstained'] },
    summary: str(700),
    highlights: {
      type: 'array', maxItems: 5,
      items: { type: 'object', additionalProperties: false, required: ['label', 'value', 'metric'], properties: { label: str(80), value: str(40), metric: str(60) } },
    },
    recommendations: {
      type: 'array', maxItems: 3,
      items: { type: 'object', additionalProperties: false, required: ['title', 'why', 'metric'], properties: { title: str(100), why: str(240), metric: str(60) } },
    },
    abstain_reason: nstr(240),
  },
};
export interface InsightsOutput {
  status: 'generated' | 'abstained'; summary: string;
  highlights: Array<{ label: string; value: string; metric: string }>;
  recommendations: Array<{ title: string; why: string; metric: string }>;
  abstain_reason: string | null;
}

export const EDITORIAL_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['ideas'],
  properties: {
    ideas: {
      type: 'array', minItems: 1, maxItems: 8,
      items: {
        type: 'object', additionalProperties: false, required: ['date', 'idea', 'rationale'],
        properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, idea: str(200), rationale: str(240) },
      },
    },
  },
};
export interface EditorialOutput { ideas: Array<{ date: string; idea: string; rationale: string }> }

export const OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  'site-design/v1': DESIGN_SCHEMA,
  'site-edit/v1': EDIT_SCHEMA,
  'social-compose/v1': COMPOSE_SCHEMA,
  'engagement-reply/v1': REPLY_SCHEMA,
  'owner-assistant/v1': ASSISTANT_SCHEMA,
  'campaign-plan/v1': CAMPAIGN_SCHEMA,
  'insights/v1': INSIGHTS_SCHEMA,
  'editorial/v1': EDITORIAL_SCHEMA,
};

// ------------------------------------------------------------------ validadores de dominio

export function composeViolations(out: ComposeOutput, allowance: FactAllowance): string[] {
  const errors: string[] = [];
  out.variants.forEach((v, i) => {
    if (emojiCount(v.text) > 3) errors.push(`variants[${i}].text: más de 3 emojis`);
    if (v.hashtags.length > 4) errors.push(`variants[${i}].hashtags: más de 4`);
    if (/#\S/u.test(v.text)) errors.push(`variants[${i}].text: los hashtags van en el campo hashtags`);
  });
  errors.push(...factViolations([
    ...out.variants.flatMap((v, i) => [{ path: `variants[${i}].text`, text: v.text }, { path: `variants[${i}].cta`, text: v.cta }]),
    ...(out.image ? [{ path: 'image.subject', text: out.image.subject }, { path: 'image.alt', text: out.image.alt }] : []),
  ], allowance));
  return errors;
}

export function replyViolations(out: ReplyOutput): string[] {
  return factViolations([{ path: 'reply', text: out.reply }], { confirmedPriceStrings: [] })
    // El teléfono confirmado lo inserta el servidor; el modelo no debe escribir dígitos de contacto.
    .concat(/\b(descuento|reembolso|gratis|regalamos|compensaci[oó]n)\b/iu.test(out.reply) ? ['reply: promete una compensación comercial'] : []);
}

/** Toda cifra de la respuesta del asistente debe aparecer en la salida de alguna herramienta. */
export function untracedNumbers(answer: string, toolOutputs: unknown[]): string[] {
  const haystack = JSON.stringify(toolOutputs);
  const numbers = answer.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return [...new Set(numbers)].filter((n) => {
    const variants = [n, n.replace(',', '.'), n.replace('.', ',')];
    return !variants.some((v) => haystack.includes(v));
  });
}
