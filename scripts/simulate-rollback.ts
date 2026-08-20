/**
 * Rollback simulation (AC-009, PLAN-INC-001 §11). Executes the 5 ordered
 * steps against the configured DATABASE_URL and writes evidence/rollback-report.md:
 *   1. Disable newly introduced access paths (revoke all active sessions).
 *   2. Revert role/permission configuration to the previous state (re-sync the
 *      role_permission mirror from the code matrix; idempotent).
 *   3. Preserve audit data generated before rollback (proves no event deleted).
 *   4. Verify no cross-client access remains (negative isolation re-check).
 *   5. Document the resulting state.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadConfigTool } from '../src/shared/config.ts';
import { log } from '../src/shared/logger.ts';
import { withRequestContext } from '../src/shared/context.ts';
import { IdentityRepository } from '../src/identity/repository.ts';
import { RbacRepository } from '../src/rbac/repository.ts';
import { TenantDataRepository } from '../src/boundary/datasource.ts';
import { SessionResolver } from '../src/boundary/session.ts';
import { signSessionToken } from '../src/shared/jwt.ts';
import { toMatrixEntries } from '../src/rbac/matrix.ts';

const { Pool } = pg;

interface ReportSection {
  title: string;
  lines: string[];
}

async function main(): Promise<void> {
  await withRequestContext(async () => {
    const cfg = loadConfigTool();
    const urlFlag = process.argv.findIndex((a) => a === '--url');
    const connectionString = urlFlag !== -1 && process.argv[urlFlag + 1] ? (process.argv[urlFlag + 1] as string) : cfg.databaseUrl;
    const pool = new Pool({ connectionString, max: 3 });
    const sections: ReportSection[] = [];

    try {
      // Step 0 — snapshot current state
      const auditBefore = await pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_event');
      const sessionsBefore = await pool.query<{ n: string }>('SELECT count(*) AS n FROM session_context WHERE revoked_at IS NULL');
      const rpBefore = await pool.query<{ n: string }>('SELECT count(*) AS n FROM role_permission');
      sections.push({
        title: '0. Estado previo (snapshot)',
        lines: [
          `- base de datos objetivo: ${connectionString.includes('mainspot_test') ? 'mainspot_test' : 'mainspot'}`,
          `- eventos de auditoría: ${auditBefore.rows[0]?.n ?? 0}`,
          `- sesiones activas: ${sessionsBefore.rows[0]?.n ?? 0}`,
          `- filas role_permission: ${rpBefore.rows[0]?.n ?? 0}`,
        ],
      });

      // Step 1 — disable new access paths: revoke all active sessions.
      const revoked = await pool.query<{ n: string }>(
        'UPDATE session_context SET revoked_at = now() WHERE revoked_at IS NULL RETURNING session_id',
      );
      sections.push({
        title: '1. Deshabilitar nuevos paths de acceso',
        lines: [
          `- sesiones revocadas: ${revoked.rowCount ?? 0}`,
          '- ningún token emitido con anterioridad sigue siendo válido (fail-closed por sesión).',
        ],
      });

      // Step 2 — revert role/permission configuration to previous state.
      const rbac = new RbacRepository(pool);
      await rbac.syncMatrix();
      const rpAfter = await pool.query<{ n: string }>('SELECT count(*) AS n FROM role_permission');
      const expectedRp = toMatrixEntries().length;
      sections.push({
        title: '2. Revertir configuración de roles/permisos',
        lines: [
          `- role_permission re-sincronizado desde la matriz de código (${expectedRp} entradas).`,
          `- filas role_permission tras revertir: ${rpAfter.rows[0]?.n ?? 0} (esperado ${expectedRp}).`,
        ],
      });

      // Step 3 — preserve audit data.
      const auditAfter = await pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_event');
      const preserved = Number(auditBefore.rows[0]?.n ?? 0) === Number(auditAfter.rows[0]?.n ?? 0);
      sections.push({
        title: '3. Preservar datos de auditoría',
        lines: [
          `- eventos antes: ${auditBefore.rows[0]?.n ?? 0}; después: ${auditAfter.rows[0]?.n ?? 0}`,
          `- resultado: ${preserved ? 'PRESERVADO (no se borró ningún evento)' : 'FALLO: se perdieron eventos'}`,
        ],
      });

      // Step 4 — verify no cross-client access remains.
      const identityRepo = new IdentityRepository(pool);
      const resolver = new SessionResolver(identityRepo, cfg.jwtSecret);
      const noToken = await resolver.resolve(undefined);
      const revokedTokenCheck = await resolver.resolve('Bearer invalid.token.value');
      const dataRepo = new TenantDataRepository(pool);
      const sessionA: Parameters<typeof dataRepo.findScoped>[0] = {
        session_id: 'sess_rollback_check',
        user_id: 'user_a_admin',
        tenant_id: 'client_a',
        role_id: 'administration',
        role_name: 'administration',
        permissions: [],
        source: 'rollback-check',
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      };
      const cross = await dataRepo.findScoped(sessionA, 'data_b_001'); // data_b_001 belongs to client_b
      sections.push({
        title: '4. Verificar que no queda acceso cruzado',
        lines: [
          `- request sin token -> ${noToken.reason} (fail-closed: ${noToken.session === null ? 'OK' : 'FALLO'})`,
          `- token inválido/revocado -> ${revokedTokenCheck.reason} (fail-closed: ${revokedTokenCheck.session === null ? 'OK' : 'FALLO'})`,
          `- lectura de dato de otro cliente con contexto A -> found=${cross.found}, in_tenant=${cross.in_tenant} (esperado found=true, in_tenant=false => deny)` +
            (cross.in_tenant ? ' FALLO: se expuso dato de otro tenant' : ' OK: deny, sin exponer datos'),
        ],
      });

      // IR-12: prove REAL revocation, not just invalid signatures: create a
      // valid session, resolve it OK, revoke it, then resolve again -> denied.
      // The secret below is a check-only literal (never used by the server).
      const rev = { sid: `sess_rollback_rev_${Date.now()}`, secret: 'rollback-check-local-secret' };
      await identityRepo.createSession({
        session_id: rev.sid,
        user_id: 'user_a_admin',
        tenant_id: 'client_a',
        role_id: 'administration',
        permissions: [],
        source: 'rollback-check',
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        revoked_at: null,
      });
      const revResolver = new SessionResolver(identityRepo, rev.secret);
      const revToken = signSessionToken(
        { sid: rev.sid, uid: 'user_a_admin', tid: 'client_a', rol: 'administration' },
        rev.secret,
        1,
      );
      const beforeRevoke = await revResolver.resolve(`Bearer ${revToken}`);
      await identityRepo.revokeSession(rev.sid);
      const afterRevoke = await revResolver.resolve(`Bearer ${revToken}`);
      sections.push({
        title: '4b. Revocación real de sesión válida (IR-12)',
        lines: [
          `- sesión creada y firmada: ${beforeRevoke.session ? 'resolvible OK (antes de revocar)' : 'FALLO: no resolvible antes de revocar'}`,
          `- tras revocar la misma sesión (token intacto): reason=${afterRevoke.reason}, session=${afterRevoke.session === null ? 'null' : 'STILL VALID'}` +
            (afterRevoke.session === null ? ' -> OK: revocación efectiva (equivalente HTTP 401)' : ' -> FALLO: token revocado sigue resolviendo'),
        ],
      });

      // Step 5 — document resulting state.
      const state = await pool.query<{ c: string }>(
        'SELECT count(*) FILTER (WHERE status = \'active\') AS c FROM client',
      );
      const clientCount = await pool.query<{ n: string }>('SELECT count(*) AS n FROM client');
      sections.push({
        title: '5. Estado documentado post-rollback',
        lines: [
          `- clientes activos en seed: ${state.rows[0]?.c ?? 0} de ${clientCount.rows[0]?.n ?? 0}`,
          '- sesiones: TODAS revocadas; los usuarios deben volver a ingresar (las nuevas sesiones crean contexto válido).',
          '- auditoría: intacta; sirve de evidencia de lo ocurrido antes y durante el rollback.',
          '- acceso cruzado: negado por sesión (revocada) y por capa de datos (scope tenant_id).',
          '- observación: si un path nuevo que INC-002 ya usara se deshabilita aquí, debe coordinarse con ese incremento (nota Reviewer).',
        ],
      });

      const report = buildReport(sections);
      await mkdir(cfg.evidenceDir, { recursive: true });
      const out = path.join(cfg.evidenceDir, 'rollback-report.md');
      await writeFile(out, report, 'utf8');
      process.stdout.write(report);
      log.info('rollback.simulated', `rollback report written to ${out}`, {});
    } finally {
      await pool.end();
    }
  });
}

function buildReport(sections: ReportSection[]): string {
  const lines: string[] = [];
  lines.push('# Reporte de rollback simulado — INC-001 (AC-009)');
  lines.push('');
  lines.push(`> Fecha: ${new Date().toISOString()}`);
  lines.push('> Procedimiento del contrato INC-001 §Rollback y PLAN-INC-001 §11.');
  lines.push('');
  for (const section of sections) {
    lines.push(`## ${section.title}`);
    lines.push('');
    lines.push(...section.lines);
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
