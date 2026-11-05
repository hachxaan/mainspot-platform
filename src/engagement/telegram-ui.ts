/**
 * Mensajes de MainSpot en Telegram: tarjetas legibles con botones en línea.
 *
 * La persona solo escribe lenguaje natural; preparar la vista previa, publicar o descartar un cambio de la web, el
 * laboratorio y ver pendientes son botones. Cada botón lleva una acción compacta (`callback_data` ≤ 64 bytes) con el id
 * completo del objeto; quien la recibe vuelve a comprobar chat vinculado, negocio, persona, rol y estado (nunca confía
 * en el botón). Las respuestas públicas a clientes se deciden con el código de un aviso concreto (SEC-TG-APPROVAL-01,
 * `notice-offer.ts`), nunca con el id del caso. Todo dato variable (reseñas, resúmenes, borradores) se escapa: el texto
 * de un cliente nunca es HTML.
 */

import { escapeHtml as esc, MAX_ACTION_BYTES, type ChannelButton, type OutgoingMessage } from '../channels/types.ts';
import type { ActionProposalRow } from '../conversation/repositories.ts';
import type { CaseRow } from './service.ts';
import type { SocialPostRow } from '../social/service.ts';

// ------------------------------------------------------------------------------------------- acciones

export type TelegramAction =
  | { kind: 'proposal'; op: 'confirm' | 'publish' | 'discard' | 'view'; id: string }
  | { kind: 'case'; op: 'view'; id: string }
  | { kind: 'lab'; on: boolean }
  | { kind: 'pending' }
  /** Publicación de Facebook: ofrecer (id = solicitud del chat), elegir variante (id = job), decidir (id = post). */
  | { kind: 'social'; op: 'offer'; id: string; image: boolean }
  | { kind: 'social'; op: 'decline' | 'drop' | 'publish' | 'schedule' | 'discard'; id: string }
  | { kind: 'social'; op: 'pick'; id: string; variant: number }
  | { kind: 'social'; op: 'hint' };

/**
 * Botón con el id de un caso para elegir, publicar, volver o no responder (`cs`/`ca`/`cb`/`cr`), de mensajes anteriores
 * a los avisos con código. Ya no decide nada: solo identifica el caso para mostrar su estado real o reenviar su aviso
 * vigente (SEC-TG-APPROVAL-01).
 */
export interface LegacyCaseButton { kind: 'legacy_case'; id: string }

const PROPOSAL_OPS = { pc: 'confirm', pp: 'publish', pd: 'discard', pv: 'view' } as const;
const SOCIAL_OPS = { sn: 'decline', sx: 'drop', sp: 'publish', ss: 'schedule', sd: 'discard' } as const;
const ID = '[A-Za-z0-9_-]{1,56}';

function prefixOf<T extends Record<string, string>>(map: T, op: string): string {
  return Object.keys(map).find((k) => map[k] === op) ?? '';
}

export function encodeAction(a: TelegramAction): string {
  let data: string;
  if (a.kind === 'proposal') data = `${prefixOf(PROPOSAL_OPS, a.op)}:${a.id}`;
  else if (a.kind === 'case') data = `cv:${a.id}`;
  else if (a.kind === 'lab') data = a.on ? 'lab:on' : 'lab:off';
  else if (a.kind === 'social' && a.op === 'offer') data = `${a.image ? 'si' : 'so'}:${a.id}`;
  else if (a.kind === 'social' && a.op === 'pick') data = `sv:${a.id}:${a.variant}`;
  else if (a.kind === 'social' && a.op === 'hint') data = 'sh';
  else if (a.kind === 'social') data = `${prefixOf(SOCIAL_OPS, a.op)}:${a.id}`;
  else data = 'pend';
  if (Buffer.byteLength(data) > MAX_ACTION_BYTES) throw new Error(`telegram action too long (${data.length})`);
  return data;
}

