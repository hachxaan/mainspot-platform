export interface StdoutCapture { lines: string[]; restore: () => void }

/** Captura las líneas escritas en stdout (registros JSON del logger) durante una prueba. */
export function captureStdout(): StdoutCapture {
  const lines: string[] = [];
  const stdout = process.stdout;
  const original = stdout.write;
  const tap: typeof stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (original as (...args: unknown[]) => boolean).call(stdout, chunk, ...rest);
  };
  stdout.write = tap;
  return { lines, restore: () => { stdout.write = original; } };
}
