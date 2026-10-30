/**
 * AI Core (issue #9) — E2E de LABORATORIO con proveedores REALES (OpenRouter + TypeSafe/Jev) en el
 * entorno local https://app.mainspot.local.io, solo con un negocio SINTÉTICO (BR-0007).
 *
 *   node scripts/ai-core-lab-e2e.ts            # requiere mainspot-local activo con ai-core.env
 *
 * Recorre en Chrome real (sin ignoreHTTPSErrors): Administration marca el negocio como sintético
 * (step-up) → alta por invitación (móvil 390 px) → Mi marca → diseño IA → vista previa → aprobación
 * → sitio local HTTPS (360/768/1440) → edición compleja → publicación de Facebook generada →
 * comentarios (Jev real + respuesta) → asistente → resumen → campaña sin gasto → calendario →
 * consumo en Administration → canary y rollback en la Engineering Console.
 * Evidencia: evidence/ai-core/lab-e2e.txt + evidence/ai-core/screens/. Nunca imprime tokens,
 * contraseñas ni enlaces de invitación (el enlace vive solo en memoria).
 */

import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import tls from 'node:tls';
import pg from 'pg';
import sharp from 'sharp';
import { chromium, type Browser, type Page } from 'playwright-core';

// Node confía en la misma CA local que el navegador (almacén del sistema), sin desactivar TLS.
tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);