/** Acción de un botón pulsado; null si no es una acción válida de MainSpot. */
export function parseAction(data: string): TelegramAction | LegacyCaseButton | null {
  if (data === 'pend') return { kind: 'pending' };
  if (data === 'lab:on' || data === 'lab:off') return { kind: 'lab', on: data === 'lab:on' };
  if (data === 'sh') return { kind: 'social', op: 'hint' };
  let m = new RegExp(`^(pc|pp|pd|pv):(${ID})$`).exec(data);
  if (m) return { kind: 'proposal', op: PROPOSAL_OPS[m[1] as keyof typeof PROPOSAL_OPS], id: m[2]! };
  m = new RegExp(`^cv:(${ID})$`).exec(data);
  if (m) return { kind: 'case', op: 'view', id: m[1]! };
  m = new RegExp(`^(?:(?:cs|ca):(${ID}):[0-2]|(?:cb|cr):(${ID}))$`).exec(data);
  if (m) return { kind: 'legacy_case', id: (m[1] ?? m[2])! };
  m = new RegExp(`^(so|si):(${ID})$`).exec(data);
  if (m) return { kind: 'social', op: 'offer', id: m[2]!, image: m[1] === 'si' };
  m = new RegExp(`^sv:(${ID}):([0-4])$`).exec(data);
  if (m) return { kind: 'social', op: 'pick', id: m[1]!, variant: Number(m[2]) };
  m = new RegExp(`^(sn|sx|sp|ss|sd):(${ID})$`).exec(data);
  if (m) return { kind: 'social', op: SOCIAL_OPS[m[1] as keyof typeof SOCIAL_OPS], id: m[2]! };
  return null;
}

const button = (label: string, action: TelegramAction): ChannelButton => ({ label, action: encodeAction(action) });

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// ------------------------------------------------------------------------------------- generales

export function linkedMessage(): OutgoingMessage {
  return {
    html: '✅ <b>Listo, este chat ya está conectado a MainSpot.</b>\n\nAquí te aviso cuando un cliente necesite tu decisión y puedes escribirme, con tus palabras, lo que quieres cambiar en tu página o preguntarme por tu negocio. Para decidir solo tendrás que tocar un botón.',
    buttons: [[button('📋 Ver pendientes', { kind: 'pending' })]],
  };
}

export function unlinkedMessage(): OutgoingMessage {
  return { html: 'Este chat no está conectado a MainSpot. En tu panel elige <b>Conectar Telegram</b> y toca <b>Abrir Telegram</b>.' };
}

export function invalidCodeMessage(): OutgoingMessage {
  return { html: 'El enlace de conexión ya no es válido o caducó. En tu panel elige <b>Conectar Telegram</b> para generar uno nuevo.' };
}

export interface LabState { available: boolean; active: boolean }

export function helpMessage(lab: LabState, opts: { social?: boolean } = {}): OutgoingMessage {
  const rows: ChannelButton[][] = [[button('📋 Ver pendientes', { kind: 'pending' })]];
  if (opts.social) rows.push([button('📣 Publicar en Facebook', { kind: 'social', op: 'hint' })]);
  if (lab.active) rows.push([button('🧪 Dejar el laboratorio de IA', { kind: 'lab', on: false })]);
  else if (lab.available) rows.push([button('🧪 Usar el laboratorio de IA', { kind: 'lab', on: true })]);
  const social = opts.social ? '\n• «Publica en Facebook que hoy hay 2x1 en tacos de 1 a 5 pm»' : '';
  return {
    html: `👋 <b>¿En qué te ayudo?</b>\n\nEscríbeme con tus palabras, por ejemplo:\n• «Cambia el horario a 9:00 a 18:00»\n• «Agrega una imagen de pan recién horneado en la portada»${social}\n• «¿Cuál es mi teléfono en la página?»\n\nCuando prepare un cambio o un cliente necesite respuesta, te lo enseño aquí con botones para decidir.`,
    buttons: rows,
  };
}

// -------------------------------------------------------------------------------- cambios en la web

