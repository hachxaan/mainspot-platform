/**
 * AI Core / DEC-0073 — E2E con OpenAI directo (texto e imágenes) y TypeSafe directo.
 * Solo crea una fixture ficticia: ningún dato corresponde a clientes ni a PII real.
 *
 *   bash -c 'set -a; . ./.env; set +a; node scripts/ai-core-lab-e2e.ts'
 *
 * Modo completo SOLO después de activar las rutas directas; --blocked-providers permite únicamente
 * el subconjunto sin generación cuando falta saldo/cuota. Conserva el recorrido completo E01–E20:
 * alta móvil → marca → diseño/imagen → iframe publicado (360/768/1440) → edición/restauración
 * → Facebook simulado → Jev/respuesta → asistente → resumen/campaña/calendario → consumo
 * → canary, promoción y rollback de una alternativa directa evaluada (o BLOCKED explícito).
 * La fixture pasa por synthetic y real desde Administration para ejercitar la política contractual;
 * «real» es una clasificación administrativa de prueba, NO datos personales de clientes.
 * Evidencia nueva: evidence/ai-core/openai-development-e2e-2026-11-03.txt
 * y openai-development-screens-2026-11-03/<run>/; conserva los artefactos direct anteriores.
 * No modifica hosts/proxy/certificados ni invoca Anthropic/OpenRouter. Nunca imprime credenciales o tokens.
 */

import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import tls from 'node:tls';
import pg from 'pg';
import sharp from 'sharp';
import { chromium, type Browser, type Page } from 'playwright-core';
import { SPENT_SQL } from '../src/ai/governance.ts';
import { JevRepository } from '../src/conversation/jev-repository.ts';

// Node confía en la misma CA local que el navegador (almacén del sistema), sin desactivar TLS.
tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);

const BASE = (process.env.E2E_BASE_URL ?? 'https://app.mainspot.local.io').replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const EVIDENCE = 'evidence/ai-core/openai-development-e2e-2026-11-03.txt';
const RUN = randomUUID().slice(0, 6);
const SHOTS = `evidence/ai-core/openai-development-screens-2026-11-03/${RUN}`;
const DIRECT_IMAGE = 'oa:gpt-image-2';
const DIRECT_JEV = 'ts:jev-1.14.0';
const BLOCKED_PROVIDERS = process.argv.includes('--blocked-providers');
let tenantForEvidence: string | null = null;
let forbiddenProvidersBefore: { anthropic: number; openrouter: number } | null = null;
let spentBefore = 0;
let costsReported = false;
const BUSINESS = `Café Brisa Lab ${RUN}`;
const EMAIL = `brisa.lab.${RUN}@example.test`;
const PASSWORD = `Brisa-Lab-${RUN}-2026`;


interface RegisteredModel {
  model_id: string | null; kind: string | null; model_modality: string | null;
  model_status: string | null; provider_status: string | null;
}
function isDirectModel(model: RegisteredModel): boolean {
  if (model.model_status !== 'active' || model.provider_status !== 'active') return false;
  if (model.model_modality === 'text') return model.kind === 'openai';
  if (model.model_modality === 'image') return model.kind === 'openai' && model.model_id === DIRECT_IMAGE;
  return model.model_modality === 'classification' && model.kind === 'typesafe' && model.model_id === DIRECT_JEV;
}
const transcript: string[] = [];
let failures = 0;
function say(line: string): void {
  transcript.push(line);
  console.log(line);
}
function check(ok: boolean, label: string): void {
  if (!ok) failures++;
  say(`${ok ? 'PASS' : 'FAIL'} ${label}`);
}
function blocked(label: string): void {
  failures++;
  say(`BLOCKED ${label}`);
}

