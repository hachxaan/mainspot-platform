/**
 * DEV-E2E-04 / issue #6 — registro del webhook REAL de Telegram con salvaguardas (Handoff 2 §D).
 *
 *   node scripts/telegram-webhook.ts status
 *       Solo lectura: getMe + getWebhookInfo del bot del archivo protegido. Nada cambia.
 *   node scripts/telegram-webhook.ts register --confirm-bot <username> --ready-for-webhook-registration
 *       [--replace-webhook-from <url-actual-exacta>]
 *       setWebhook https://tg.mainspot.io/telegram/webhook con secret_token, allowed_updates
 *       mínimos (["message"]: lo único que procesa TelegramLinkService), drop_pending_updates=false
 *       y max_connections=1; después confirma con getWebhookInfo.
 *
 * Salvaguardas (fail closed):
 *  - Token y secreto SOLO desde el archivo protegido (MAINSPOT_TELEGRAM_ENV_FILE o
 *    ~/.config/mainspot/telegram-webhook.env); se rechaza si es legible por grupo/otros. Nunca se
 *    imprimen, ni van en argumentos; los errores no incluyen la URL (que lleva el token).
 *  - `--confirm-bot` debe coincidir con getMe: impide registrar sobre un bot equivocado (p. ej. el
 *    de alertas de respaldos).
 *  - Si el bot ya tiene OTRO webhook, no se sobrescribe salvo `--replace-webhook-from` con la URL
 *    actual exacta (traslado coordinado con su dueño).
 *  - `--ready-for-webhook-registration` es la confirmación explícita de que el issue #8 alcanzó
 *    READY_FOR_WEBHOOK_REGISTRATION; este script no puede comprobar el KVM ni el reinicio del host.
 *  - Nunca llama getUpdates (long polling) ni deleteWebhook.
 */

import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const WEBHOOK_URL = 'https://tg.mainspot.io/telegram/webhook';
export const ALLOWED_UPDATES = ['message'] as const;
const FORBIDDEN_METHODS: Record<string, true> = { getUpdates: true, deleteWebhook: true };

export interface TelegramWebhookDeps {
  fetch: typeof fetch;
  envFile: string;
  out: (line: string) => void;
}

interface Secrets {
  token: string;
  secret: string;
  baseUrl: string;
}

export class UsageError extends Error {}

function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    vars[m[1]!] = value;
  }
  return vars;
}

async function loadSecrets(envFile: string): Promise<Secrets> {
  const st = await stat(envFile).catch(() => null);
  if (!st) throw new UsageError(`No existe el archivo protegido de Telegram (${envFile}).`);
  if ((st.mode & 0o077) !== 0) throw new UsageError(`${envFile} es legible por grupo/otros: debe ser 0600.`);
  const vars = parseEnvFile(await readFile(envFile, 'utf8'));
  const token = vars.TELEGRAM_BOT_TOKEN ?? '';
  const secret = vars.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new UsageError('TELEGRAM_BOT_TOKEN ausente o con formato inválido en el archivo protegido (BLOCKED_EXTERNAL: falta bot autorizado).');
  // Telegram admite 1-256 caracteres [A-Za-z0-9_-]; exigimos al menos 32 para que no sea adivinable.
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new UsageError('TELEGRAM_WEBHOOK_SECRET ausente o inválido (32-256 caracteres A-Z a-z 0-9 _ -).');
  return { token, secret, baseUrl: (vars.TELEGRAM_BASE_URL || 'https://api.telegram.org').replace(/\/$/, '') };
}

interface BotApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

