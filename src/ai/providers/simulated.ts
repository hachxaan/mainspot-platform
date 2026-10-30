/**
 * Proveedor SIMULADO determinista (API-0003, NFR-0003). Solo para regresión offline y entornos sin
 * IA real autorizada: toda invocación queda con proveedor `simulated`, costo 0 y origen `none`.
 * Nunca se presenta como generación real (la UI y las trazas lo etiquetan).
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ChatRequest, ChatResult, ImageRequest, ImageResult, ProviderAdapter } from './types.ts';

const ZERO = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, images: 0, costUsd: 0 };

function seed(text: string): number {
  return parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16);
}

function facts(values: Record<string, unknown>): Record<string, unknown> {
  const f = values['brand_facts'];
  return f && typeof f === 'object' ? (f as Record<string, unknown>) : {};
}
function factText(values: Record<string, unknown>, key: string, fallback: string): string {
  const v = facts(values)[key];
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object' && 'text' in v && typeof (v as { text: unknown }).text === 'string') return (v as { text: string }).text;
  return fallback;
}
function serviceList(values: Record<string, unknown>): string[] {
  const v = facts(values)['services'];
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : String((x as { name?: unknown })?.name ?? ''))).filter(Boolean).slice(0, 6);
  return ['Atención personalizada'];
}

const PALETTES = [
  { primary: '#8a3b12', secondary: '#c98b4a', accent: '#2f6b4f', background: '#fbf6ef', surface: '#f1e6d6', text: '#2a1c12' },
  { primary: '#1f4e79', secondary: '#4f86c6', accent: '#e0a526', background: '#f7f9fc', surface: '#e6eef8', text: '#14202e' },
  { primary: '#5b2a86', secondary: '#9d6ac7', accent: '#e86a5a', background: '#fbf8fd', surface: '#efe6f6', text: '#1f1428' },
  { primary: '#2d6a4f', secondary: '#74c69d', accent: '#d65f2b', background: '#f6fbf7', surface: '#e3f2e8', text: '#14261c' },
];
const FONTS = [['didone', 'humanist'], ['geometric', 'neo_grotesque'], ['slab', 'transitional'], ['old_style', 'rounded']] as const;
const HERO = ['split', 'overlay', 'centered'] as const;

function design(values: Record<string, unknown>): unknown {
  const name = factText(values, 'name', 'Mi negocio');
  // Sin signo: con el bit alto del hash, `>>` daría índices negativos (fuentes/tonos indefinidos).
  const s = seed(name) >>> 0;
  const palette = PALETTES[s % PALETTES.length];
  const [hf, bf] = FONTS[(s >>> 3) % FONTS.length] as readonly [string, string];
  const category = factText(values, 'category', 'negocio local');
  const services = serviceList(values);
  return {
    theme: { mood: (['calido', 'moderno', 'elegante', 'fresco'] as const)[(s >>> 5) % 4], palette, heading_font: hf, body_font: bf, radius: (['soft', 'round', 'none'] as const)[(s >>> 7) % 3], density: 'balanced' },
    seo: { title: `${name} · ${category}`.slice(0, 64), description: `${name}: ${factText(values, 'description', `${category} con atención cercana`)}`.slice(0, 158).padEnd(25, '.') },
    blocks: [
      { type: 'hero', variant: HERO[(s >>> 9) % 3], heading: name, subheading: factText(values, 'value_proposition', `Tu ${category} de confianza`), body: null, items: null, image_slot: 'hero', cta: { label: 'Cómo llegar', action: 'directions' }, tone: 'default' },
      { type: 'services', variant: 'cards', heading: 'Lo que ofrecemos', subheading: null, body: null, items: services.map((x, i) => ({ title: x, text: '', icon: (['star', 'heart', 'leaf', 'sparkles', 'check', 'gift'] as const)[i % 6] })), image_slot: null, cta: null, tone: 'default' },
      { type: 'about', variant: 'split', heading: 'Quiénes somos', subheading: null, body: factText(values, 'description', `Somos ${name}.`), items: null, image_slot: 'about', cta: null, tone: 'accent' },
      { type: 'hours', variant: 'centered', heading: 'Horario', subheading: null, body: null, items: null, image_slot: null, cta: null, tone: 'default' },
      { type: 'contact', variant: 'list', heading: 'Visítanos', subheading: null, body: null, items: null, image_slot: null, cta: { label: 'Llamar ahora', action: 'call' }, tone: 'inverted' },
    ],
    images: [
      { slot: 'hero', subject: `Ilustración del ambiente de ${category} llamado ${name}`, style: 'ilustración editorial cálida', aspect: '16:9', alt: `Ilustración de ${name}` },
      { slot: 'about', subject: `Ilustración de detalle del trabajo de ${category}`, style: 'ilustración editorial cálida', aspect: '4:3', alt: `Detalle ilustrado de ${category}` },
    ],
  };
}

function edit(values: Record<string, unknown>): unknown {
  const instruction = String(values['instruction'] ?? '').toLowerCase();
  if (/horario|abrimos|cerramos|s[aá]bado|domingo/.test(instruction)) {
    const m = /(?:a|al|de)\s+(\d{1,2}(?::\d{2})?\s*(?:a|-)\s*\d{1,2}(?::\d{2})?)/.exec(instruction);
    return { summary: 'Actualizar el horario mostrado en la página.', needs_clarification: m ? null : null, operations: [{ op: 'set_fact', block_index: null, field: null, theme_field: null, fact_field: 'hours', value: String(values['instruction'] ?? '').replace(/^.*?horario\s*(?:del?|a)?\s*/i, '').slice(0, 200) || 'Horario actualizado', block: null, items: null, to_index: null }] };
  }
  if (/color|oscuro|moderno|redise/.test(instruction)) {
    return { summary: 'Cambiar el color principal y el estilo de la portada.', needs_clarification: null, operations: [
      { op: 'set_theme', block_index: null, field: null, theme_field: 'palette.primary', fact_field: null, value: '#1f2937', block: null, items: null, to_index: null },
      { op: 'set_block_field', block_index: 0, field: 'variant', theme_field: null, fact_field: null, value: 'overlay', block: null, items: null, to_index: null },
    ] };
  }
  return { summary: 'Actualizar el título de la portada.', needs_clarification: null, operations: [{ op: 'set_block_field', block_index: 0, field: 'subheading', theme_field: null, fact_field: null, value: String(values['instruction'] ?? '').slice(0, 170), block: null, items: null, to_index: null }] };
}