async function reportCosts(): Promise<void> {
  if (costsReported) return;
  costsReported = true;
  const spent = Number((await one<{ spent: string }>(SPENT_SQL))?.spent ?? 0);
  const groups = (await pool.query<{ kind: string; cost_source: string; n: number; cost: string | null; effective: string }>(
    `SELECT p.kind, i.cost_source, count(*)::int AS n, sum(i.cost_usd) AS cost,
            sum(CASE WHEN i.status = 'running' THEN i.reserved_usd ELSE COALESCE(i.cost_usd,i.reserved_usd) END) AS effective
       FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id
      WHERE p.kind IN ('anthropic','openai','openrouter') AND i.status IN ('running','succeeded','failed')
      GROUP BY 1,2 ORDER BY 1,2`)).rows;
  say('\n-- E15: libro generativo acumulado (histórico Anthropic/OpenRouter + OpenAI directo; reservas pendientes incluidas) --');
  for (const g of groups) say(`   ${g.kind} · fuente=${g.cost_source} · n=${g.n} · costo=${g.cost === null ? 'desconocido' : `USD ${Number(g.cost).toFixed(6)}`} · cargo/reserva efectivo USD ${Number(g.effective).toFixed(6)}`);
  say(`   incremento global durante recorrido USD ${(spent - spentBefore).toFixed(6)} · laboratorio acumulado USD ${spent.toFixed(6)} de 25 (TypeSafe excluido)`);
  check(spent <= 25, 'E15 techo generativo acumulado USD 25, incluidos Anthropic/OpenRouter históricos');
  const forbidden = await one<{ anthropic: number; openrouter: number }>(
    `SELECT count(*) FILTER (WHERE p.kind = 'anthropic')::int AS anthropic,
            count(*) FILTER (WHERE p.kind = 'openrouter')::int AS openrouter
       FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id`);
  for (const kind of ['anthropic', 'openrouter'] as const) {
    check(forbiddenProvidersBefore !== null && forbidden !== undefined && forbidden[kind] === forbiddenProvidersBefore[kind], `ninguna invocación ${kind} nueva (antes=${forbiddenProvidersBefore?.[kind] ?? 'sin captura'}, después=${forbidden?.[kind] ?? 'sin captura'}); solo historia`);
  }
  const day = new Date().toISOString().slice(0, 10);
  const jevSpent = await new JevRepository(pool).spentOn(day);
  say(`   TypeSafe DEC-0032 · día UTC ${day} · USD ${jevSpent.toFixed(6)} de 1 · libro independiente (pipeline + evaluaciones + AI Core)`);
  check(jevSpent <= 1, 'E15 TypeSafe directo no supera USD 1/día, separado del techo generativo');
  if (!tenantForEvidence) return;
  const byUc = (await pool.query<RegisteredModel & { use_case_id: string; cost_source: string; n: number; cost: string | null; p50: number; p95: number }>(
    `SELECT i.use_case_id, i.model_id, p.kind, m.modality AS model_modality, m.status AS model_status,
            p.status AS provider_status, i.cost_source, count(*)::int AS n, sum(i.cost_usd) AS cost,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY i.latency_ms) AS p50,
            percentile_disc(0.95) WITHIN GROUP (ORDER BY i.latency_ms) AS p95
       FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id
       JOIN ai_model m ON m.model_id = i.model_id AND m.provider_id = i.provider_id
      WHERE i.tenant_id = $1 AND i.status = 'succeeded' GROUP BY 1,2,3,4,5,6,7 ORDER BY 1`, [tenantForEvidence])).rows;
  for (const r of byUc) say(`   ${r.use_case_id} · ${r.model_id} · proveedor=${r.kind} · modalidad=${r.model_modality} · n=${r.n} · USD ${r.cost === null ? 'desconocido' : Number(r.cost).toFixed(6)} (${r.cost_source}) · p50=${r.p50} ms p95=${r.p95} ms`);
  check((BLOCKED_PROVIDERS || byUc.length > 0) && byUc.every(isDirectModel), 'ninguna invocación exitosa de la fixture usa generación fuera de OpenAI directo o clasificación fuera de TypeSafe directo; modelos activos del registro');
  const generative = byUc.filter((r) => r.kind === 'openai');
  if (generative.length) check(generative.every((r) => r.cost !== null && r.cost_source === 'estimated'), 'costos directos de OpenAI explícitamente estimados, no reportados por el proveedor');
  else say('   sin generaciones directas exitosas: no se atribuyen costos ni evidencia de texto/imagen a proveedores bloqueados');
  if (BLOCKED_PROVIDERS) {
    const started = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id
        WHERE i.tenant_id = $1 AND p.kind IN ('anthropic','openai','openrouter') AND i.status IN ('running','succeeded','failed')`, [tenantForEvidence]);
    check(started?.n === 0, 'subconjunto bloqueado no inicia ninguna generación ni gasto generativo de la fixture');
  }
}

async function publishedFrame(page: Page, width: number, height: number, version: number) {
  await page.setViewportSize({ width, height });
  const rendered = page.waitForResponse((r) => r.url() === `${BASE}/api/backoffice/ai/website/render` && r.request().method() === 'GET');
  await page.goto(`${BASE}/panel#/sitio`);
  await page.reload(); // Descarta la caché del iframe «published» entre versiones.
  const response = await rendered;
  const payload = await response.json() as { html: string };
  const snapshot = await one<{ html: string }>('SELECT html FROM website_content WHERE tenant_id = $1 AND version = $2', [tenantForEvidence, version]);
  check(response.status() === 200 && Boolean(snapshot?.html) && payload.html === snapshot?.html, `E07 iframe de publicación v${version}: HTTP ${response.status()}, snapshot inmutable exacto por HTTPS canónico`);
  const iframe = page.locator('iframe.site-frame');
  await iframe.waitFor({ timeout: 30_000 });
  await iframe.evaluate((el, size) => { el.setAttribute('style', `position:fixed;inset:0;width:${size.width}px;height:${size.height}px;border:0;z-index:9999;background:white`); }, { width, height });
  const frame = await (await iframe.elementHandle())?.contentFrame();
  if (!frame) throw new Error('El iframe publicado no tiene documento');
  await frame.waitForLoadState('networkidle');
  await frame.locator('img').evaluateAll(async (images) => {
    await Promise.all(images.map(async (image) => {
      if ('decode' in image && typeof image.decode === 'function') await image.decode().catch(() => undefined);
    }));
  });
  return { iframe, frame };
}

async function directPreflight(): Promise<boolean> {
  say('\n-- Preflight directo (solo lecturas; sin invocaciones ni activaciones) --');
  const rows = (await pool.query<RegisteredModel & { use_case_id: string; modality: string; status: string | null; real_data: string | null; terms_verified_at: string | null; real_data_basis: string | null; passed: boolean; error_code: string | null; detail: string | null }>(
    `SELECT u.use_case_id, u.modality, r.model_id, p.kind, m.modality AS model_modality,
            m.status AS model_status, p.status AS provider_status, r.status, p.real_data, p.terms_verified_at, p.real_data_basis,
            COALESCE(e.status = 'passed' AND e.real_provider AND e.route_id = r.route_id, false) AS passed,
            last_i.error_code, last_i.validation->>'detail' AS detail
       FROM ai_use_case u LEFT JOIN ai_rollout ro ON ro.use_case_id = u.use_case_id AND ro.environment = 'lab'
       LEFT JOIN ai_route_revision r ON r.route_id = ro.active_route_id
       LEFT JOIN ai_model m ON m.model_id = r.model_id
       LEFT JOIN ai_provider p ON p.provider_id = m.provider_id
       LEFT JOIN ai_eval_run e ON e.run_id = r.tested_eval_run_id
       LEFT JOIN LATERAL (SELECT i.error_code, i.validation FROM ai_invocation i
          JOIN ai_model im ON im.model_id = i.model_id AND im.provider_id = i.provider_id
          JOIN ai_provider ip ON ip.provider_id = i.provider_id
          WHERE i.use_case_id = u.use_case_id
            AND (i.route_id = r.route_id OR (r.route_id IS NULL AND im.status = 'active' AND ip.status = 'active'
              AND im.modality = u.modality AND (
                (u.modality = 'text' AND ip.kind = 'openai')
                OR (u.modality = 'image' AND ip.kind = 'openai' AND im.model_id = $1)
                OR (u.modality = 'classification' AND ip.kind = 'typesafe' AND im.model_id = $2))))
          ORDER BY i.created_at DESC LIMIT 1) last_i ON true
      WHERE u.status = 'active' ORDER BY u.use_case_id`, [DIRECT_IMAGE, DIRECT_JEV])).rows;
  let ready = rows.length > 0;
  for (const r of rows) {
    const direct = r.modality === r.model_modality && isDirectModel(r);
    const ok = direct && r.status === 'ACTIVE' && r.passed && !r.error_code && r.real_data === 'allowed' && Boolean(r.terms_verified_at && r.real_data_basis);
    say(`   ${r.use_case_id}: ${r.model_id ?? 'sin ruta activa'} · proveedor=${r.kind ?? 'ninguno'} · modalidad=${r.model_modality ?? 'ninguna'} · modelo=${r.model_status ?? 'sin registro'} · evaluación real=${r.passed} · política=${r.real_data ?? 'sin proveedor'}${r.error_code ? ` · último fallo de ruta=${r.error_code}:${r.detail ?? 'sin detalle'}` : ''}`);
    if (!ok) { ready = false; blocked(`BLOCKED_EXTERNAL ${r.use_case_id}: requiere ruta directa activa, evaluación real aprobada y proveedor verificado; no se activa ni sustituye automáticamente`); }
  }
  const unsafe = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ai_rollout ro JOIN ai_route_revision r ON r.route_id IN (ro.active_route_id,ro.canary_route_id) JOIN ai_model m ON m.model_id = r.model_id JOIN ai_provider p ON p.provider_id = m.provider_id WHERE ro.environment = 'lab' AND (p.kind IN ('anthropic','openrouter') OR r.params->>'fallback_route_id' IS NOT NULL)`);
  check(unsafe?.n === 0, 'ningún rollout activo/canary apunta a Anthropic/OpenRouter ni tiene fallback automático');
  if (unsafe?.n !== 0) throw new Error('Preflight inseguro: retirar rutas Anthropic/OpenRouter y fallbacks automáticos antes de ejecutar incluso el subconjunto bloqueado; el escenario no los modifica');
  return ready && unsafe?.n === 0;
}

async function blockedSubset(browser: Browser, page: Page, admin: Page, tenant: string): Promise<void> {
  say('\n-- Subconjunto alcanzable; NO sustituye la aceptación completa E01–E20 --');
  const token = await page.evaluate(() => {
    // Global DOM conocido; el tsconfig del backend no incluye la biblioteca DOM.
    const browserGlobal = globalThis as unknown as { sessionStorage: { getItem: (key: string) => string | null } };
    return browserGlobal.sessionStorage.getItem('mainspot.token');
  });
  const provider = await one<{ real_data: string; terms_verified_at: string | null; real_data_basis: string | null }>(`SELECT real_data, terms_verified_at, real_data_basis FROM ai_provider WHERE kind = 'typesafe' AND status = 'active'`);
  check(provider?.real_data === 'allowed' && Boolean(provider.terms_verified_at && provider.real_data_basis), 'TypeSafe activo y contractualmente verificado para la política de datos reales');
  const response = await fetch(`${BASE}/api/backoffice/conversation/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': `direct-blocked-${RUN}` },
    body: JSON.stringify({ text: 'Cambia el horario a lunes a viernes de 8:00 a 18:00.', channel: 'simulated' }),
  });
  check(response.ok, `E02 solicitud determinista por API del dueño: HTTP ${response.status} (canal simulado, no generativa)`);
  if (response.ok) await until('clasificación TypeSafe persistida', async () => Boolean(await one(
    'SELECT classification_id FROM jev_classification WHERE tenant_id = $1 LIMIT 1', [tenant])), 20_000);
  const classification = await one<{ status: string; provider: string; resolved_model: string; cost_source: string }>('SELECT status, provider, resolved_model, cost_source FROM jev_classification WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1', [tenant]);
  check(classification?.status === 'evaluated' && classification.provider === 'typesafe' && classification.resolved_model === 'jev-1.14.0', `E02 TypeSafe real de fixture clasificada real: ${classification?.status ?? 'sin clasificación'} / ${classification?.provider ?? 'sin proveedor'} / ${classification?.resolved_model ?? 'sin modelo'} / costo ${classification?.cost_source ?? 'sin fuente'}`);
  await go(page, '#/cambios');
  await shot(page, 'blocked-own-02-solicitud-determinista', true);
  await admin.goto(`${BASE}/plataforma#/negocio/${encodeURIComponent(tenant)}`);
  await admin.getByRole('heading', { name: BUSINESS }).waitFor();
  await shot(admin, 'blocked-adm-02-fixture-real', true);
  const eng = await platformLogin(browser, 'ingenieria', 'lab-ingenieria', 1);
  for (const uc of ['conversation.intent.classify', 'website.initial.design', 'website.image.generate']) {
    await eng.goto(`${BASE}/ingenieria#/caso/${uc}`);
    await eng.getByText('Prompt Studio').waitFor();
    await shot(eng, `blocked-eng-${uc.replaceAll('.', '-')}`, true);
  }
  blocked('E04/E05/E06/E07/E08/E09-respuesta/E11/E12/E20 completo: pendientes saldo/cuota generativos y evaluaciones directas; no se ejecutan ni se declaran aprobados');
  say('# Subconjunto: pantallas reales de dueño/Administration/Engineering; Google/Meta/Telegram siguen simulados. Sin canary, rollback, publicación generativa ni imagen fingidos.');
}

