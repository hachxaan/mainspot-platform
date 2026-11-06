/**
 * Tarjetas de Telegram: lo que Telegram rechazaría (callback_data > 64 bytes) o lo que un cliente podría inyectar
 * (HTML en una reseña) nunca sale del servidor, y toda acción de un botón vuelve a leerse igual. Los botones de un aviso
 * llevan su código y el número de opción (SEC-TG-APPROVAL-01); los que llevaban el id de un caso se reconocen solo para
 * no decidir con ellos; publicar o programar una publicación lleva la huella de lo que mostró su tarjeta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { htmlToPlain, MAX_ACTION_BYTES } from '../../src/channels/types.ts';
import { newNoticeCode } from '../../src/engagement/notice-offer.ts';
import {
  caseResolvedMessage, encodeAction, noticeConfirmMessage, noticeMessage, parseAction, postShownRef, proposalMessage, socialPostMessage,
  type TelegramAction,
} from '../../src/engagement/telegram-ui.ts';
import type { CaseRow } from '../../src/engagement/service.ts';
import type { ActionProposalRow } from '../../src/conversation/repositories.ts';
import type { SocialPostRow } from '../../src/social/service.ts';

const caseId = `case_${randomUUID().replace(/-/g, '')}`;
const proposalId = `prop_${randomUUID()}`;
const postId = `post_${randomUUID()}`;
const code = newNoticeCode();
const ctx = { simulated: true, panelUrl: 'https://app.example/panel' };

test('cada acción de botón cabe en callback_data y se lee de vuelta igual; lo demás no es una acción', () => {
  const ref = postShownRef({ text: 'Hoy 2x1', media_asset_id: null, image_url: null }, 'Taquería');
  const actions: TelegramAction[] = [
    ...(['confirm', 'publish', 'discard', 'view'] as const).map((op) => ({ kind: 'proposal' as const, op, id: proposalId })),
    { kind: 'case', op: 'view', id: caseId },
    ...[1, 2, 3].flatMap((option) => [{ kind: 'notice' as const, op: 'pick' as const, code, option }, { kind: 'notice' as const, op: 'approve' as const, code, option }]),
    { kind: 'notice', op: 'back', code }, { kind: 'notice', op: 'reject', code },
    { kind: 'lab', on: true }, { kind: 'lab', on: false }, { kind: 'pending' },
    // Publicaciones: ids reales más largos (solicitud del chat, job de IA, publicación).
    { kind: 'social', op: 'offer', id: `tg_${randomUUID()}`, image: true }, { kind: 'social', op: 'offer', id: 'tg_83549212', image: false },
    { kind: 'social', op: 'decline', id: `tg_${randomUUID()}` }, { kind: 'social', op: 'pick', id: `job_${randomUUID()}`, variant: 2 },
    { kind: 'social', op: 'drop', id: `job_${randomUUID()}` }, { kind: 'social', op: 'hint' },
    { kind: 'social', op: 'publish', id: postId, ref }, { kind: 'social', op: 'schedule', id: postId, ref }, { kind: 'social', op: 'discard', id: postId },
  ];
  for (const a of actions) {
    const data = encodeAction(a);
    assert.ok(Buffer.byteLength(data) <= MAX_ACTION_BYTES, data);
    assert.deepEqual(parseAction(data), a);
  }
  for (const bad of ['', 'pp:', 'ca:case_x:3', 'ca:case_x', 'cs:case_x:-1', 'pp:prop x', 'lab:maybe', `pp:${'a'.repeat(57)}`, '/aprobar case_x 1', 'sv:job_x:7', 'sz:post_x',
    `na:${code}:4`, `na:${code}:0`, `na:${code}`, `np:${code.toLowerCase()}:1`, 'na:ABCDE1:1', `nr:${code}:1`, `sp:${postId}:XYZ`]) {
    assert.equal(parseAction(bad), null, bad);
  }
});

test('los botones con el id del caso (elegir, publicar, volver, no responder) solo identifican el caso: nunca son una decisión', () => {
  for (const data of [`cs:${caseId}:0`, `ca:${caseId}:2`, `cb:${caseId}`, `cr:${caseId}`]) {
    assert.deepEqual(parseAction(data), { kind: 'legacy_case', id: caseId }, data);
  }
  // Publicar o programar sin la huella de la tarjeta (formato anterior): la huella vacía no coincide con ninguna.
  assert.deepEqual(parseAction(`sp:${postId}`), { kind: 'social', op: 'publish', id: postId, ref: '' });
});

test('el aviso es el texto del servidor escapado, y cada botón lleva el código de ESE aviso y su opción, nunca el id del caso', () => {
  const c = { case_id: caseId, origin: 'google_review', author_label: 'Ana', body: 'Mal', rating: 1, state: 'needs_human', drafts: ['Uno', 'Dos <b>', ''] } as unknown as CaseRow;
  const text = `MainSpot · Caso pendiente de tu decisión · aviso ${code}\nCaso: ${caseId}\n1) Uno\n2) Dos <b>\n3) `;
  const m = noticeMessage(c, text, { code, options: c.drafts }, ctx);
  assert.equal(htmlToPlain(m.html).split('\n🧪')[0]!.trimEnd(), text.trimEnd(), 'el texto es el del aviso, sin perder ni añadir líneas');
  assert.doesNotMatch(m.html, /<b>Dos|Dos <b>/, 'el texto de las opciones va escapado');
  const actions = (m.buttons ?? []).flat().map((b) => b.action);
  assert.deepEqual(actions, [`np:${code}:1`, `np:${code}:2`, `nr:${code}`], 'una opción vacía no tiene botón');
  assert.ok(actions.every((a) => !a.includes(caseId)));
  const confirm = noticeConfirmMessage(c, { code, option: 2, text: 'Dos <b>' }, ctx);
  assert.deepEqual((confirm.buttons ?? []).flat().map((b) => b.action), [`na:${code}:2`, `nb:${code}`]);
  assert.match(confirm.html, /<blockquote>Dos &lt;b&gt;<\/blockquote>/, 'la confirmación muestra la opción completa y escapada');
});

test('publicar o programar lleva la huella de lo mostrado: otro texto, imagen, Página u hora cambian la huella', () => {
  const post = { post_id: postId, text: 'Hoy 2x1 en tacos', media_asset_id: null, image_url: null, status: 'draft', scheduled_at: null } as unknown as SocialPostRow;
  const slot = { local: '2026-11-06T18:00', label: 'vie 6 nov, 18:00' };
  const card = socialPostMessage(post, { pageName: 'Taquería', slot, scheduledLabel: null });
  const [publish, schedule] = (card.buttons ?? []).flat().map((b) => parseAction(b.action));
  assert.deepEqual(publish, { kind: 'social', op: 'publish', id: postId, ref: postShownRef(post, 'Taquería') });
  assert.deepEqual(schedule, { kind: 'social', op: 'schedule', id: postId, ref: postShownRef(post, 'Taquería', slot.local) });
  const refs = new Set([
    postShownRef(post, 'Taquería'), postShownRef({ ...post, text: 'Hoy 3x1 en tacos' }, 'Taquería'), postShownRef({ ...post, media_asset_id: 'asset_1' }, 'Taquería'),
    postShownRef(post, 'Otra Página'), postShownRef(post, 'Taquería', slot.local), postShownRef(post, 'Taquería', '2026-11-13T18:00'),
  ]);
  assert.equal(refs.size, 6);
});

test('el texto de clientes y propuestas se escapa: una reseña con HTML no se convierte en formato ni enlaces', () => {
  const c = {
    case_id: caseId, origin: 'google_review', author_label: '<b>Ana</b>', body: 'Mal <a href="https://phish.example">aquí</a> & <script>x</script>',
    rating: 1, reason: 'category_not_safe', state: 'responded', drafts: ['Hola <i>Ana</i>', 'Gracias & disculpa', 'Escríbenos'], response_text: 'Hola <i>Ana</i>',
  } as unknown as CaseRow;
  for (const m of [caseResolvedMessage(c, ctx), noticeConfirmMessage({ ...c, state: 'needs_human' }, { code, option: 1, text: 'Hola <i>Ana</i>' }, ctx)]) {
    assert.doesNotMatch(m.html, /<script|<a href="https:\/\/phish|<b>Ana<\/b>|<i>Ana<\/i>/);
    assert.match(m.html, /&lt;a href="https:\/\/phish\.example"&gt;/);
  }
  const p = { proposal_id: proposalId, status: 'awaiting_confirmation', summary: 'Horario <b>nuevo</b>', detail: { diff_sentences: ['Abre <img src=x>'] } } as unknown as ActionProposalRow;
  assert.match(proposalMessage(p, { panelUrl: 'https://app.example/panel' }).html, /Abre &lt;img src=x&gt;/);
});