function compose(values: Record<string, unknown>): unknown {
  const name = factText(values, 'name', 'nuestro negocio');
  const topic = String(values['request'] ?? 'novedades').slice(0, 120);
  return {
    variants: [
      { angle: 'Cercano', text: `¡Hola! En ${name} queremos contarte: ${topic}. Te esperamos ☕`, cta: 'Visítanos', hashtags: ['#HechoConCariño', '#Local'] },
      { angle: 'Directo', text: `${topic}. Ven a ${name} y compruébalo ✨`, cta: 'Escríbenos', hashtags: ['#Comunidad'] },
    ],
    image: { subject: `Ilustración para anunciar: ${topic}`, style: 'ilustración plana colorida', alt: `Ilustración sobre ${topic}` },
    suggested_slot: { weekday: 'fri', hour: 18, why: 'Horario de mayor actividad estimada (simulado)' },
    warnings: [],
  };
}

function reply(values: Record<string, unknown>): unknown {
  const sentiment = String(values['sentiment'] ?? 'positive');
  const author = String(values['author'] ?? '').slice(0, 40);
  if (sentiment === 'negative' || sentiment === 'mixed') {
    return { reply: `Hola ${author}, lamentamos tu experiencia. Queremos entender qué pasó; escríbenos por mensaje privado para atenderte.`, facts_used: ['none'], needs_human: true, reason: 'queja' };
  }
  return { reply: `¡Muchas gracias, ${author}! Nos alegra que te haya gustado. Te esperamos pronto.`, facts_used: ['name'], needs_human: false, reason: null };
}

function assistant(req: ChatRequest): ChatResult {
  const last = req.messages[req.messages.length - 1];
  if (last?.role === 'tool' || req.messages.some((m) => m.role === 'tool')) {
    const toolMsgs = req.messages.filter((m) => m.role === 'tool');
    const parsed = toolMsgs.map((m) => { try { return JSON.parse(m.content ?? '{}') as Record<string, unknown>; } catch { return {}; } });
    const parts: string[] = [];
    for (const p of parsed) {
      if (typeof p['count'] === 'number') parts.push(`${String(p['label'] ?? 'Registros')}: ${p['count']}`);
    }
    const answer = parts.length ? `Esto encontré en tu cuenta: ${parts.join('; ')}.` : 'Revisé tu cuenta y no encontré datos para esa pregunta.';
    const content = JSON.stringify({ answer, evidence: toolMsgs.map((m) => ({ tool: String(JSON.parse(m.content ?? '{}').tool ?? 'account_status'), summary: 'Consulta de solo lectura' })).slice(0, 6), suggested_action: 'none' });
    return { content, toolCalls: [], finishReason: 'stop', providerModel: 'simulated', generationId: null, usage: ZERO };
  }
  const q = String(req.simulation?.values['question'] ?? '').toLowerCase();
  const tools: string[] = [];
  if (/publica|post|facebook/.test(q)) tools.push('social_posts');
  if (/coment|rese|clientes|atenci/.test(q)) tools.push('attention_cases');
  if (/p[aá]gina|web|sitio/.test(q)) tools.push('website_status');
  if (/plan|cuota|l[ií]mite/.test(q)) tools.push('account_status');
  if (!tools.length) tools.push('account_status');
  return {
    content: null,
    toolCalls: tools.map((name, i) => ({ id: `sim_call_${i}`, name, arguments: JSON.stringify(name === 'social_posts' ? { period_days: 7 } : {}) })),
    finishReason: 'tool_calls', providerModel: 'simulated', generationId: null, usage: ZERO,
  };
}