function sentencesOf(p: ActionProposalRow): string[] {
  const diff = p.detail?.['diff_sentences'];
  const list = Array.isArray(diff) ? diff.filter((s): s is string => typeof s === 'string' && s.trim() !== '' && s !== p.summary) : [];
  return list.slice(0, 6).map((s) => clip(s, 200));
}

function bullets(p: ActionProposalRow): string {
  const list = sentencesOf(p);
  return list.length ? list.map((s) => `• ${esc(s)}`).join('\n') : `• ${esc(clip(p.summary, 300))}`;
}

/** Rutas de IA en borrador (laboratorio) usadas para preparar la propuesta. */
export function labLine(models: string[]): string {
  return models.length ? `\n\n🧪 <i>Preparado con IA de laboratorio (ruta en borrador · ${esc(models.join(', '))}).</i>` : '';
}

function proposalLabModels(p: ActionProposalRow): string[] {
  const ai = p.detail?.['ai'];
  const raw = ai && typeof ai === 'object' && 'routes' in ai && Array.isArray(ai.routes) ? ai.routes : [];
  const routes = raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  if (!routes.some((r) => r['status'] === 'DRAFT' || r['status'] === 'TESTED' || r['assignment'] === 'manual_lab')) return [];
  return routes.map((r) => String(r['model_id'] ?? '').replace(/^[a-z]+:/, '')).filter(Boolean);
}

/** Tarjeta de una propuesta web según su estado: lo que la persona puede hacer ahora, con botones. */
export function proposalMessage(p: ActionProposalRow, ctx: { panelUrl: string }): OutgoingMessage {
  const id = p.proposal_id;
  switch (p.status) {
    case 'drafted':
    case 'awaiting_confirmation':
      return {
        html: `📝 <b>Cambio para tu página</b>\n\n${bullets(p)}\n\nAntes de publicarlo te enseño cómo queda.`,
        buttons: [[button('👀 Ver cómo queda', { kind: 'proposal', op: 'confirm', id })], [button('✖️ Cancelar', { kind: 'proposal', op: 'discard', id })]],
      };
    case 'confirmed':
    case 'preview_ready':
    case 'approved_for_publish':
      return {
        html: `👀 <b>Así quedará tu página</b>\n\n${bullets(p)}${labLine(proposalLabModels(p))}\n\n<a href="${esc(`${ctx.panelUrl}#/vista-previa/${id}`)}">Abrir la vista previa en el panel</a>\n\n¿Lo publico?`,
        buttons: [[button('🚀 Publicar', { kind: 'proposal', op: 'publish', id })], [button('🗑 Descartar', { kind: 'proposal', op: 'discard', id })]],
      };
    case 'published':
      return { html: `✅ <b>Publicado</b>\n\n${bullets(p)}\n\nTu página ya muestra el cambio${p.published_version ? ` (versión ${p.published_version})` : ''}.` };
    case 'rejected':
      return { html: `🗑 <b>Cambio descartado</b>\n\n${bullets(p)}\n\nTu página no cambió.` };
    case 'failed':
      return { html: `⚠️ <b>No se pudo publicar</b>\n\n${bullets(p)}\n\nTu página no cambió. Puedes pedírmelo de nuevo.` };
    default:
      return { html: `ℹ️ <b>Este cambio ya no está pendiente</b>\n\n${bullets(p)}` };
  }
}

export function aiEditStartedMessage(models: string[]): OutgoingMessage {
  return { html: `⏳ <b>Estoy preparando tu cambio con IA.</b>\nTe aviso aquí en cuanto puedas verlo.${labLine(models)}` };
}

// ------------------------------------------------------------------------ atención a clientes (casos)

function caseOrigin(c: CaseRow): { title: string; provider: string; kind: string } {
  return c.origin === 'google_review'
    ? { title: 'Reseña de Google', provider: 'Google', kind: 'Reseña' }
    : { title: 'Comentario en Facebook', provider: 'Facebook', kind: 'Comentario' };
}

