/**
 * Ejecuta un script psql (preflights y reparaciones de scripts/, que usan \if y \gset) como lo haría el DBA:
 * `psql -X` sin ~/.psqlrc y SIN `-v ON_ERROR_STOP=1` del llamador (cada script lo impone por sí mismo), salida
 * sin alinear con `|` y sin pies de tabla. Devuelve el código de salida y stdout+stderr.
 */

import { spawnSync } from 'node:child_process';

export function psqlAvailable(): boolean {
  return spawnSync('psql', ['--version'], { encoding: 'utf8' }).status === 0;
}

export function runPsql(url: string, file: string, vars: Record<string, string> = {}): { status: number | null; out: string } {
  const args = ['-X', '-q', '-A', '-F', '|', '-P', 'footer=off'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  args.push('-f', file, url);
  const r = spawnSync('psql', args, { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * Filas de cada resultado de la salida, agrupadas por su línea de cabecera. `headers` debe listar TODAS las
 * cabeceras que imprime el script; se ignoran los mensajes (`\echo` de veredicto y errores de psql).
 */
export function resultSets(out: string, headers: readonly string[]): Map<string, string[][]> {
  const sets = new Map<string, string[][]>();
  let current: string[][] | null = null;
  for (const line of out.split('\n')) {
    if (headers.includes(line)) {
      current = [];
      sets.set(line, current);
    } else if (current && line.trim() !== '' && !/^(psql:|ERROR:|WARNING:|NOTICE:|G-MIG|BLOCKED|OK:)/.test(line)) {
      current.push(line.split('|'));
    }
  }
  return sets;
}