function campaign(values: Record<string, unknown>): unknown {
  const name = factText(values, 'name', 'tu negocio');
  return {
    name: `Campaña de ${name}`.slice(0, 80), objective: 'visits',
    audience: { description: 'Personas que viven o trabajan cerca del negocio', location: 'Radio cercano al negocio', interests: ['comida local'] },
    channels: ['facebook_post', 'facebook_ads'], duration_days: 14,
    budget: { proposed_total_mxn: Number(values['budget_hint_mxn'] ?? 0) || null, rationale: 'Presupuesto propuesto por el dueño; requiere autorización de cuenta, importe y techo.' },
    creatives: [{ headline: `Conoce ${name}`.slice(0, 60), primary_text: 'Te esperamos con atención cercana.', cta: 'Cómo llegar', image_subject: 'Ilustración del negocio', image_alt: 'Ilustración del negocio' }],
    kpis: ['Visitas al perfil'], risks: ['Sin cuenta publicitaria conectada'], requires_authorization: ['Cuenta publicitaria', 'Importe y techo diario'],
  };
}

function insights(values: Record<string, unknown>): unknown {
  const m = (values['metrics'] ?? {}) as Record<string, unknown>;
  const days = Number(m['days_with_activity'] ?? 0);
  if (days < 7) return { status: 'abstained', summary: 'Todavía no hay suficiente actividad para sacar conclusiones.', highlights: [], recommendations: [], abstain_reason: 'Menos de 7 días con actividad' };
  return { status: 'generated', summary: `En el periodo hubo ${String(m['posts_published'] ?? 0)} publicaciones y ${String(m['cases_total'] ?? 0)} comentarios o reseñas.`, highlights: [{ label: 'Publicaciones', value: String(m['posts_published'] ?? 0), metric: 'posts_published' }], recommendations: [{ title: 'Responde los casos pendientes', why: 'Responder rápido mejora la confianza.', metric: 'cases_pending' }], abstain_reason: null };
}

function editorial(values: Record<string, unknown>): unknown {
  const start = String(values['start_date'] ?? '2026-11-02');
  const base = new Date(`${start}T12:00:00Z`);
  return { ideas: [0, 3, 7].map((d, i) => ({ date: new Date(base.getTime() + d * 86_400_000).toISOString().slice(0, 10), idea: ['Presenta a tu equipo', 'Muestra tu servicio más pedido', 'Cuenta cómo empezó tu negocio'][i], rationale: 'Basado en los hechos confirmados del negocio (simulado).' })) };
}

export class SimulatedAdapter implements ProviderAdapter {
  readonly kind = 'simulated' as const;

  async chat(req: ChatRequest): Promise<ChatResult> {
    const uc = req.simulation?.useCaseId ?? '';
    const values = req.simulation?.values ?? {};
    if (uc === 'conversation.owner.assistant') return assistant(req);
    let out: unknown;
    if (uc === 'website.initial.design') out = design(values);
    else if (uc.startsWith('website.edit')) out = edit(values);
    else if (uc === 'social.facebook.post.compose' || uc === 'marketing.campaign.creatives') out = compose(values);
    else if (uc.endsWith('.reply')) out = reply(values);
    else if (uc === 'marketing.campaign.plan') out = campaign(values);
    else if (uc === 'business.insights.generate') out = insights(values);
    else if (uc === 'editorial.calendar.suggest') out = editorial(values);
    else out = {};
    return { content: JSON.stringify(out), toolCalls: [], finishReason: 'stop', providerModel: 'simulated', generationId: null, usage: ZERO };
  }

  async image(req: ImageRequest): Promise<ImageResult> {
    const s = seed(req.prompt);
    const [w, h] = ({ '16:9': [1600, 900], '4:3': [1200, 900], '1:1': [1080, 1080], '3:4': [900, 1200], '4:5': [1080, 1350] } as const)[req.aspectRatio];
    const hue = s % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},60%,32%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.72}" cy="${h * 0.38}" r="${Math.min(w, h) * 0.22}" fill="hsla(${(hue + 180) % 360},70%,85%,.55)"/><text x="50%" y="88%" font-family="sans-serif" font-size="${Math.round(h / 22)}" fill="#fff" text-anchor="middle">Imagen simulada</text></svg>`;
    const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
    return { bytes, mediaType: 'image/png', providerModel: 'simulated', usage: { ...ZERO, images: 1 } };
  }

  async ping(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'proveedor simulado (sin red)' };
  }
}