function stars(rating: number | null): string {
  if (!rating || rating < 1 || rating > 5) return '';
  return `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} `;
}

function caseHeader(c: CaseRow): string {
  const o = caseOrigin(c);
  return `${stars(c.rating)}<b>${o.title}</b> · ${esc(clip(c.author_label, 60))}\n<blockquote>${esc(clip(c.body, 300))}</blockquote>`;
}

/** Contexto de las tarjetas de casos: si las respuestas son simuladas y dónde está el panel. */
export interface CaseContext { simulated: boolean; panelUrl: string }

/** Caso ya decidido: qué pasó (sin botones). */
export function caseResolvedMessage(c: CaseRow, ctx: CaseContext): OutgoingMessage {
  const o = caseOrigin(c);
  const sim = ctx.simulated ? ' <i>(simulación: no se publicó nada en ' + o.provider + ')</i>' : '';
  const head = caseHeader(c);
  switch (c.state) {
    case 'responded':
      return { html: `${head}\n✅ <b>Respuesta publicada</b>${sim}\n<blockquote>${esc(clip(c.response_text ?? '', 1500))}</blockquote>` };
    case 'approved':
    case 'responding':
    case 'retry_pending':
      return { html: `${head}\n⏳ <b>Respuesta aprobada.</b> La publicaremos en cuanto ${o.provider} responda; si falla te aviso aquí.${sim}` };
    case 'rejected':
      return { html: `${head}\n🙅 <b>Sin respuesta.</b> El caso queda registrado y no se publica nada.` };
    case 'closed_elsewhere':
      return { html: `${head}\nℹ️ Ya se respondió por otro camino; no se publica una segunda respuesta.` };
    default:
      return { html: `${head}\nℹ️ Este caso ya no necesita tu decisión.` };
  }
}

// ---------------------------------------------------------------------------------------- pendientes

export interface PendingItem {
  label: string;
  action: TelegramAction;
}

export function pendingProposalItem(p: ActionProposalRow): PendingItem {
  const verb = p.status === 'awaiting_confirmation' || p.status === 'drafted' ? '📝' : '👀';
  return { label: `${verb} ${clip(p.summary, 48)}`, action: { kind: 'proposal', op: 'view', id: p.proposal_id } };
}

export function pendingCaseItem(c: CaseRow): PendingItem {
  return { label: `${c.origin === 'google_review' ? '⭐' : '💬'} ${caseOrigin(c).kind} de ${clip(c.author_label, 32)}`, action: { kind: 'case', op: 'view', id: c.case_id } };
}

/** Lista de pendientes como botones; `intro` explica por qué se muestra (p. ej. una decisión escrita suelta). */
export function pendingMessage(items: PendingItem[], intro?: string): OutgoingMessage {
  const lead = intro ? `${esc(intro)}\n\n` : '';
  if (!items.length) return { html: `${lead}✅ <b>No tienes nada pendiente.</b>\nEscríbeme lo que necesites cambiar o consultar.` };
  return {
    html: `${lead}📋 <b>Pendientes de tu decisión</b>\nToca uno para verlo:`,
    buttons: items.map((it) => [button(it.label, it.action)]),
  };
}

/** Respuesta en texto con los pendientes debajo (cuando no se entendió el mensaje o era una decisión suelta). */
export function answerWithPending(text: string, items: PendingItem[]): OutgoingMessage {
  if (!items.length) return { html: esc(text) };
  return {
    html: `${esc(text)}\n\n📋 <b>Si querías decidir algo pendiente</b>, tócalo aquí:`,
    buttons: items.map((it) => [button(it.label, it.action)]),
  };
}

// ------------------------------------------------------------------------------ publicaciones de Facebook

/** Datos de la Página conectada para las tarjetas (null = sin Página conectada). */
export interface SocialContext { pageName: string | null }

