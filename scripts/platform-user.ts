/**
 * Alta de personas de la plataforma (FR-0018). La contraseña entra por stdin (nunca por argv ni
 * entorno); el secreto TOTP se muestra UNA vez y se guarda solo cifrado (PLATFORM_MFA_KEY).
 *
 *   printf '%s' "$PASS" | node scripts/platform-user.ts create --login ana --name "Ana" --roles platform_admin,ai_engineer
 *   node scripts/platform-user.ts create ... --secret-file ~/.config/mainspot/platform-ana.txt   # 0600, sin imprimir
 */

import { writeFileSync } from 'node:fs';
import { createApp } from '../src/api/server.ts';
import { PLATFORM_ROLES, type PlatformRole } from '../src/platform/auth.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  if (process.argv[2] !== 'create') {
    console.error('uso: printf %s "$PASS" | node scripts/platform-user.ts create --login <login> --name <nombre> --roles <rol,rol> [--secret-file <ruta>]');
    process.exit(2);
  }
  const login = arg('login') ?? '';
  const name = arg('name') ?? login;
  const roles = (arg('roles') ?? '').split(',').map((r) => r.trim()).filter(Boolean) as PlatformRole[];
  if (roles.some((r) => !PLATFORM_ROLES.includes(r))) {
    console.error(`roles válidos: ${PLATFORM_ROLES.join(', ')}`);
    process.exit(2);
  }
  const password = await readStdin();
  const { platformAuth, pool, engagementWorker, socialScheduler } = createApp();
  try {
    const out = await platformAuth.createUser({ login, displayName: name, password, roles, grantedBy: `cli:${process.env.USER ?? 'operator'}` });
    const file = arg('secret-file');
    if (file) {
      writeFileSync(file, `login=${login}\nroles=${roles.join(',')}\ntotp_secret=${out.totp_secret}\notpauth_uri=${out.otpauth_uri}\n`, { mode: 0o600, flag: 'wx' });
      console.log(JSON.stringify({ platform_user_id: out.platform_user_id, login, roles, secret_file: file }));
    } else {
      console.log(JSON.stringify({ platform_user_id: out.platform_user_id, login, roles, totp_secret: out.totp_secret, otpauth_uri: out.otpauth_uri, note: 'Guárdalo en tu app de autenticación; no se vuelve a mostrar.' }));
    }
  } finally {
    engagementWorker.stop();
    socialScheduler.stop();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
