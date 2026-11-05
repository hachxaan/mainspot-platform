/**
 * Tarjetas de Telegram: lo que Telegram rechazaría (callback_data > 64 bytes) o lo que un cliente podría inyectar
 * (HTML en una reseña) nunca sale del servidor, y toda acción de un botón vuelve a leerse igual. Los botones con el id
 * de un caso (anteriores a los avisos con código) se reconocen solo para no decidir con ellos (SEC-TG-APPROVAL-01).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MAX_ACTION_BYTES } from '../../src/channels/types.ts';
import { caseResolvedMessage, encodeAction, parseAction, proposalMessage, type TelegramAction } from '../../src/engagement/telegram-ui.ts';
import type { CaseRow } from '../../src/engagement/service.ts';
import type { ActionProposalRow } from '../../src/conversation/repositories.ts';

const caseId = `case_${randomUUID().replace(/-/g, '')}`;
const proposalId = `prop_${randomUUID()}`;

test('cada acción de botón cabe en callback_data y se lee de vuelta igual; lo demás no es una acción', () => {
  const actions: TelegramAction[] = [
    ...(['confirm', 'publish', 'discard', 'view'] as const).map((op) => ({ kind: 'proposal' as const, op, id: proposalId })),
    { kind: 'case', op: 'view', id: caseId },
    { kind: 'lab', on: true }, { kind: 'lab', on: false }, { kind: 'pending' },
  ];
  for (const a of actions) {
    const data = encodeAction(a);
    assert.ok(Buffer.byteLength(data) <= MAX_ACTION_BYTES, data);
    assert.deepEqual(parseAction(data), a);
  }
  for (const bad of ['', 'pp:', 'ca:case_x:3', 'ca:case_x', 'cs:case_x:-1', 'pp:prop x', 'lab:maybe', `pp:${'a'.repeat(57)}`, '/aprobar case_x 1']) {
    assert.equal(parseAction(bad), null, bad);
  }
});

test('los botones con el id del caso (elegir, publicar, volver, no responder) solo identifican el caso: nunca son una decisión', () => {
  for (const data of [`cs:${caseId}:0`, `ca:${caseId}:2`, `cb:${caseId}`, `cr:${caseId}`]) {
    assert.deepEqual(parseAction(data), { kind: 'legacy_case', id: caseId }, data);
  }
});

test('el texto de clientes y propuestas se escapa: una reseña con HTML no se convierte en formato ni enlaces', () => {
  const c = {
    case_id: caseId, origin: 'google_review', author_label: '<b>Ana</b>', body: 'Mal <a href="https://phish.example">aquí</a> & <script>x</script>',
    rating: 1, reason: 'category_not_safe', state: 'responded', drafts: ['Hola <i>Ana</i>', 'Gracias & disculpa', 'Escríbenos'], response_text: 'Hola <i>Ana</i>',
  } as unknown as CaseRow;
  const m = caseResolvedMessage(c, { simulated: true, panelUrl: 'https://app.example/panel' });
  assert.doesNotMatch(m.html, /<script|<a href="https:\/\/phish|<b>Ana<\/b>|<i>Ana<\/i>/);
  assert.match(m.html, /&lt;a href="https:\/\/phish\.example"&gt;/);
  const p = { proposal_id: proposalId, status: 'awaiting_confirmation', summary: 'Horario <b>nuevo</b>', detail: { diff_sentences: ['Abre <img src=x>'] } } as unknown as ActionProposalRow;
  assert.match(proposalMessage(p, { panelUrl: 'https://app.example/panel' }).html, /Abre &lt;img src=x&gt;/);
});