async function callBotApi<T>(deps: TelegramWebhookDeps, s: Secrets, method: string, body?: Record<string, unknown>): Promise<T> {
  if (FORBIDDEN_METHODS[method]) throw new Error(`método prohibido: ${method}`);
  let res: Response;
  try {
    res = await deps.fetch(`${s.baseUrl}/bot${s.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // La causa de fetch puede incluir la URL con el token: solo se informa el tipo.
    throw new Error(`Bot API ${method}: fallo de red (${(err as Error).name})`);
  }
  const data = (await res.json().catch(() => ({ ok: false }))) as BotApiResult<T>;
  if (!data.ok || data.result === undefined) {
    const desc = (data.description ?? `HTTP ${res.status}`).split(s.token).join('<token>').split(s.secret).join('<secret>');
    throw new Error(`Bot API ${method}: ${data.error_code ?? res.status} ${desc}`);
  }
  return data.result;
}

interface GetMe { id: number; is_bot: boolean; username?: string; can_read_all_group_messages?: boolean }
interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}

function describeWebhook(info: WebhookInfo): string[] {
  const when = (t?: number) => (t ? new Date(t * 1000).toISOString() : '-');
  return [
    `webhook.url: ${info.url || '(sin webhook)'}`,
    `webhook.pending_update_count: ${info.pending_update_count}`,
    `webhook.max_connections: ${info.max_connections ?? '-'}`,
    `webhook.allowed_updates: ${info.allowed_updates ? JSON.stringify(info.allowed_updates) : '(todos los predeterminados)'}`,
    `webhook.last_error: ${info.last_error_message ? `${when(info.last_error_date)} ${info.last_error_message}` : '-'}`,
    `webhook.last_synchronization_error: ${when(info.last_synchronization_error_date)}`,
  ];
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new UsageError(`${name} requiere un valor`);
  return v;
}

export async function runTelegramWebhook(argv: string[], deps: TelegramWebhookDeps): Promise<void> {
  const [command, ...rest] = argv;
  if (command !== 'status' && command !== 'register') {
    throw new UsageError('uso: telegram-webhook.ts status | register --confirm-bot <username> --ready-for-webhook-registration [--replace-webhook-from <url>]');
  }
  const confirmBot = command === 'register' ? option(rest, '--confirm-bot') : undefined;
  const replaceFrom = command === 'register' ? option(rest, '--replace-webhook-from') : undefined;
  if (command === 'register') {
    if (!confirmBot) throw new UsageError('register exige --confirm-bot <username> (identidad del bot autorizado).');
    if (!flag(rest, '--ready-for-webhook-registration')) {
      throw new UsageError('register exige --ready-for-webhook-registration: confirma que issue #8 alcanzó READY_FOR_WEBHOOK_REGISTRATION (KVM → Express y reinicio del host verificados).');
    }
  }

  const s = await loadSecrets(deps.envFile);
  const me = await callBotApi<GetMe>(deps, s, 'getMe');
  deps.out(`bot: @${me.username ?? '?'} (id ${me.id})`);
  const before = await callBotApi<WebhookInfo>(deps, s, 'getWebhookInfo');
  for (const line of describeWebhook(before)) deps.out(line);
  if (command === 'status') return;

  if (`@${me.username ?? ''}`.toLowerCase() !== `@${confirmBot!.replace(/^@/, '')}`.toLowerCase()) {
    throw new UsageError(`El token pertenece a @${me.username ?? '?'}, no a ${confirmBot}: no se registra nada.`);
  }
  if (before.url && before.url !== WEBHOOK_URL && before.url !== replaceFrom) {
    throw new UsageError('El bot ya tiene otro webhook: no se sobrescribe. Coordina con su dueño y repite con --replace-webhook-from <url actual exacta>.');
  }

  await callBotApi<boolean>(deps, s, 'setWebhook', {
    url: WEBHOOK_URL,
    secret_token: s.secret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
    max_connections: 1,
  });
  const after = await callBotApi<WebhookInfo>(deps, s, 'getWebhookInfo');
  deps.out('setWebhook: ok');
  for (const line of describeWebhook(after)) deps.out(line);
  const allowed = JSON.stringify(after.allowed_updates ?? []);
  if (after.url !== WEBHOOK_URL || after.max_connections !== 1 || allowed !== JSON.stringify(ALLOWED_UPDATES)) {
    throw new Error('getWebhookInfo no confirma la configuración pedida (url/max_connections/allowed_updates).');
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const envFile = process.env.MAINSPOT_TELEGRAM_ENV_FILE
    ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'mainspot', 'telegram-webhook.env');
  runTelegramWebhook(process.argv.slice(2), { fetch, envFile, out: (l) => console.log(l) }).catch((err: Error) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
