/**
 * Unit — DEV-E2E-04 §3: transportes de correo contra servidores FALSOS en proceso (127.0.0.1).
 * SIMULATED_REGRESSION: prueba el protocolo y las garantías (TLS obligatorio, sin degradación a
 * texto claro, sin datos personales en registros, `disabled` nunca finge envío); NO demuestra
 * entrega real con un proveedor.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DisabledMailer, ResendMailer, SmtpMailer, createMailer } from '../../src/mail/mailer.ts';
import { loadMailConfig, mailBlockedPrerequisites, type MailConfig } from '../../src/mail/config.ts';
import { captureStdout } from '../helpers/capture-stdout.ts';

/* ---------- Servidor SMTP falso (implícito, STARTTLS o solo texto claro) ---------- */
type TlsMode = 'implicit' | 'starttls' | 'none';

class FakeSmtp {
  readonly transcript: string[] = [];
  readonly messages: string[] = [];
  readonly authUsers: string[] = [];
  private server: net.Server | tls.Server | null = null;
  private readonly mode: TlsMode;
  private readonly ctx?: tls.SecureContextOptions;

  constructor(mode: TlsMode, ctx?: tls.SecureContextOptions) {
    this.mode = mode;
    this.ctx = ctx;
  }

  async listen(): Promise<number> {
    const onConn = (sock: net.Socket) => this.session(sock, this.mode === 'implicit');
    this.server = this.mode === 'implicit' ? tls.createServer(this.ctx ?? {}, onConn) : net.createServer(onConn);
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return (this.server!.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private session(initial: net.Socket, secured: boolean): void {
    let sock = initial;
    let buffer = '';
    let inData = false;
    let data: string[] = [];
    const write = (s: string) => sock.write(s);
    const attach = () => {
      sock.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let i: number;
        while ((i = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (inData) {
            if (line === '.') { inData = false; this.messages.push(data.join('\r\n')); data = []; write('250 2.0.0 Ok: queued as 42\r\n'); }
            else data.push(line);
            continue;
          }
          this.transcript.push(line);
          const cmd = line.split(' ')[0]?.toUpperCase() ?? '';
          if (cmd === 'EHLO' || cmd === 'HELO') {
            write('250-fake.local\r\n' + (this.mode === 'starttls' && !secured ? '250-STARTTLS\r\n' : '') + '250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
          } else if (cmd === 'STARTTLS' && this.mode === 'starttls' && !secured) {
            write('220 2.0.0 Ready to start TLS\r\n');
            sock.removeAllListeners('data');
            sock = new tls.TLSSocket(initial, { isServer: true, secureContext: tls.createSecureContext(this.ctx ?? {}) });
            secured = true;
            attach();
            return;
          } else if (cmd === 'AUTH') {
            const parts = line.split(' ');
            const decoded = Buffer.from(parts[2] ?? '', 'base64').toString('utf8').split('\0');
            this.authUsers.push(decoded[1] ?? '');
            write('235 2.7.0 Authentication successful\r\n');
          } else if (cmd === 'DATA') { inData = true; write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
          else if (cmd === 'QUIT') { write('221 2.0.0 Bye\r\n'); sock.end(); }
          else write('250 2.1.0 Ok\r\n');
        }
      });
    };
    attach();
    write('220 fake.local ESMTP\r\n');
  }
}

let certDir: string;
let certPem: string;
let keyPem: string;
let certFile: string;

before(() => {
  certDir = mkdtempSync(path.join(tmpdir(), 'msp-mail-'));
  certFile = path.join(certDir, 'cert.pem');
  const keyFile = path.join(certDir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  certPem = readFileSync(certFile, 'utf8');
  keyPem = readFileSync(keyFile, 'utf8');
});

after(() => rmSync(certDir, { recursive: true, force: true }));

function smtpConfig(port: number, secure: 'implicit' | 'starttls', extra: Partial<MailConfig> = {}): MailConfig {
  return {
    transport: 'smtp', from: 'MainSpot <no-responder@example.test>', smtpHost: '127.0.0.1', smtpPort: port,
    smtpUser: 'usuario-smtp', smtpPass: 'clave-smtp-de-prueba', smtpSecure: secure, smtpCaFile: certFile,
    resendApiKey: '', resendBaseUrl: 'https://api.resend.com', ...extra,
  };
}
const MSG = { to: 'destino@example.test', subject: 'Crea una contraseña nueva para MainSpot', text: 'Enlace: https://app.mainspot.local.io/restablecer#tok', html: '<p>Enlace</p>' };

test('SMTP implícito (465): TLS desde la conexión, AUTH PLAIN y mensaje aceptado; registros sin destinatario', async () => {
  const srv = new FakeSmtp('implicit', { cert: certPem, key: keyPem });
  const port = await srv.listen();
  const mailer = new SmtpMailer(smtpConfig(port, 'implicit'));
  const cap = captureStdout();
  try {
    const r = await mailer.send(MSG);
    cap.restore();
    assert.equal(r.sent, true, JSON.stringify(r));
    assert.deepEqual(srv.authUsers, ['usuario-smtp']);
    assert.ok(srv.transcript.some((l) => /^MAIL FROM:<no-responder@example.test>/i.test(l)));
    assert.ok(srv.transcript.some((l) => /^RCPT TO:<destino@example.test>/i.test(l)));
    assert.equal(srv.messages.length, 1);
    assert.ok(srv.messages[0]!.includes('https://app.mainspot.local.io/restablecer#tok'), 'el cuerpo llega con el enlace');
    assert.ok(/^Subject: /m.test(srv.messages[0]!));
    const logs = cap.lines.filter((l) => l.includes('"event":"mail.sent"'));
    assert.equal(logs.length, 1);
    assert.ok(!cap.lines.some((l) => l.includes('destino@example.test') || l.includes('clave-smtp-de-prueba')), 'ni destinatario ni credencial en registros');
  } finally {
    cap.restore();
    mailer.close();
    await srv.close();
  }
});

test('SMTP STARTTLS (587): se exige STARTTLS y el mensaje viaja ya cifrado', async () => {
  const srv = new FakeSmtp('starttls', { cert: certPem, key: keyPem });
  const port = await srv.listen();
  const mailer = new SmtpMailer(smtpConfig(port, 'starttls'));
  try {
    const r = await mailer.send(MSG);
    assert.equal(r.sent, true, JSON.stringify(r));
    const starttlsAt = srv.transcript.findIndex((l) => l.toUpperCase() === 'STARTTLS');
    const mailFromAt = srv.transcript.findIndex((l) => /^MAIL FROM/i.test(l));
    const authAt = srv.transcript.findIndex((l) => /^AUTH /i.test(l));
    assert.ok(starttlsAt >= 0 && mailFromAt > starttlsAt && authAt > starttlsAt, 'credenciales y correo solo después de STARTTLS');
    assert.equal(srv.messages.length, 1);
  } finally {
    mailer.close();
    await srv.close();
  }
});

test('SMTP sin TLS disponible: NO hay degradación a texto claro (ni credenciales ni correo salen)', async () => {
  const plain = new FakeSmtp('none');
  const port = await plain.listen();
  const starttls = new SmtpMailer(smtpConfig(port, 'starttls'));
  const implicit = new SmtpMailer(smtpConfig(port, 'implicit'));
  const cap = captureStdout();
  try {
    const r1 = await starttls.send(MSG);
    const r2 = await implicit.send(MSG);
    cap.restore();
    assert.deepEqual(r1, { sent: false, provider: 'smtp', reason: 'transport_error' });
    assert.deepEqual(r2, { sent: false, provider: 'smtp', reason: 'transport_error' });
    assert.ok(!plain.transcript.some((l) => /^(AUTH|MAIL FROM|RCPT TO|DATA)/i.test(l)), `nada sensible en claro: ${plain.transcript.join(' | ')}`);
    assert.equal(plain.messages.length, 0);
    assert.ok(cap.lines.filter((l) => l.includes('"event":"mail.send_failed"')).length >= 2);
    assert.ok(!cap.lines.some((l) => l.includes('destino@example.test')));
  } finally {
    cap.restore();
    starttls.close();
    implicit.close();
    await plain.close();
  }
});

test('SMTP: certificado no confiable → rechazo (rejectUnauthorized) sin enviar', async () => {
  const srv = new FakeSmtp('implicit', { cert: certPem, key: keyPem });
  const port = await srv.listen();
  const mailer = new SmtpMailer(smtpConfig(port, 'implicit', { smtpCaFile: '' }));
  try {
    const r = await mailer.send(MSG);
    assert.equal(r.sent, false);
    assert.equal(srv.messages.length, 0);
  } finally {
    mailer.close();
    await srv.close();
  }
});

test('SMTP: configuración incompleta falla al construir (fail fast)', () => {
  assert.throws(() => new SmtpMailer(smtpConfig(2525, 'starttls', { smtpHost: '' })), /SMTP_HOST/);
  assert.throws(() => new SmtpMailer(smtpConfig(2525, 'starttls', { from: '' })), /MAIL_FROM/);
  assert.throws(() => new SmtpMailer(smtpConfig(2525, 'starttls', { smtpPass: '' })), /SMTP_USER y SMTP_PASS/);
  assert.throws(() => new SmtpMailer(smtpConfig(0, 'starttls')), /SMTP_PORT/);
});

/* ---------- API HTTP transaccional (Resend) contra servidor HTTP falso ---------- */
async function fakeHttp(status: number, body: unknown): Promise<{ url: string; seen: Array<{ auth: string | undefined; body: unknown; path: string }>; close: () => Promise<void> }> {
  const seen: Array<{ auth: string | undefined; body: unknown; path: string }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null, path: req.url ?? '' });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function resendConfig(baseUrl: string, apiKey = 're_clave_de_prueba'): MailConfig {
  return { transport: 'resend', from: 'MainSpot <no-responder@example.test>', smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '', smtpSecure: 'starttls', smtpCaFile: '', resendApiKey: apiKey, resendBaseUrl: baseUrl };
}

test('Resend: POST /emails con Bearer y campos del mensaje; id del proveedor en el resultado', async () => {
  const fake = await fakeHttp(200, { id: 'msg_abc123' });
  try {
    const r = await new ResendMailer(resendConfig(fake.url)).send(MSG);
    assert.deepEqual(r, { sent: true, provider: 'resend', message_id: 'msg_abc123' });
    assert.equal(fake.seen.length, 1);
    assert.equal(fake.seen[0]!.path, '/emails');
    assert.equal(fake.seen[0]!.auth, 'Bearer re_clave_de_prueba');
    assert.deepEqual(fake.seen[0]!.body, { from: 'MainSpot <no-responder@example.test>', to: ['destino@example.test'], subject: MSG.subject, text: MSG.text, html: MSG.html });
  } finally { await fake.close(); }
});

test('Resend: clave rechazada (401) → sent:false sin lanzar; registro con estado HTTP y sin destinatario', async () => {
  const fake = await fakeHttp(401, { message: 'invalid api key' });
  const cap = captureStdout();
  try {
    const r = await new ResendMailer(resendConfig(fake.url)).send(MSG);
    cap.restore();
    assert.deepEqual(r, { sent: false, provider: 'resend', reason: 'transport_error' });
    const failed = cap.lines.filter((l) => l.includes('"event":"mail.send_failed"'));
    assert.equal(failed.length, 1);
    assert.ok(failed[0]!.includes('"http_status":401') && !failed[0]!.includes('destino@') && !failed[0]!.includes('re_clave'));
  } finally { cap.restore(); await fake.close(); }
});

test('Resend: solo HTTPS salvo el servidor falso local; configuración incompleta falla al construir', () => {
  assert.throws(() => new ResendMailer(resendConfig('http://api.resend.com')), /https/);
  assert.throws(() => new ResendMailer(resendConfig('https://api.resend.com', '')), /RESEND_API_KEY/);
  assert.doesNotThrow(() => new ResendMailer(resendConfig('https://api.resend.com')));
});

/* ---------- disabled + configuración ---------- */
test('disabled: nunca envía, nunca finge, registra mail.transport_disabled sin datos personales', async () => {
  const mailer = new DisabledMailer();
  const cap = captureStdout();
  const r = await mailer.send();
  cap.restore();
  assert.deepEqual(r, { sent: false, provider: 'disabled', reason: 'transport_disabled' });
  assert.equal(mailer.enabled, false);
  assert.equal(cap.lines.filter((l) => l.includes('"event":"mail.transport_disabled"')).length, 1);
  assert.equal((await mailer.verify()).ok, false);
});

test('loadMailConfig: disabled por defecto; valores inválidos fallan; SMTP_SECURE se deduce del puerto', () => {
  const base = loadMailConfig({});
  assert.equal(base.transport, 'disabled');
  assert.equal(createMailer(base).provider, 'disabled');
  assert.throws(() => loadMailConfig({ MAIL_TRANSPORT: 'sendmail' }), /MAIL_TRANSPORT/);
  assert.throws(() => loadMailConfig({ SMTP_SECURE: 'plain' }), /SMTP_SECURE/);
  assert.equal(loadMailConfig({ SMTP_PORT: '465' }).smtpSecure, 'implicit');
  assert.equal(loadMailConfig({ SMTP_PORT: '587' }).smtpSecure, 'starttls');
  assert.equal(loadMailConfig({ SMTP_PORT: '465', SMTP_SECURE: 'starttls' }).smtpSecure, 'starttls');
  assert.deepEqual(mailBlockedPrerequisites(base), ['MAIL_TRANSPORT', 'MAIL_FROM', 'SMTP_HOST|RESEND_API_KEY']);
  assert.deepEqual(mailBlockedPrerequisites(loadMailConfig({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.test' })), ['SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']);
  assert.deepEqual(mailBlockedPrerequisites(loadMailConfig({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'x', MAIL_FROM: 'a@b.c' })), []);
  // smtp sin host: createMailer falla al arrancar (nunca un transporte a medias).
  assert.throws(() => createMailer(loadMailConfig({ MAIL_TRANSPORT: 'smtp' })), /SMTP_HOST/);
});
