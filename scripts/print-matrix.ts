/**
 * Permission matrix evidence (AC-001). Prints role x action matrix as
 * Markdown; saves to EVIDENCE_DIR/permission-matrix.md by default.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfigTool } from '../src/shared/config.ts';
import { log } from '../src/shared/logger.ts';
import { withRequestContext } from '../src/shared/context.ts';
import { ACTIONS, ROLE_LABELS, ACTION_LABELS, MATRIX, toMatrixEntries } from '../src/rbac/matrix.ts';
import type { RoleName } from '../src/identity/entities.ts';

export function renderMatrixMarkdown(): string {
  const roles: RoleName[] = ['administration', 'operation', 'read_only'];
  const lines: string[] = [];
  lines.push('# Matriz de permisos del backoffice (INC-001)');
  lines.push('');
  lines.push(`> Generado el ${new Date().toISOString()} desde \`src/rbac/matrix.ts\` (fuente de verdad).`);
  lines.push(`> Regla fail-closed: toda acción no listada es **deny**; el contexto de cliente siempre aplica sobre el rol.`);
  lines.push('');
  lines.push(`| Acción (recurso \\* = contexto general) | Administración | Operación | Solo lectura |`);
  lines.push('|---|---|---|---|');
  for (const action of ACTIONS) {
    const cells = roles.map((r) => (MATRIX[r].includes(action) ? 'allow' : 'deny'));
    lines.push(`| \`${action}\` — ${ACTION_LABELS[action]} | ${cells[0]} | ${cells[1]} | ${cells[2]} |`);
  }
  lines.push('');
  lines.push('## Vista por rol (lenguaje claro, AC-008)');
  lines.push('');
  for (const role of roles) {
    lines.push(`- **${ROLE_LABELS[role]}**: ${MATRIX[role].length === ACTIONS.length ? 'todas las acciones del panel' : MATRIX[role].map((a) => `\`${a}\``).join(', ')}`);
  }
  lines.push('');
  lines.push(`Total entradas: ${toMatrixEntries().length}`);
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  await withRequestContext(async () => {
    const cfg = loadConfigTool();
    const md = renderMatrixMarkdown();
    process.stdout.write(md + '\n');
    const out = path.join(cfg.evidenceDir, 'permission-matrix.md');
    await writeFile(out, md + '\n', 'utf8');
    log.info('matrix.saved', `permission matrix saved to ${out}`, {});
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