// ------------------------------------------------------------------ credenciales del laboratorio
function cred(login: string): { login: string; password: string; secret: string } {
  const txt = readFileSync(`${homedir()}/.config/mainspot/platform-${login}.txt`, 'utf8');
  const kv = Object.fromEntries(txt.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { login, password: String(kv['password']), secret: String(kv['totp_secret']) };
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function totp(secret: string, offset = 0): string {
  let bits = 0;
  let val = 0;
  const bytes: number[] = [];
  for (const c of secret) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { bytes.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const h = createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const o = (h[h.length - 1] as number) & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

// ------------------------------------------------------------------ BD (lecturas de verificación)
function devUrl(): string {
  const u = new URL(process.env.DATABASE_URL ?? '');
  u.hostname = '127.0.0.1';
  u.port = process.env.MAINSPOT_DEV_PG_PORT ?? '55432';
  u.pathname = '/mainspot_dev';
  return u.toString();
}
const pool = new pg.Pool({ connectionString: devUrl(), max: 2 });
async function one<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await pool.query<T>(sql, params)).rows[0];
}
async function until(label: string, fn: () => Promise<boolean>, timeoutMs = 240_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`timeout esperando: ${label}`);
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}
async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => { (globalThis as unknown as { location: { hash: string } }).location.hash = h; }, hash);
  await page.waitForTimeout(400);
}
async function confirmSheet(page: Page): Promise<void> {
  await page.locator('.sheet [data-sheet="0"]').click();
}