function pageNote(ctx: SocialContext): string {
  return ctx.pageName
    ? `Se publicará en tu Página <b>${esc(clip(ctx.pageName, 80))}</b>.`
    : 'Tu Página de Facebook todavía no está conectada: puedes prepararla, pero para publicarla conéctala en tu panel.';
}

export function socialHintMessage(): OutgoingMessage {
  return { html: '📣 <b>Publicar en Facebook</b>\n\nEscríbeme qué quieres publicar, por ejemplo: «Publica en Facebook que hoy hay 2x1 en tacos de 1 a 5 pm». Te preparo propuestas y nada se publica sin que lo apruebes.' };
}

/** Mensaje del chat que pide una publicación: se ofrece prepararla (el botón es la confirmación de la persona). */
export function socialOfferMessage(requestId: string, ctx: SocialContext): OutgoingMessage {
  return {
    html: `📣 <b>¿Preparo esta publicación para Facebook?</b>\n\nRedacto propuestas con IA a partir de tu mensaje y te las enseño aquí para que elijas. Nada se publica sin que lo apruebes.\n${pageNote(ctx)}`,
    buttons: [
      [button('📣 Prepararla', { kind: 'social', op: 'offer', id: requestId, image: false })],
      [button('🖼 Prepararla con imagen', { kind: 'social', op: 'offer', id: requestId, image: true })],
      [button('No, gracias', { kind: 'social', op: 'decline', id: requestId })],
    ],
  };
}

export function socialDeclinedMessage(): OutgoingMessage {
  return { html: 'De acuerdo, no preparo ninguna publicación.' };
}

export function socialComposingMessage(withImage: boolean, models: string[]): OutgoingMessage {
  return { html: `⏳ <b>Estoy redactando tus propuestas${withImage ? ' y la imagen' : ''}.</b>\nTe las enseño aquí en cuanto estén.${labLine(models)}` };
}

export interface ComposeResultView {
  variants: Array<{ text: string; hashtags: string[]; duplicate_of?: string | null }>;
  image: { asset_id?: string; alt?: string; status?: string } | null;
  warnings: string[];
  simulated?: boolean;
}

/** Propuestas redactadas: cada variante con su botón; la imagen generada se avisa (se publica con su etiqueta). */
export function socialVariantsMessage(jobId: string, result: ComposeResultView, ctx: SocialContext): OutgoingMessage {
  const variants = result.variants.slice(0, 5);
  const body = variants.map((v, i) => {
    const tags = v.hashtags.length ? `\n<i>${esc(v.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' '))}</i>` : '';
    const dup = v.duplicate_of ? '\n⚠️ <i>Se parece a una publicación reciente.</i>' : '';
    return `<b>${i + 1}.</b> ${esc(clip(v.text, 700))}${tags}${dup}`;
  }).join('\n\n');
  const image = result.image?.asset_id
    ? `\n\n🖼 Con una imagen generada con IA${result.image.alt ? ` («${esc(clip(result.image.alt, 120))}»)` : ''}; se publica con el aviso «Imagen generada con IA.».`
    : result.image ? '\n\n🖼 No pude generar la imagen; puedes publicar solo el texto.' : '';
  const warnings = result.warnings.length ? `\n\n${result.warnings.slice(0, 3).map((w) => `⚠️ <i>${esc(clip(w, 200))}</i>`).join('\n')}` : '';
  const sim = result.simulated ? '\n\n🧪 <i>Texto de prueba (IA simulada).</i>' : '';
  return {
    html: `📣 <b>Propuestas para Facebook</b>\n\n${body}${image}${warnings}${sim}\n\n${pageNote(ctx)}`,
    buttons: [
      ...variants.map((_, i) => [button(variants.length === 1 ? '✍️ Usar esta' : `✍️ Usar la ${i + 1}`, { kind: 'social', op: 'pick', id: jobId, variant: i })]),
      [button('🗑 Descartar', { kind: 'social', op: 'drop', id: jobId })],
    ],
  };
}

export function socialDroppedMessage(): OutgoingMessage {
  return { html: '🗑 Descarté estas propuestas. Escríbeme si quieres preparar otra publicación.' };
}

