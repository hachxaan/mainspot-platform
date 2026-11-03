/** Controles de laboratorio del cliente real, ejecutados sin navegador ni red. No prueba calidad de IA. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

interface ClientApi {
  token(): string | null;
  setToken(value: string | null): void;
  labGrant(): string | null;
  setLabGrant(value: string | null): void;
  post(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown; error: { code: string } | null }>;
}
function client(fetchImpl: typeof fetch) {
  const storage = new Map<string, string>();
  const state = { ai: { s: { private_content: 'negocio anterior' }, jobs: { old: 'resultado anterior' }, render: { old: 'html anterior' } } };
  const context = vm.createContext({ window: { MS: state, fetch: fetchImpl, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } } });
  vm.runInContext(readFileSync(new URL('../../src/web/panel/assets/js/api.js', import.meta.url), 'utf8'), context);
  return { api: (context.window.MS as typeof state & { api: ClientApi }).api, state };
}

test('cambiar sesión elimina selección y resultados AI; una respuesta pendiente de la sesión anterior no se entrega', async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((r) => { resolve = r; });
  const { api, state } = client((async () => pending) as typeof fetch);
  api.setToken('sesion-a');
  api.setLabGrant('grant-a');
  state.ai.s.private_content = 'dato privado A';
  state.ai.jobs.old = 'borrador A';
  state.ai.render.old = 'página A';
  const request = api.post('/ai/assistant', { question: 'Estado de mi cuenta' });
  api.setToken('sesion-b');
  resolve(new Response(JSON.stringify({ answer: 'dato privado A' }), { status: 200 }));
  const result = await request;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'session_changed');
  assert.equal(result.data, null);
  assert.equal(api.labGrant(), null);
  assert.equal(state.ai.s.private_content, undefined);
  assert.equal(state.ai.jobs.old, undefined);
  assert.equal(state.ai.render.old, undefined);
});

test('rechazo de grant no repite la acción sin autorización ni borra la selección silenciosamente', async () => {
  let calls = 0;
  const grants: Array<string | null> = [];
  const { api } = client((async (_input, init) => {
    calls++;
    grants.push(new Headers(init?.headers).get('X-AI-Lab-Grant'));
    return new Response(JSON.stringify({ error: { code: 'permission_denied', message: 'Autorización revocada' } }), { status: 403 });
  }) as typeof fetch);
  api.setToken('sesion-propia');
  api.setLabGrant('grant-revocado');
  const result = await api.post('/ai/assistant', { question: 'Estado de mi cuenta' });
  assert.equal(result.status, 403);
  assert.equal(result.ok, false);
  assert.equal(calls, 1, 'un rechazo no se convierte en una segunda acción de tráfico normal');
  assert.deepEqual(grants, ['grant-revocado']);
  assert.equal(api.labGrant(), 'grant-revocado', 'salir o elegir otra autorización requiere una acción de la persona');
});
