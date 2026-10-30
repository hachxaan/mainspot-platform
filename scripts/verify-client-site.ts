/**
 * Verificación REAL del sitio local por negocio (DEV-E2E-04 P3) contra el servidor persistente
 * (`mainspot-local.service`, BD mainspot_dev) y el proxy HTTPS del LXC webserver, en Chrome real
 * (playwright-core, sin ignoreHTTPSErrors) y con TLS verificado también desde Node (CA del sistema).
 *
 *   set -a; . ./.env; set +a; DATABASE_URL=<url de mainspot_dev> node scripts/verify-client-site.ts \
 *       --business "Taquería El Faro" --email faro@example.com [--other-slug panaderia-lupita]
 *
 * Recorrido: alta por invitación (el enlace nunca se imprime) → datos del negocio → primera
 * página aprobada (v1) → provisión del sitio con scripts/client-site-provision.sh (sudo/lxc) →
 * https://<slug>.mainspot.local.io en Chrome (contenido, teléfono, TLS) → cambio por chat (v2) →
 * «Restaurar esta versión» 1 con vista previa «actual vs solicitada» y aprobación (v3) → recarga,
 * reinicio del servicio (sudo systemctl restart mainspot-local), slug desconocido 404 y aislamiento
 * con --other-slug (se provisiona y se retira al final). Escribe evidence/website-restore-local-sites.txt
 * (sin tokens, contraseñas ni correos).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import tls from 'node:tls';
import pg from 'pg';
import { chromium, type Browser, type Page } from 'playwright-core';
import { loadConfigTool } from '../src/shared/config.ts';
import { localSiteHostname } from '../src/website/local-site.ts';

tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cfg = loadConfigTool();
const BASE = cfg.publicBaseUrl;
const DOMAIN = cfg.localSiteDomain;
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const transcript: string[] = [];
let failures = 0;
function say(line: string): void { transcript.push(line); console.log(line); }
function check(ok: boolean, label: string): void {
  if (!ok) failures += 1;
  say(`${ok ? 'PASS' : 'FAIL'} ${label}`);
}
function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(cmd, args, { env, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}
async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout esperando: ${label}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
async function get(url: string): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, body: await res.text(), headers: res.headers };
}
function certOf(host: string): Promise<{ authorized: boolean; cn: string; issuer: string; validTo: string; altNames: string }> {
  // Executor form: el lib de TypeScript del repo no incluye Promise.withResolvers.
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host }, () => {
      const c = s.getPeerCertificate();
      resolve({ authorized: s.authorized, cn: String(c.subject?.CN ?? ''), issuer: String(c.issuer?.CN ?? c.issuer?.O ?? ''), validTo: c.valid_to, altNames: c.subjectaltname ?? '' });
      s.end();
    });
    s.on('error', reject);
  });
}

async function main(): Promise<void> {
  const business = arg('business');
  const email = arg('email');
  const otherSlug = arg('other-slug');
  if (!business || !email) {
    console.error('uso: node scripts/verify-client-site.ts --business "<nombre>" --email <correo> [--other-slug <slug publicado de otro negocio>]');
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> => (await pool.query<T>(sql, params)).rows[0];
  let browser: Browser | null = null;
  let page: Page | null = null;
  const head = sh('git', ['rev-parse', 'HEAD']);
  say(`# WEB-RESTORE / WEB-LOCAL — verificación REAL (run ${new Date().toISOString()}) · HEAD ${head}`);
  say(`# panel: ${BASE} · sitios: https://<slug>.${DOMAIN} · Chrome ${CHROME} headless, sin ignoreHTTPSErrors · Node con CA del sistema`);
  say('# BD: mainspot_dev (servicio mainspot-local) · sin tokens, contraseñas ni correos en este archivo');

  try {
    // ---------- Alta real por invitación (el enlace solo vive en memoria) ----------
    const inv = JSON.parse(sh(process.execPath, ['scripts/invite-owner.ts', '--business', business, '--email', email, '--base', BASE], { ...process.env, LOG_LEVEL: 'error' })) as { tenant_id: string; invitation_link: string };
    const tenant = inv.tenant_id;
    say(`\n-- Alta: negocio «${business}» (tenant ${tenant}) por invitación de un solo uso --`);
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'es-MX' });
    page = await ctx.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    const password = `Faro-${crypto.randomUUID().slice(0, 8)}-2026`;
    await page.goto(inv.invitation_link);
    await page.locator('a[href="#/activar/contrasena"]').click();
    await page.locator('#p-name').fill('Dueña de prueba');
    await page.locator('#p-pass').fill(password);
    await page.locator('#p-pass2').fill(password);
    await page.locator('#pass-submit').click();
    await page.waitForURL(/#\/activar\/negocio/);
    await page.locator('#b-line').fill('Tacos al pastor y de asada, todas las noches');
    await page.locator('#ph-num-primary').fill('983 123 4567');
    await page.locator('#b-address').fill('Av. Héroes 45, Chetumal');
    await page.locator('#b-hw').fill('18:00 a 23:00');
    await page.locator('#b-hs').fill('18:00 a 00:00');
    await page.locator('#b-hd').fill('Cerrado');
    await page.locator('#b-service').fill('Tacos al pastor');
    await page.locator('[data-action="service-add"]').click();
    await page.locator('#biz-submit').click();
    await page.waitForURL(/#\/activar\/telegram/);
    const site = await until('client_website', () => one<{ slug: string; published_version: number }>('SELECT slug, published_version FROM client_website WHERE tenant_id = $1', [tenant]));
    const slug = site.slug;
    const host = localSiteHostname(slug, DOMAIN);
    const url = `https://${host}/`;
    check(site.published_version === 0, `página creada con slug «${slug}» (sin publicar; versión 0)`);

    // ---------- Provisión REAL del sitio (hosts + cert CA local + vhost LXC + registro BD) ----------
    say(`\n-- Provisión del sitio local ${url} (scripts/client-site-provision.sh ${slug}) antes de publicar --`);
    const prov = sh('scripts/client-site-provision.sh', [slug]);
    say(prov.split('\n').map((l) => `   ${l}`).join('\n'));
    const prov2 = sh('scripts/client-site-provision.sh', [slug]);
    check(/ya existe/.test(prov2) && /ya está habilitado/.test(prov2), 'repetir la provisión es idempotente (no duplica hosts/cert/vhost)');
    const reg = await one<{ s: string; h: string }>('SELECT local_site_status AS s, local_site_hostname AS h FROM client_website WHERE tenant_id = $1', [tenant]);
    check(reg?.s === 'provisioned' && reg.h === host, 'estado «provisioned» registrado en BD por el comando de operación (el proceso web no usa sudo)');
    const cert = await certOf(host);
    check(cert.authorized && cert.altNames.split(', ').includes(`DNS:${host}`), `certificado válido para ${host} (emisor: ${cert.issuer}; vence ${cert.validTo}; SAN ${cert.altNames})`);
    const siteCtx = await browser.newContext({ viewport: { width: 1024, height: 800 }, locale: 'es-MX' });
    const sitePage = await siteCtx.newPage();
    const r0 = await sitePage.goto(url);
    const t0 = await sitePage.locator('body').innerText();
    check(r0?.status() === 404 && !t0.includes('Tacos al pastor') && t0.includes('no está publicada'), `Chrome ${url} sin versión publicada → ${r0?.status()} (ningún borrador llega al sitio)`);

    // ---------- Primera publicación (v1) por el flujo real del panel ----------
    say('\n-- Primera página: vista previa → aprobación (Administración) → v1 --');
    await page.evaluate(() => { (globalThis as unknown as { location: { hash: string } }).location.hash = '#/inicio'; });
    await page.getByRole('link', { name: 'Revisar mi primera página' }).first().click();
    await page.locator('#approve-btn').click();
    await page.locator('.sheet [data-sheet="0"]').click();
    await page.getByText('Ya está en tu página (versión 1)').waitFor();
    check((await one<{ v: number }>('SELECT published_version AS v FROM client_website WHERE tenant_id = $1', [tenant]))?.v === 1, 'versión 1 publicada tras aprobación humana');

    // ---------- TLS y contenido reales ----------
    say('\n-- HTTPS real: Chrome y Node con la CA local, sin bypass --');
    const v1 = await get(url);
    check(v1.status === 200 && v1.body.includes('Tacos al pastor') && v1.body.includes('+52 983 123 4567') && v1.body.includes('versión 1'), `Node GET ${url} → ${v1.status}, contenido y teléfono del canal visibles (versión 1)`);
    check(v1.headers.get('cache-control') === 'no-store' && (v1.headers.get('content-security-policy') ?? '').includes("default-src 'self'"), 'cabeceras de seguridad y no-store en el sitio');
    const r1 = await sitePage.goto(url);
    const sec = r1 ? await r1.securityDetails() : null;
    const t1 = await sitePage.locator('body').innerText();
    check(r1?.status() === 200 && sec !== null && t1.includes('Tacos al pastor') && t1.includes('+52 983 123 4567') && t1.includes('versión 1'), `Chrome ${url} → ${r1?.status()} con TLS (emisor ${sec?.issuer ?? '?'}, ${sec?.protocol ?? '?'}), contenido y teléfono visibles`);
    mkdirSync('evidence/website-local-site', { recursive: true });
    await sitePage.screenshot({ path: `evidence/website-local-site/01-${slug}-v1.png` });

    // ---------- Cambio B por chat (v2) ----------
    say('\n-- Cambio B por chat: sección «Promociones» → vista previa → aprobación → v2 --');
    await page.evaluate(() => { (globalThis as unknown as { location: { hash: string } }).location.hash = '#/cambios/nuevo'; });
    await page.locator('#panel-input').fill('agrega la sección promociones a mi web');
    await page.locator('#panel-send').click();
    await page.getByRole('button', { name: 'Sí, prepara la vista previa' }).click();
    await page.getByRole('button', { name: 'Ver vista previa' }).last().click();
    await page.locator('#approve-btn').click();
    await page.locator('.sheet [data-sheet="0"]').click();
    await page.getByText('Ya está en tu página (versión 2)').waitFor();
    await sitePage.reload();
    const t2 = await sitePage.locator('body').innerText();
    check(t2.includes('Promociones') && t2.includes('versión 2'), 'Chrome: el sitio muestra la versión 2 (con «Promociones») tras la aprobación');
    await sitePage.screenshot({ path: `evidence/website-local-site/02-${slug}-v2.png` });

    // ---------- Restaurar v1 (A→B→A) como versión 3, con vista previa y aprobación ----------
    say('\n-- Restaurar esta versión (1) desde «Mi página»: confirmación → vista previa actual vs solicitada → aprobación → v3 --');
    await page.evaluate(() => { (globalThis as unknown as { location: { hash: string } }).location.hash = '#/pagina'; });
    await page.locator('#versions').waitFor();
    const versionsText = await page.locator('#versions').innerText();
    check(/Versión 2[\s\S]*Publicada[\s\S]*Versión 1/.test(versionsText), 'lista de versiones: 2 (publicada) y 1');
    await page.screenshot({ path: `evidence/website-local-site/03-mi-pagina-versiones.png` });
    await page.locator('[data-action="restore-ask"][data-arg="1"]').click();
    await page.getByText('¿Restaurar la versión 1?').waitFor();
    await page.locator('.sheet [data-sheet="0"]').click();
    await page.waitForURL(/#\/vista-previa\//);
    await page.locator('#approve-btn').waitFor();
    const previewText = await page.locator('main').innerText();
    check(previewText.includes('Esto es lo que cambia') && previewText.includes('Promociones') && (await page.locator('.segmented button', { hasText: 'Antes' }).count()) === 1, 'vista previa «actual vs solicitada»: diff con la sección que desaparece y comparador Antes/Después');
    await page.screenshot({ path: `evidence/website-local-site/04-vista-previa-restaurar.png` });
    const liveBefore = await get(url);
    check(liveBefore.body.includes('versión 2'), 'antes de aprobar, el sitio sigue en la versión 2 (nada en vivo sin aprobación)');
    await page.locator('#approve-btn').click();
    await page.locator('.sheet [data-sheet="0"]').click();
    await page.getByText('Ya está en tu página (versión 3)').waitFor();
    const rows = (await pool.query<{ version: number; html: string; restored_from_version: number | null }>('SELECT version, html, restored_from_version FROM website_content WHERE tenant_id = $1 ORDER BY version', [tenant])).rows;
    check(rows.length === 3 && rows[2]!.restored_from_version === 1 && rows[2]!.html === rows[0]!.html.replace('versión 1', 'versión 3') && !rows[2]!.html.includes('Promociones'), 'versión 3 = contenido de la 1 (referencia restored_from_version=1); versiones 1 y 2 intactas');
    await sitePage.reload();
    const t3 = await sitePage.locator('body').innerText();
    check(!t3.includes('Promociones') && t3.includes('versión 3') && t3.includes('Tacos al pastor'), 'Chrome: el sitio muestra la versión 3 (contenido de la 1) tras la aprobación');
    await sitePage.screenshot({ path: `evidence/website-local-site/05-${slug}-v3-restaurada.png` });
    await page.evaluate(() => { (globalThis as unknown as { location: { hash: string } }).location.hash = '#/pagina'; });
    await page.locator('#versions').waitFor();
    check((await page.locator('#versions').innerText()).includes('restaurada de la versión 1'), '«Mi página» muestra la versión 3 como restaurada de la 1');
    await page.screenshot({ path: `evidence/website-local-site/06-mi-pagina-v3.png` });

    // ---------- Persistencia: recarga y reinicio del servicio ----------
    say('\n-- Persistencia: recarga del navegador y reinicio de mainspot-local --');
    await sitePage.reload();
    check((await sitePage.locator('body').innerText()).includes('versión 3'), 'recarga: sigue la versión 3');
    sh('sudo', ['-n', 'systemctl', 'restart', 'mainspot-local']);
    await until('health tras reinicio', async () => (await get(`${BASE}/health`)).status === 200);
    const afterRestart = await get(url);
    check(afterRestart.status === 200 && afterRestart.body.includes('versión 3'), 'tras reiniciar el servicio, el sitio sirve la versión 3');

    // ---------- Negativos: slug desconocido y host del panel ----------
    say('\n-- Negativos --');
    const unknownHost = `no-existe-${crypto.randomUUID().slice(0, 6)}.${DOMAIN}`;
    let unknownResult = 'sin resolución local (hosts no tiene entrada: no se provisiona nada para un slug desconocido)';
    try {
      const r = await get(`https://${unknownHost}/`);
      unknownResult = `HTTP ${r.status}`;
    } catch (err) {
      unknownResult += `: ${(err as Error).message.split('\n')[0]}`;
    }
    say(`   https://${unknownHost}/ → ${unknownResult}`);
    const unknownViaProxy = await fetch(url, { headers: { Host: unknownHost } }).catch(() => null);
    say(`   (misma IP del proxy con Host desconocido → HTTP ${unknownViaProxy?.status ?? 'sin respuesta'}; nginx aplica su sitio por defecto, no el de este negocio)`);
    const apiUnderSite = await get(`${url}api/backoffice/website`);
    const healthUnderSite = await get(`${url}health`);
    check(apiUnderSite.status === 404 && healthUnderSite.status === 404, 'bajo el host del sitio no existen API ni /health (404)');
    const unknownInApp = await fetch(url, { headers: { Host: unknownHost } }).then((r) => r.status).catch(() => 0);
    say(`   nota: slug desconocido con el vhost del sitio → HTTP ${unknownInApp} (nginx decide por server_name; el 404 de Express se prueba en tests/integration/website-restore-local-site.test.ts)`);

    // ---------- Aislamiento con otro negocio publicado ----------
    if (otherSlug) {
      say(`\n-- Aislamiento: otro negocio (${otherSlug}); los sitios previos se conservan --`);
      const otherHost = localSiteHostname(otherSlug, DOMAIN);
      const wasProvisioned = (await one<{ s: string | null }>('SELECT local_site_status AS s FROM client_website WHERE slug = $1', [otherSlug]))?.s === 'provisioned';
      say(sh('scripts/client-site-provision.sh', [otherSlug]).split('\n').map((l) => `   ${l}`).join('\n'));
      const other = await get(`https://${otherHost}/`);
      const otherName = (await one<{ n: string }>('SELECT site_name AS n FROM client_website WHERE slug = $1', [otherSlug]))?.n ?? '';
      check(other.status === 200 && other.body.includes(otherName) && !other.body.includes(business), `https://${otherHost}/ muestra «${otherName}» y nada de «${business}»`);
      const mine = await get(url);
      check(!mine.body.includes(otherName), `${url} no muestra nada de «${otherName}»`);
      const otherPage = await siteCtx.newPage();
      const ro = await otherPage.goto(`https://${otherHost}/`);
      check(ro?.status() === 200 && (await otherPage.locator('body').innerText()).includes(otherName), `Chrome ${otherHost} → ${ro?.status()} con TLS válido`);
      await otherPage.screenshot({ path: `evidence/website-local-site/07-${otherSlug}.png` });
      await otherPage.close();
      if (!wasProvisioned) {
      say(sh('scripts/client-site-provision.sh', [otherSlug, '--remove']).split('\n').map((l) => `   ${l}`).join('\n'));
      const removed = await one<{ s: string }>('SELECT local_site_status AS s FROM client_website WHERE slug = $1', [otherSlug]);
      let afterRemove = 'sin resolución local';
      try { afterRemove = `HTTP ${(await get(`https://${otherHost}/`)).status}`; } catch (err) { afterRemove += `: ${(err as Error).message.split('\n')[0]}`; }
      check(removed?.s === 'removed' && !afterRemove.startsWith('HTTP 200'), `--remove: estado «removed» y ${otherHost} ya no sirve (${afterRemove})`);
      const stillMine = await get(url);
      check(stillMine.status === 200 && stillMine.body.includes('versión 3'), `retirar otro sitio no afecta a ${url}`);
      } else {
        check((await get(`https://${otherHost}/`)).status === 200, 'el sitio ya provisionado del otro negocio se conserva intacto');
      }
    }

    check(pageErrors.length === 0, `sin errores de JavaScript en el panel${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`);
    say(`\n# Sitio real entregado: ${url} (tenant ${tenant}, versiones 1→2→3, v3 restaurada de v1)`);
  } catch (err) {
    failures += 1;
    const message = (err instanceof Error ? err.message : String(err)).replace(/(invitacion#)[A-Za-z0-9_-]+/g, '$1<TOKEN>');
    say(`FAIL escenario interrumpido: ${message}`);
    throw new Error(message);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await pool.end();
    say(`\n# Resultado: ${failures === 0 ? 'OK' : `${failures} comprobaciones fallidas`}`);
    mkdirSync('evidence', { recursive: true });
    writeFileSync('evidence/website-restore-local-sites.txt', `${transcript.join('\n')}\n`);
    console.log('EVIDENCE_SAVED evidence/website-restore-local-sites.txt');
  }
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