/** Enlace público a una publicación de una Page (`<page>_<post>`); null si no es una referencia real. */
function postUrl(externalRef: string | null): string | null {
  const m = externalRef ? /^(\d+)_(\d+)$/.exec(externalRef) : null;
  return m ? `https://www.facebook.com/${m[1]}/posts/${m[2]}` : null;
}

/** Tarjeta de una publicación según su estado: qué puede decidir la persona ahora o qué pasó. */
export function socialPostMessage(post: SocialPostRow, ctx: SocialContext & { slotLabel: string | null; scheduledLabel: string | null }): OutgoingMessage {
  const text = `<blockquote>${esc(clip(post.text, 1500))}</blockquote>`;
  const image = post.media_asset_id ? '\n🖼 Con imagen.' : '';
  switch (post.status) {
    case 'draft': {
      const rows: ChannelButton[][] = [];
      if (ctx.pageName) {
        rows.push([button('🚀 Publicar ahora', { kind: 'social', op: 'publish', id: post.post_id })]);
        if (ctx.slotLabel) rows.push([button(`🕘 Programar: ${ctx.slotLabel}`, { kind: 'social', op: 'schedule', id: post.post_id })]);
      }
      rows.push([button('🗑 Descartar', { kind: 'social', op: 'discard', id: post.post_id })]);
      return { html: `📣 <b>Así se publicará en Facebook</b>\n${text}${image}\n${pageNote(ctx)}`, buttons: rows };
    }
    case 'awaiting_approval':
    case 'scheduled':
      return {
        html: ctx.scheduledLabel
          ? `🕘 <b>Programada para ${esc(ctx.scheduledLabel)}</b>\n${text}${image}\nTe aviso aquí cuando Facebook la confirme.`
          : `⏳ <b>Enviando a Facebook…</b>\n${text}${image}\nTe aviso aquí en cuanto Facebook la confirme.`,
      };
    case 'published': {
      const url = postUrl(post.external_ref);
      return { html: `✅ <b>Publicado en Facebook</b>${ctx.pageName ? ` · ${esc(clip(ctx.pageName, 80))}` : ''}\n${text}${image}${url ? `\n<a href="${esc(url)}">Ver la publicación</a>` : ''}` };
    }
    case 'rejected':
      return { html: `🗑 <b>Publicación descartada.</b> No se publicó nada.\n${text}` };
    default:
      return { html: `⚠️ <b>No se pudo confirmar la publicación en Facebook.</b> Revísala en tu panel antes de intentarlo de nuevo.\n${text}` };
  }
}

// ---------------------------------------------------------------------------------------- laboratorio

export function labOnMessage(untilUtc: string, models: string[]): OutgoingMessage {
  return {
    html: `🧪 <b>Laboratorio de IA activado</b> hasta las ${esc(untilUtc)} UTC.\nLos cambios que necesiten IA usarán rutas en borrador${models.length ? ` (${esc(models.join(', '))})` : ''}.`,
    buttons: [[button('Dejar el laboratorio', { kind: 'lab', on: false })]],
  };
}

export function labOffMessage(): OutgoingMessage {
  return { html: 'Dejaste el laboratorio de IA: los cambios usarán solo la IA activa de tu cuenta.' };
}

export function labNoneMessage(): OutgoingMessage {
  return { html: 'No tienes una autorización de laboratorio de IA vigente. El equipo de MainSpot la emite desde su consola.' };
}

/** La autorización elegida dejó de valer: se explica y, si hay otra vigente, se ofrece con un botón. */
export function labInvalidMessage(reason: string, anotherAvailable: boolean): OutgoingMessage {
  return {
    html: `${esc(reason)}\nDejé de usar esa autorización; vuelve a pedirme el cambio cuando quieras.`,
    buttons: anotherAvailable ? [[button('🧪 Usar otra autorización vigente', { kind: 'lab', on: true })]] : [],
  };
}