async function platformLogin(browser: Browser, area: 'plataforma' | 'ingenieria', who: string, offset: number): Promise<Page> {
  const c = cred(who);
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-MX' })).newPage();
  await page.goto(`${BASE}/${area}`);
  await page.locator('#pl-login').fill(c.login);
  await page.locator('#pl-pass').fill(c.password);
  await page.locator('#pl-code').fill(totp(c.secret, offset));
  await page.locator('#pl-submit').click();
  await page.locator('.pc-top').waitFor({ timeout: 15_000 });
  return page;
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  if (BASE !== 'https://app.mainspot.local.io') throw new Error('E2E_BASE_URL debe ser exactamente https://app.mainspot.local.io');
  const head = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
  say(`# AI Core — E2E de laboratorio con proveedores reales (${new Date().toISOString()})`);
  say(`# HEAD ${head} · origen ${BASE} · Chrome ${CHROME} (TLS verificado, sin ignoreHTTPSErrors)`);
  say(`# fixture ficticia «${BUSINESS}»: sin PII de clientes; modo ${BLOCKED_PROVIDERS ? 'subconjunto BLOCKED_EXTERNAL' : 'completo E01–E20'}`);
  spentBefore = Number((await one<{ spent: string }>(SPENT_SQL))?.spent ?? 0);
  forbiddenProvidersBefore = (await one<{ anthropic: number; openrouter: number }>(
    `SELECT count(*) FILTER (WHERE p.kind = 'anthropic')::int AS anthropic,
            count(*) FILTER (WHERE p.kind = 'openrouter')::int AS openrouter
       FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id`)) ?? null;
  const ready = await directPreflight();
  if (!ready && !BLOCKED_PROVIDERS) throw new Error('BLOCKED_EXTERNAL preflight: faltan rutas/evaluaciones directas. OpenAI requiere saldo/cuota habilitados para texto e imágenes; consultar los fallos reales arriba. Para el subconjunto sin generación: --blocked-providers');

  // ---------------------------------------------------------------- alta por invitación (CLI de operación)
  const inv = JSON.parse(execFileSync(process.execPath, ['scripts/invite-owner.ts', '--business', BUSINESS, '--email', EMAIL, '--base', BASE], { env: { ...process.env, DATABASE_URL: devUrl(), LOG_LEVEL: 'error' } }).toString()) as { tenant_id: string; invitation_link: string };
  const tenant = inv.tenant_id;
  tenantForEvidence = tenant;
  if (new URL(inv.invitation_link).origin !== BASE) throw new Error('La invitación no usa el origen canónico');
  say(`\n-- E17/BR-0007: Administration marca el negocio como sintético (motivo + step-up) --`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const pageErrors: string[] = [];
  let completed = false;
  try {
    const admin = await platformLogin(browser, 'plataforma', 'lab-admin', 0);
    await admin.goto(`${BASE}/plataforma#/negocio/${encodeURIComponent(tenant)}`);
    await admin.getByRole('heading', { name: BUSINESS }).waitFor();
    await admin.locator('#ta-op').selectOption('class:synthetic');
    await admin.locator('#ta-reason').fill('Negocio ficticio del laboratorio AI Core (issue #9)');
    await admin.locator('#ta-submit').click();
    await admin.getByText('Cambio aplicado').waitFor();
    const cls = await one<{ data_classification: string; status: string }>('SELECT data_classification, status FROM client WHERE client_id = $1', [tenant]);
    check(cls?.data_classification === 'synthetic' && cls.status === 'active', 'solo un platform_admin con step-up clasifica el negocio como sintético (sigue activo)');
    await admin.waitForTimeout(1000);
    await shot(admin, 'adm-01-negocio-sintetico');
    await admin.locator('#ta-op').selectOption('class:real');
    await admin.locator('#ta-reason').fill('Fixture ficticia sin PII de clientes: ejercicio explícito de política real con proveedores verificados QS0017');
    await admin.locator('#ta-submit').click();
    await until('clasificación administrativa real de fixture', async () => (await one<{ c: string }>('SELECT data_classification AS c FROM client WHERE client_id = $1', [tenant]))?.c === 'real', 15_000);
    check(true, 'E17 fixture ficticia marcada real por Administration; NO contiene datos de clientes reales');
    await shot(admin, 'adm-01b-fixture-real-sin-pii');

    // -------------------------------------------------------------- dueño en móvil
    say('\n-- E20: alta móvil → Mi marca → página con IA --');
    const ownerCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-MX', isMobile: true, hasTouch: true });
    const page = await ownerCtx.newPage();
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(inv.invitation_link);
    await page.getByText(`${BUSINESS} ya tiene su lugar en MainSpot`).waitFor();
    await page.locator('a[href="#/activar/contrasena"]').click();
    await page.locator('#p-name').fill('Rosa Brisa');
    await page.locator('#p-pass').fill(PASSWORD);
    await page.locator('#p-pass2').fill(PASSWORD);
    await page.locator('#pass-submit').click();
    await page.waitForURL(/#\/activar\/negocio/);
    await page.locator('#b-line').fill('Café de altura de Chiapas y pan dulce del día');
    await page.locator('#ph-num-primary').fill('983 120 4455');
    await page.locator('#b-address').fill('Av. Héroes 45, Centro, Chetumal');
    await page.locator('#b-hw').fill('7:00 a 20:00');
    await page.locator('#b-hs').fill('8:00 a 20:00');
    await page.locator('#b-hd').fill('8:00 a 14:00');
    for (const s of ['Café de olla', 'Espresso de altura', 'Pan dulce del día']) {
      await page.locator('#b-service').fill(s);
      await page.locator('[data-action="service-add"]').click();
    }
    await page.locator('#biz-submit').click();
    await page.waitForURL(/#\/activar\/telegram/);
    await go(page, '#/ia/marca');
    await page.locator('#br-voice').fill('Cercana, cálida y orgullosa del café chiapaneco');
    await page.locator('#br-audience').fill('Vecinos del centro y oficinistas que desayunan temprano');
    await page.locator('#br-category').fill('Cafetería');
    await page.locator('#br-palette').fill('#7a3e1d, #f4e9dc');
    await page.locator('#br-prices').fill('Café de olla | $35\nEspresso doble | $45');
    await page.locator('#br-promotions').fill('2x1 en café de olla los martes de noviembre | 2026-11-30');
    await page.locator('#ai-brand-save').click();
    await page.getByText(/Guardado como versión/).waitFor();
    await shot(page, 'own-01-mi-marca-movil');
    check((await one<{ n: number }>(`SELECT count(*)::int AS n FROM brand_fact WHERE tenant_id = $1 AND status = 'confirmed'`, [tenant]))!.n >= 8, 'E01 Brand Studio: datos del alta + marca confirmados con versión');

    // -------------------------------------------------------------- foto propia (biblioteca, EXIF fuera)
    say('\n-- E13: biblioteca — foto del dueño con ALT y derechos; EXIF/GPS eliminados --');
    const photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 122, g: 62, b: 29 } } })
      .composite([{ input: Buffer.from('<svg width="1600" height="1200"><circle cx="800" cy="600" r="380" fill="#f4e9dc"/><circle cx="800" cy="600" r="250" fill="#5a2c12"/></svg>') }])
      .jpeg().withExif({ IFD0: { Make: 'Prueba', Model: 'MainSpot Lab' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '18/1 30/1 0/1' } }).toBuffer();
    check(Boolean((await sharp(photo).metadata()).exif), 'la foto de prueba trae EXIF (incluido GPS) antes de subirla');
    await go(page, '#/ia/biblioteca');
    await page.locator('#up-file').setInputFiles({ name: 'taza.jpg', mimeType: 'image/jpeg', buffer: photo });
    await page.locator('#up-alt').fill('Taza de café de olla vista desde arriba sobre fondo café');
    await page.locator('#up-rights').check();
    await page.locator('#up-btn').click();
    await page.getByText('Imagen guardada en tu biblioteca').waitFor();
    const asset = await one<{ asset_id: string }>(`SELECT asset_id FROM media_asset WHERE tenant_id = $1 AND source = 'uploaded'`, [tenant]);
    const served = Buffer.from(await (await fetch(`${BASE}/media/${asset!.asset_id}/w1280.webp`)).arrayBuffer());
    const meta = await sharp(served).metadata();
    check(meta.format === 'webp' && !meta.exif, `la biblioteca sirve WebP ${meta.width}×${meta.height} sin EXIF/GPS`);
    await shot(page, 'own-01b-biblioteca-movil', true);
    if (BLOCKED_PROVIDERS) {
      await blockedSubset(browser, page, admin, tenant);
      check(pageErrors.length === 0, `subconjunto sin errores JavaScript (${pageErrors.length})`);
      completed = true;
      return;
    }

    // -------------------------------------------------------------- diseño IA real
    await go(page, '#/ia/pagina');
    await page.locator('#ai-brief').fill('Cálida y artesanal; que inviten a desayunar y a pasar por café de olla.');
    await page.locator('#ai-design-btn').click();
    await page.getByText('La vista previa está lista').waitFor({ timeout: 300_000 });
    const design = await one<{ result: { proposal_id: string; model: string; images: number; images_blocked: string[]; simulated: boolean } }>(`SELECT result FROM ai_job WHERE tenant_id = $1 AND kind = 'website.design' ORDER BY created_at DESC LIMIT 1`, [tenant]);
    const dInv = await one<RegisteredModel & { cost_usd: string; cost_source: string; latency_ms: number; route_version: number; prompt_version: number }>(
      `SELECT i.model_id, provider.kind, m.modality AS model_modality, m.status AS model_status, provider.status AS provider_status,
              i.cost_usd, i.cost_source, i.latency_ms, i.route_version, p.version AS prompt_version
         FROM ai_invocation i JOIN ai_prompt_revision p ON p.revision_id = i.prompt_revision_id
         JOIN ai_model m ON m.model_id = i.model_id AND m.provider_id = i.provider_id
         JOIN ai_provider provider ON provider.provider_id = i.provider_id
        WHERE i.tenant_id = $1 AND i.use_case_id = 'website.initial.design' AND i.status = 'succeeded' ORDER BY i.created_at DESC LIMIT 1`, [tenant]);
    say(`   diseño: ${dInv?.model_id} r${dInv?.route_version}/p${dInv?.prompt_version} · ${dInv?.latency_ms} ms · USD ${dInv?.cost_usd} (${dInv?.cost_source}) · imágenes ${design?.result.images} · bloqueadas ${JSON.stringify(design?.result.images_blocked)}`);
    check(design?.result.simulated === false && Boolean(dInv && dInv.model_modality === 'text' && isDirectModel(dInv)), 'E05 diseño directo OpenAI no simulado con modelo textual activo del registro, ruta y costo estimado trazados');
    const generated = (await pool.query<{ asset_id: string; bytes: Buffer; sha256: string; width: number; height: number; mime: string; generator_model: string; is_illustration: boolean; alt_text: string; invocation_id: string; kind: string; model_id: string; provider_model: string; status: string; cost_source: string; usage: { images?: number } }>(
      `SELECT a.asset_id, a.bytes, a.sha256, a.width, a.height, a.mime, a.generator_model, a.is_illustration, a.alt_text,
              a.invocation_id, p.kind, i.model_id, i.provider_model, i.status, i.cost_source, i.usage
         FROM media_asset a JOIN ai_invocation i ON i.invocation_id = a.invocation_id AND i.tenant_id = a.tenant_id
         JOIN ai_provider p ON p.provider_id = i.provider_id
        WHERE a.tenant_id = $1 AND a.source = 'ai_generated' ORDER BY a.created_at`, [tenant])).rows;
    check(generated.length > 0 && !design?.result.images_blocked?.length, 'E13/E14 existen imágenes generadas reales; ninguna sustituida silenciosamente por la foto subida');
    for (const image of generated) {
      const response = await fetch(`${BASE}/media/${image.asset_id}/original.webp`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(bytes).metadata();
      const hash = createHash('sha256').update(bytes).digest('hex');
      const stats = await sharp(bytes).stats();
      const ok = response.ok && bytes.equals(image.bytes) && hash === image.sha256 && metadata.format === 'webp'
        && metadata.width === image.width && metadata.height === image.height && image.width >= 512 && image.height >= 512
        && image.mime === 'image/webp' && response.headers.get('content-type')?.split(';')[0] === 'image/webp'
        && !metadata.exif && stats.channels.some((channel) => channel.stdev > 1)
        && image.kind === 'openai' && image.model_id === DIRECT_IMAGE && image.generator_model === DIRECT_IMAGE
        && image.provider_model === 'gpt-image-2' && image.status === 'succeeded' && image.usage.images === 1
        && image.cost_source === 'estimated' && image.is_illustration && Boolean(image.alt_text);
      check(ok, `E13/E14 bytes verificados ${image.asset_id}: ${bytes.length} B, ${metadata.format} ${metadata.width}×${metadata.height}, MIME=${response.headers.get('content-type')}, SHA256=${hash}, proveedor=${image.kind}, modelo=${image.model_id}/${image.provider_model}, invocación=${image.invocation_id}, ilustración=${image.is_illustration}, costo=${image.cost_source}`);
    }
    await shot(page, 'own-02-pedido-listo-movil');
    await page.locator('#ai-open-preview').click();
    await page.locator('iframe.site-frame').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await shot(page, 'own-03-vista-previa-diseno-movil', true);
    await page.locator('#approve-btn').click();
    await confirmSheet(page);
    await until('primera publicación', async () => (await one<{ v: number }>('SELECT published_version AS v FROM client_website WHERE tenant_id = $1', [tenant]))?.v === 1, 60_000);
    const site = await one<{ slug: string; data: { design?: unknown } }>('SELECT slug, data FROM client_website WHERE tenant_id = $1', [tenant]);
    check(Boolean(site?.data.design), 'E07 la versión 1 publicada lleva el diseño aprobado');

    // -------------------------------------------------------------- iframe publicado existente
    say('\n-- E07: snapshot publicado en el iframe existente del panel canónico; sin provisión de infraestructura --');
    for (const [w, h] of [[360, 780], [768, 1024], [1440, 900]] as const) {
      const { iframe, frame } = await publishedFrame(page, w, h, 1);
      const a11y = await frame.evaluate(() => {
        const d = (globalThis as unknown as { document: { documentElement: { lang: string; scrollWidth: number; clientWidth: number }; querySelectorAll: (s: string) => ArrayLike<{ alt?: string; naturalWidth?: number }>; querySelector: (s: string) => unknown } }).document;
        const imgs = Array.from(d.querySelectorAll('img'));
        return { lang: d.documentElement.lang, h1: d.querySelectorAll('h1').length, imgs: imgs.length, noAlt: imgs.filter((i) => !i.alt).length, broken: imgs.filter((i) => !i.naturalWidth).length, scripts: d.querySelectorAll('script').length, overflowX: d.documentElement.scrollWidth > d.documentElement.clientWidth };
      });
      await iframe.screenshot({ path: `${SHOTS}/site-v1-${w}.png` });
      const ok = a11y.lang.startsWith('es') && a11y.h1 === 1 && a11y.noAlt === 0 && a11y.broken === 0 && a11y.scripts === 0 && !a11y.overflowX;
      check(ok, `iframe publicado ${w}px: TLS canónico verificado, lang=${a11y.lang}, h1=${a11y.h1}, ${a11y.imgs} imágenes (${a11y.noAlt} sin ALT, ${a11y.broken} rotas), scripts=${a11y.scripts}, desborde=${a11y.overflowX}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });

    // -------------------------------------------------------------- edición compleja (Jev decide el alcance)
    say('\n-- E06: edición compleja con tus palabras --');
    await go(page, '#/ia/pagina');
    await page.locator('#ai-instr').fill('Pon el color principal en un verde oscuro y agrega una sección de preguntas frecuentes sobre nuestro horario, dónde estamos y qué vendemos.');
    await page.locator('#ai-edit-btn').click();
    await until('edición lista', async () => ['succeeded', 'failed'].includes((await one<{ status: string }>(`SELECT status FROM ai_job WHERE tenant_id = $1 AND kind = 'website.edit' ORDER BY created_at DESC LIMIT 1`, [tenant]))?.status ?? ''), 300_000);
    const edit = await one<{ status: string; error_code: string | null; result: { scope: string; semantic_source: string; use_case: string; model: string; proposal_id: string; operations: number; status: string } }>(`SELECT status, error_code, result FROM ai_job WHERE tenant_id = $1 AND kind = 'website.edit' ORDER BY created_at DESC LIMIT 1`, [tenant]);
    say(`   edición: ${edit?.status} ${edit?.error_code ?? ''} alcance=${edit?.result?.scope} fuente=${edit?.result?.semantic_source} caso=${edit?.result?.use_case} modelo=${edit?.result?.model} operaciones=${edit?.result?.operations}`);
    check(edit?.status === 'succeeded' && edit.result.semantic_source === 'jev' && edit.result.status === 'proposed', 'E02/E06 Jev real clasifica el alcance y la ruta de edición propone un parche tipado');
    if (edit?.result?.proposal_id) {
      await go(page, `#/vista-previa/${edit.result.proposal_id}`);
      await page.locator('iframe.site-frame').waitFor({ timeout: 30_000 });
      await shot(page, 'own-04-vista-previa-edicion-movil', true);
      await page.locator('#approve-btn').click();
      await confirmSheet(page);
      await until('v2 publicada', async () => (await one<{ v: number }>('SELECT published_version AS v FROM client_website WHERE tenant_id = $1', [tenant]))?.v === 2, 60_000);
      const v2 = await one<{ html: string }>('SELECT html FROM website_content WHERE tenant_id = $1 AND version = 2', [tenant]);
      check(/Preguntas|frecuentes/i.test(v2?.html ?? ''), 'E07 la versión 2 publicada incluye la sección pedida');
      const publishedV2 = await publishedFrame(page, 1440, 900, 2);
      await publishedV2.iframe.screenshot({ path: `${SHOTS}/site-v2-1440.png` });
      await page.setViewportSize({ width: 390, height: 844 });

      say('\n-- E07: restaurar el diseño de la versión 1 como versión 3 (vista previa + aprobación) --');
      await go(page, '#/pagina');
      await page.locator('#versions').waitFor();
      await page.locator('[data-action="restore-ask"][data-arg="1"]').click();
      await page.getByText('¿Restaurar la versión 1?').waitFor();
      await confirmSheet(page);
      await page.waitForURL(/#\/vista-previa\//);
      await page.locator('#approve-btn').click();
      await confirmSheet(page);
      await until('v3 publicada', async () => (await one<{ v: number }>('SELECT published_version AS v FROM client_website WHERE tenant_id = $1', [tenant]))?.v === 3, 60_000);
      const rows = (await pool.query<{ version: number; html: string; restored_from_version: number | null }>('SELECT version, html, restored_from_version FROM website_content WHERE tenant_id = $1 ORDER BY version', [tenant])).rows;
      check(rows.length === 3 && rows[2]!.restored_from_version === 1 && rows[2]!.html === rows[0]!.html.replace('versión 1', 'versión 3'), 'E07 v3 = diseño de la v1 (restored_from_version=1); v1 y v2 intactas');
      const restored = await publishedFrame(page, 390, 844, 3);
      const live = await restored.frame.content();
      check(live.includes('versión 3') && !/Preguntas frecuentes/.test(live), 'E07 iframe HTTPS canónico sirve la v3 restaurada, igual al snapshot publicado');
      await page.goto(`${BASE}/panel#/ia/publicar`);
    }

    // -------------------------------------------------------------- Facebook generado
    say('\n-- E08: publicación de Facebook generada (Meta simulado) --');
    await go(page, '#/ia/publicar');
    await page.locator('#ai-req').fill('Anuncia que ya tenemos pan de muerto y chocolate caliente para este fin de semana.');
    await page.locator('#ai-compose-btn').click();
    await page.locator('#ai-draft-btn').waitFor({ timeout: 300_000 });
    await shot(page, 'own-05-variantes-facebook-movil', true);
    const comp = await one<{ result: { variants: Array<{ text: string; hashtags: string[] }>; model: string; warnings: string[] } }>(`SELECT result FROM ai_job WHERE tenant_id = $1 AND kind = 'social.compose' ORDER BY created_at DESC LIMIT 1`, [tenant]);
    const emojiMax = Math.max(...(comp?.result.variants ?? []).map((v) => (v.text.match(/\p{Extended_Pictographic}/gu) ?? []).length));
    say(`   variantes ${comp?.result.variants.length} · modelo ${comp?.result.model} · emojis máx ${emojiMax}`);
    for (const v of comp?.result.variants ?? []) say(`     · ${v.text.replace(/\s+/g, ' ').slice(0, 200)} ${v.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}`);
    check((comp?.result.variants.length ?? 0) >= 2 && emojiMax <= 3, 'E08 2-3 variantes con emojis moderados, CTA y hashtags');
    await page.locator('#ai-draft-btn').click();
    await page.waitForURL(/#\/facebook\/post\//, { timeout: 30_000 });
    await page.locator('#fb-approve').click();
    await confirmSheet(page);
    await until('post publicado', async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM social_post WHERE tenant_id = $1 AND status = 'published'`, [tenant]))!.n === 1, 60_000);
    const post = await one<{ post_id: string; generation: { model: string } }>(`SELECT post_id, generation FROM social_post WHERE tenant_id = $1 AND status = 'published'`, [tenant]);
    check(Boolean(post?.generation?.model), 'E08 publicación aprobada por el dueño, trazada a la generación (Meta: simulado, BLOCKED_EXTERNAL para real)');

    // -------------------------------------------------------------- comentarios con Jev real
    say('\n-- E09: comentarios — Jev real lee sentimiento e ironía; respuesta con hechos verificados --');
    const token = await page.evaluate(() => (globalThis as unknown as { sessionStorage: { getItem: (k: string) => string | null } }).sessionStorage.getItem('mainspot.token'));
    const inject = async (body: string, ref: string) => fetch(`${BASE}/api/backoffice/dev/simulator/facebook-comments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ post_id: post!.post_id, body, author_label: 'Cliente', external_ref: ref }) });
    await fetch(`${BASE}/api/backoffice/engagement/policies`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ origin: 'facebook_comment', category: 'gratitude', mode: 'safe_auto_reply', consent: true }) });
    const refA = `lab-a-${RUN}`;
    const refB = `lab-b-${RUN}`;
    await inject('¡Qué rico estuvo el pan de muerto! Muchas gracias, volveremos pronto.', refA);
    await inject('Qué maravilla esperar 40 minutos por un café frío. Excelente servicio, de verdad.', refB);
    await until('casos clasificados', async () => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM engagement_case WHERE tenant_id = $1 AND classified_at IS NOT NULL`, [tenant]))!.n === 2, 120_000);
    await new Promise((r) => setTimeout(r, 5000));
    const cases = (await pool.query<{ external_ref: string; sentiment: string; semantic_source: string; decision: string; state: string; response_text: string | null }>(
      'SELECT external_ref, sentiment, semantic_source, decision, state, response_text FROM engagement_case WHERE tenant_id = $1', [tenant])).rows;
    for (const c of cases) say(`   ${c.external_ref === refA ? 'agradecimiento' : 'ironía'}: sentimiento=${c.sentiment} fuente=${c.semantic_source} decisión=${c.decision} estado=${c.state}`);
    const ca = cases.find((c) => c.external_ref === refA);
    const cb = cases.find((c) => c.external_ref === refB);
    check(ca?.semantic_source === 'jev' && ca.sentiment === 'positive' && ca.decision === 'auto_reply', 'E09 agradecimiento: Jev real positivo → respuesta automática consentida');
    check(cb?.semantic_source === 'jev' && cb.sentiment === 'negative' && cb.decision === 'human_review', 'E09 ironía: Jev real negativo → caso humano con borrador, sin publicar');
    await go(page, '#/atencion');
    await page.waitForTimeout(1500);
    await shot(page, 'own-06-atencion-movil', true);

    // -------------------------------------------------------------- asistente
    say('\n-- E11: asistente con el estado real de la cuenta --');
    await go(page, '#/ia');
    await page.locator('#ai-q').fill('¿Qué comentarios necesitan mi respuesta y cuántas publicaciones hice esta semana?');
    await page.locator('#ai-ask-btn').click();
    await page.getByText('Respuesta').first().waitFor({ timeout: 120_000 });
    const answerApi = await fetch(`${BASE}/api/backoffice/ai/assistant`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await page.evaluate(() => (globalThis as unknown as { sessionStorage: { getItem: (k: string) => string | null } }).sessionStorage.getItem('mainspot.token'))}` }, body: JSON.stringify({ question: '¿Cuántos comentarios esperan mi decisión?' }) }).then((r) => r.json()) as { answer: string; evidence: Array<{ tool: string }>; tools_used: string[]; model: string };
    const answer = await page.locator('#ai-answer').innerText();
    say(`   respuesta (panel): ${answer.replace(/\s+/g, ' ').slice(0, 300)}`);
    say(`   respuesta (API): modelo ${answerApi.model} · herramientas ${answerApi.tools_used.join(', ')} · evidencia ${answerApi.evidence.map((e) => e.tool).join(', ')}`);
    check(/1/.test(answer) && !/error/i.test(answer), 'E11 responde con cifras trazables a herramientas de solo lectura del propio negocio');
    await shot(page, 'own-07-asistente-movil', true);

    // -------------------------------------------------------------- resumen, campaña y calendario
    say('\n-- E12/FR-0017: resumen, campaña sin gasto y calendario --');
    await go(page, '#/ia/resumen');
    await page.locator('#ins-7').click();
    await page.locator('section[aria-live="polite"]').waitFor({ timeout: 120_000 });
    const ins = await one<{ status: string }>('SELECT status FROM ai_insight WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1', [tenant]);
    check(ins?.status === 'abstained', 'resumen: con menos de 7 días de actividad se abstiene en lugar de inventar');
    await go(page, '#/ia/campanas');
    await page.locator('#cmp-obj').fill('Que más vecinos vengan a desayunar en noviembre.');
    await page.locator('#cmp-budget').fill('500');
    await page.locator('#cmp-btn').click();
    await page.getByRole('button', { name: 'Aprobar el plan' }).waitFor({ timeout: 180_000 });
    await shot(page, 'own-08-campana-movil', true);
    await page.getByRole('button', { name: 'Aprobar el plan' }).click();
    await until('plan aprobado', async () => (await one<{ s: string }>('SELECT status AS s FROM marketing_campaign WHERE tenant_id = $1', [tenant]))?.s === 'plan_approved', 30_000);
    const cmp = await one<{ spend_authorized: boolean; plan: { budget: { proposed_total_mxn: number | null } } }>('SELECT spend_authorized, plan FROM marketing_campaign WHERE tenant_id = $1', [tenant]);
    check(cmp?.spend_authorized === false && cmp.plan.budget.proposed_total_mxn === 500, 'E12 plan con el monto dado por el dueño; aprobado sin autorizar gasto');
    await go(page, '#/ia/calendario');
    await page.locator('#ed-btn').click();
    await until('ideas', async () => (await one<{ n: number }>('SELECT count(*)::int AS n FROM editorial_suggestion WHERE tenant_id = $1', [tenant]))!.n >= 3, 180_000);
    await go(page, '#/ia/calendario');
    await page.waitForTimeout(1500);
    await shot(page, 'own-09-calendario-movil', true);
    check(true, 'calendario editorial: ideas fechadas guardadas para el negocio');

    // -------------------------------------------------------------- Administration: consumo
    say('\n-- E17: Administration ve consumo y salud sin contenido de conversaciones --');
    await admin.goto(`${BASE}/plataforma#/negocios`);
    await admin.getByRole('heading', { name: 'Negocios' }).waitFor();
    await shot(admin, 'adm-02a-negocios', true);
    await admin.goto(`${BASE}/plataforma#/negocio/${encodeURIComponent(tenant)}`);
    await admin.getByText('IA (30 días)').waitFor();
    await admin.waitForTimeout(1200);
    await shot(admin, 'adm-02-consumo-negocio', true);
    const adminText = await admin.locator('main').innerText();
    check(/website\.initial\.design/.test(adminText) && !/Qué maravilla esperar/.test(adminText), 'consumo de IA por caso de uso visible; sin texto de clientes');

    // -------------------------------------------------------------- Engineering: canary + rollback
    say('\n-- E04: canary y rollback desde la Engineering Console --');
    const eng = await platformLogin(browser, 'ingenieria', 'lab-ingenieria', 1);
    const uc = 'social.facebook.post.compose';
    await eng.goto(`${BASE}/ingenieria#/caso/${uc}`);
    await eng.getByText('Prompt Studio').waitFor();
    const baseline = await one<{ active_route_id: string; canary_route_id: string | null; version: string }>('SELECT active_route_id, canary_route_id, version FROM ai_rollout WHERE use_case_id = $1 AND environment = $2', [uc, 'lab']);
    const alternate = await one<{ route_id: string; model_id: string; run_id: string }>(
      `SELECT r.route_id, r.model_id, e.run_id FROM ai_route_revision r
         JOIN ai_eval_run e ON e.run_id = r.tested_eval_run_id AND e.route_id = r.route_id AND e.status = 'passed' AND e.real_provider
         JOIN ai_model m ON m.model_id = r.model_id AND m.status = 'active' AND m.modality = 'text'
         JOIN ai_provider p ON p.provider_id = m.provider_id AND p.kind = 'openai' AND p.status = 'active'
        WHERE r.use_case_id = $1 AND r.route_id <> $2 AND p.real_data = 'allowed'
          AND p.terms_verified_at IS NOT NULL AND p.real_data_basis IS NOT NULL
          AND r.params->>'fallback_route_id' IS NULL
          AND r.status = 'APPROVED' AND r.approved_by IS NOT NULL AND r.approved_at IS NOT NULL
        ORDER BY r.version DESC LIMIT 1`, [uc, baseline?.active_route_id]);
    if (!baseline?.active_route_id || baseline.canary_route_id || !alternate) {
      blocked('E04 canary/rollback: no hay alternativa textual OpenAI directa previamente evaluada y aprobada, o existe un canary ajeno; no se aprueba, activa ni simula una alternativa');
    } else {
      say(`   alternativa OpenAI directa ${alternate.model_id}, evaluación real ${alternate.run_id}; baseline ${baseline.active_route_id}`);
      const rollout = async (action: string, reason: string, expectedActive: string, expectedCanary: string | null) => {
        await eng.locator('#ro-act').selectOption(action);
        if (action === 'canary') { await eng.locator('#ro-route').selectOption(alternate.route_id); await eng.locator('#ro-pct').fill('20'); }
        await eng.locator('#ro-reason').fill(reason);
        await eng.locator('#ro-submit').click();
        await until(`rollout ${action}`, async () => {
          const row = await one<{ active_route_id: string; canary_route_id: string | null }>('SELECT active_route_id, canary_route_id FROM ai_rollout WHERE use_case_id = $1 AND environment = $2', [uc, 'lab']);
          return row?.active_route_id === expectedActive && row.canary_route_id === expectedCanary;
        }, 20_000);
        await eng.goto(`${BASE}/ingenieria#/caso/${uc}`);
        await eng.getByText('Prompt Studio').waitFor();
      };
      try {
        await rollout('canary', 'DEC-0073 comparar alternativa OpenAI directa ya evaluada y aprobada al veinte por ciento', baseline.active_route_id, alternate.route_id);
        await shot(eng, 'eng-01-canary-directo', true);
        await rollout('promote', 'DEC-0073 promover alternativa OpenAI directa evaluada para demostrar rollback real', alternate.route_id, null);
        await rollout('rollback', 'DEC-0073 restaurar ruta OpenAI directa inicial después del canary', baseline.active_route_id, null);
      } finally {
        const current = await one<{ active_route_id: string; canary_route_id: string | null }>('SELECT active_route_id, canary_route_id FROM ai_rollout WHERE use_case_id = $1 AND environment = $2', [uc, 'lab']);
        if (current?.active_route_id === alternate.route_id) await rollout('rollback', 'DEC-0073 recuperar baseline OpenAI directo tras interrupción', baseline.active_route_id, null);
        else if (current?.canary_route_id === alternate.route_id) await rollout('clear_canary', 'DEC-0073 retirar canary OpenAI directo tras interrupción', baseline.active_route_id, null);
      }
      await shot(eng, 'eng-03-canary-rollback-historial', true);
      const evs = (await pool.query<{ action: string }>(`SELECT action FROM ai_rollout_event WHERE use_case_id = $1 AND environment = 'lab' AND rollout_version > $2 ORDER BY rollout_version`, [uc, baseline.version])).rows.map((r) => r.action);
      check(evs.join(',') === 'canary,promote,rollback', 'E04 canary OpenAI directo 20 %, promoción y rollback auditados; baseline restaurado sin redeploy');
    }
    completed = true;
  } finally {
    if (!completed) blocked('recorrido interrumpido antes de completar sus comprobaciones; no es un E2E aprobado');
    check(pageErrors.length === 0, `sin errores de JavaScript en el panel${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
    await browser.close();
    await reportCosts();
    say(`\n# Resultado: ${failures === 0 ? 'OK' : `BLOCKED/FAIL (${failures} comprobaciones no aprobadas)`}${BLOCKED_PROVIDERS ? ' · solo subconjunto, no aceptación completa' : ''}`);
    writeFileSync(EVIDENCE, `${transcript.join('\n')}\n`);
    await pool.end();
    if (failures) process.exitCode = 1;
  }

}

main().catch(async (err) => {
  const message = (err instanceof Error ? err.message : String(err)).replace(/invitacion#[A-Za-z0-9_-]+/g, 'invitacion#<TOKEN>');
  say(`FAIL escenario interrumpido: ${message}`);
  await reportCosts().catch((costError) => say(`FAIL no se pudo cerrar el libro: ${costError instanceof Error ? costError.message : String(costError)}`));
  mkdirSync('evidence/ai-core', { recursive: true });
  writeFileSync(EVIDENCE, `${transcript.join('\n')}\n`);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