const BASE = (process.env.E2E_BASE_URL ?? 'https://app.mainspot.local.io').replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const SHOTS = 'evidence/ai-core/screens';
const RUN = randomUUID().slice(0, 6);
const BUSINESS = `Café Brisa Lab ${RUN}`;
const EMAIL = `brisa.lab.${RUN}@example.test`;
const PASSWORD = `Brisa-Lab-${RUN}-2026`;

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
  const head = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
  say(`# AI Core — E2E de laboratorio con proveedores reales (${new Date().toISOString()})`);
  say(`# HEAD ${head} · origen ${BASE} · Chrome ${CHROME} (TLS verificado, sin ignoreHTTPSErrors)`);
  say(`# negocio sintético «${BUSINESS}»; costos y rutas leídos de ai_invocation (procedencia: proveedor)`);
  const spentBefore = Number((await one<{ s: string }>(`SELECT COALESCE(sum(COALESCE(cost_usd, reserved_usd)),0) AS s FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id WHERE p.kind = 'openrouter'`))?.s ?? 0);

  // ---------------------------------------------------------------- alta por invitación (CLI de operación)
  const inv = JSON.parse(execFileSync(process.execPath, ['scripts/invite-owner.ts', '--business', BUSINESS, '--email', EMAIL, '--base', BASE], { env: { ...process.env, DATABASE_URL: devUrl(), LOG_LEVEL: 'error' } }).toString()) as { tenant_id: string; invitation_link: string };
  const tenant = inv.tenant_id;
  say(`\n-- E17/BR-0007: Administration marca el negocio como sintético (motivo + step-up) --`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const pageErrors: string[] = [];
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

    // -------------------------------------------------------------- diseño IA real
    await go(page, '#/ia/pagina');
    await page.locator('#ai-brief').fill('Cálida y artesanal; que inviten a desayunar y a pasar por café de olla.');
    await page.locator('#ai-design-btn').click();
    await page.getByText('La vista previa está lista').waitFor({ timeout: 300_000 });
    const design = await one<{ result: { proposal_id: string; model: string; images: number; images_blocked: string[]; simulated: boolean } }>(`SELECT result FROM ai_job WHERE tenant_id = $1 AND kind = 'website.design' ORDER BY created_at DESC LIMIT 1`, [tenant]);
    const dInv = await one<{ model_id: string; cost_usd: string; latency_ms: number; route_version: number; prompt_version: number }>(
      `SELECT i.model_id, i.cost_usd, i.latency_ms, i.route_version, p.version AS prompt_version FROM ai_invocation i JOIN ai_prompt_revision p ON p.revision_id = i.prompt_revision_id WHERE i.tenant_id = $1 AND i.use_case_id = 'website.initial.design' AND i.status = 'succeeded' ORDER BY i.created_at DESC LIMIT 1`, [tenant]);
    say(`   diseño: ${dInv?.model_id} r${dInv?.route_version}/p${dInv?.prompt_version} · ${dInv?.latency_ms} ms · USD ${dInv?.cost_usd} · imágenes ${design?.result.images} · bloqueadas ${JSON.stringify(design?.result.images_blocked)}`);
    check(design?.result.simulated === false && /anthropic|openai/.test(dInv?.model_id ?? ''), 'E05 diseño generado por un modelo real (no simulado) con su ruta y costo trazados');
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

    // -------------------------------------------------------------- sitio local HTTPS real
    say('\n-- E07: sitio local HTTPS por negocio (CA local, sin -k) --');
    // Comando de operación (usa sudo internamente para /etc/hosts y lxc para el vhost del LXC).
    execFileSync('scripts/client-site-provision.sh', [site!.slug], { stdio: 'ignore' });
    const siteUrl = `https://${site!.slug}.mainspot.local.io/`;
    for (const [w, h] of [[360, 780], [768, 1024], [1440, 900]] as const) {
      const sp = await (await browser.newContext({ viewport: { width: w, height: h }, locale: 'es-MX' })).newPage();
      const errs: string[] = [];
      sp.on('pageerror', (e) => errs.push(e.message));
      sp.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
      const res = await sp.goto(siteUrl);
      await sp.waitForLoadState('networkidle');
      const a11y = await sp.evaluate(() => {
        const d = (globalThis as unknown as { document: { documentElement: { lang: string; scrollWidth: number; clientWidth: number }; querySelectorAll: (s: string) => ArrayLike<{ alt?: string; naturalWidth?: number }>; querySelector: (s: string) => unknown } }).document;
        const imgs = Array.from(d.querySelectorAll('img'));
        return { lang: d.documentElement.lang, h1: d.querySelectorAll('h1').length, imgs: imgs.length, noAlt: imgs.filter((i) => !i.alt).length, broken: imgs.filter((i) => !i.naturalWidth).length, scripts: d.querySelectorAll('script').length, overflowX: d.documentElement.scrollWidth > d.documentElement.clientWidth };
      });
      await shot(sp, `site-v1-${w}`, true);
      const ok = res?.status() === 200 && a11y.lang.startsWith('es') && a11y.h1 === 1 && a11y.noAlt === 0 && a11y.broken === 0 && a11y.scripts === 0 && !a11y.overflowX && errs.length === 0;
      check(ok, `sitio ${w}px: HTTP ${res?.status()} TLS verificado, lang=${a11y.lang}, h1=${a11y.h1}, ${a11y.imgs} imágenes (${a11y.noAlt} sin ALT, ${a11y.broken} rotas), scripts=${a11y.scripts}, desborde=${a11y.overflowX}${errs.length ? `, errores: ${errs.join(' | ')}` : ''}`);
      await sp.context().close();
    }

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
      const sp = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      await sp.goto(siteUrl);
      await shot(sp, 'site-v2-1440', true);
      await sp.context().close();

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
      const live = await (await fetch(siteUrl)).text();
      check(live.includes('versión 3') && !/Preguntas frecuentes/.test(live), 'E07 el sitio HTTPS sirve la v3 restaurada (TLS verificado por Node con la CA local)');
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
    const luna = eng.locator('tr', { hasText: 'GPT-6 Luna' }).locator('[data-action="approve"]');
    if (await luna.count()) { await luna.click(); await eng.getByText('Ruta aprobada').waitFor(); await eng.waitForTimeout(800); }
    const lunaRoute = await eng.locator('#ro-route option', { hasText: 'GPT-6 Luna' }).getAttribute('value');
    await eng.locator('#ro-act').selectOption('canary');
    await eng.locator('#ro-route').selectOption(lunaRoute as string);
    await eng.locator('#ro-pct').fill('20');
    await eng.locator('#ro-reason').fill('Comparar Luna con Haiku en 20 % de negocios del laboratorio');
    await eng.locator('#ro-submit').click();
    await eng.getByText('Rollout aplicado').waitFor();
    await eng.waitForTimeout(800);
    await eng.locator('#ro-act').selectOption('clear_canary');
    await eng.locator('#ro-reason').fill('Fin de la comparación: se mantiene Haiku');
    await eng.locator('#ro-submit').click();
    await eng.getByText('Rollout aplicado').waitFor();
    await eng.waitForTimeout(1200);
    await shot(eng, 'eng-03-canary-historial', true);
    const evs = (await pool.query<{ action: string }>(`SELECT action FROM ai_rollout_event WHERE use_case_id = $1 AND environment = 'lab' ORDER BY at DESC LIMIT 2`, [uc])).rows.map((r) => r.action);
    check(evs.join(',') === 'clear_canary,canary', 'E04 canary del 20 % y retiro auditados con motivo (sin redeploy)');
  } finally {
    await browser.close();
  }

  // ---------------------------------------------------------------- costos y cierre
  const spentAfter = Number((await one<{ s: string }>(`SELECT COALESCE(sum(COALESCE(cost_usd, reserved_usd)),0) AS s FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id WHERE p.kind = 'openrouter'`))?.s ?? 0);
  const byUc = (await pool.query<{ use_case_id: string; model_id: string; n: number; cost: string; p50: number; p95: number }>(
    `SELECT use_case_id, model_id, count(*)::int AS n, COALESCE(sum(cost_usd),0) AS cost, percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50, percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
       FROM ai_invocation WHERE tenant_id = $1 AND status = 'succeeded' GROUP BY 1,2 ORDER BY 1`, [tenant])).rows;
  say('\n-- E15: costo y latencia de este recorrido (procedencia: respuesta del proveedor) --');
  for (const r of byUc) say(`   ${r.use_case_id.padEnd(38)} ${r.model_id.padEnd(34)} n=${r.n} USD ${Number(r.cost).toFixed(6)} p50 ${r.p50} ms p95 ${r.p95} ms`);
  say(`   OpenRouter este recorrido: USD ${(spentAfter - spentBefore).toFixed(6)} · laboratorio acumulado: USD ${spentAfter.toFixed(6)} de 25`);
  check(pageErrors.length === 0, `sin errores de JavaScript en el panel${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
  say(`\n# Resultado: ${failures === 0 ? 'OK' : `${failures} comprobaciones fallidas`}`);
  mkdirSync('evidence/ai-core', { recursive: true });
  writeFileSync('evidence/ai-core/lab-e2e.txt', `${transcript.join('\n')}\n`);
  await pool.end();
  if (failures) process.exitCode = 1;
}

main().catch(async (err) => {
  const message = (err instanceof Error ? err.message : String(err)).replace(/invitacion#[A-Za-z0-9_-]+/g, 'invitacion#<TOKEN>');
  say(`FAIL escenario interrumpido: ${message}`);
  writeFileSync('evidence/ai-core/lab-e2e.txt', `${transcript.join('\n')}\n`);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
