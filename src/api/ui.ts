/**
 * Páginas HTML del servidor que NO son la interfaz del panel: error controlado y vista previa
 * pública por enlace (INC-002, CAP-008). La interfaz de entrar, invitación y panel es la de Claude
 * Design integrada en src/web/panel (DEV-E2E-03).
 */

const SHARED_CSS = `
  :root { color-scheme: light; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  body { margin: 0; background: #f5f7fa; color: #1f2933; }
  main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.5rem; }
  .card { background: #fff; border: 1px solid #d7dde3; border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem; }
  label { display: block; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 0.6rem; border: 1px solid #9aa7b3; border-radius: 8px; font-size: 1rem; }
  button { padding: 0.65rem 1rem; border: 0; border-radius: 8px; background: #0b5ba6; color: #fff; font-size: 1rem; cursor: pointer; }
  button.secondary { background: #e7ecf1; color: #1f2933; }
  a { color: #0b5ba6; }
  [role="alert"] { background: #fdecea; border: 1px solid #f5b7b1; color: #7a1f1a; padding: 0.75rem; border-radius: 8px; margin-top: 0.75rem; }
  [role="status"] { background: #e3f2e4; border: 1px solid #a8d5b0; color: #14532d; padding: 0.75rem; border-radius: 8px; margin-bottom: 0.75rem; }
  .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-weight: 600; font-size: 0.85rem; background: #e7ecf1; border: 1px solid #c3cdd6; }
  .badge.admin { background: #e3e7fd; border-color: #9aa7f0; }
  .badge.ops { background: #e0f2e8; border-color: #9ad0b5; }
  .badge.readonly { background: #f1ede2; border-color: #d3c9a3; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #e2e8ee; }
  th { background: #eef2f6; }
  code { background: #eef2f6; padding: 0.1rem 0.3rem; border-radius: 4px; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .error-text { color: #7a1f1a; }
  footer { margin-top: 2rem; font-size: 0.85rem; color: #5b6470; text-align: center; }
`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function errorPageHtml(message: string, status: number): string {
  const title = status >= 500 ? 'Ocurrió un problema en el servidor' : 'No se pudo completar la operación';
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>MainSpot — ${esc(title)}</title><style>${SHARED_CSS}</style></head>
<body><main><div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/">Volver al inicio</a></p></div></main></body>
</html>`;
}

// --- INC-002/INC-003: páginas públicas de preview/sandbox (CAP-008, AC-007) ---

function detailToHuman(detail: unknown): string[] {
  if (!detail || typeof detail !== 'object') return [];
  const sentences = (detail as { diff_sentences?: unknown }).diff_sentences;
  if (Array.isArray(sentences)) return sentences.filter((s): s is string => typeof s === 'string');
  return [];
}

export interface PreviewPageInput {
  token: string;
  summary: string;
  detail: unknown;
  previewHtml: string | null;
  expiresAt?: string | null;
}

export function previewPageHtml(input: PreviewPageInput): string {
  const sentences = detailToHuman(input.detail);
  const diffList = (sentences.length ? sentences : [input.summary]).map((s) => `<li>${esc(s)}</li>`).join('\n');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MainSpot — Vista previa</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Vista previa de tus cambios</h1>
    <p>Revisa los cambios que se aplicarían a tu página web. Nada se publica hasta que tú lo apruebes.</p>
    ${input.expiresAt ? `<p class="error-text">Este enlace expira en su momento programado.</p>` : ''}
    <h2>Resumen de cambios</h2>
    <ul>${diffList}</ul>
    <form method="post" action="/preview/${esc(input.token)}/apply">
      <p><button type="submit">Aplicar cambios</button></p>
      <p class="error-text">Al presionar el botón autorizas la publicación de estos cambios.</p>
    </form>
  </div>
  ${input.previewHtml ? `<div class="card"><h2>Así se vería tu página</h2><div style="border:1px solid #c3cdd6;border-radius:8px;overflow:auto">${input.previewHtml}</div></div>` : ''}
  <footer>MainSpot — Vista previa (aún no publicada)</footer>
</main>
</body>
</html>`;
}

export function previewExpiredPageHtml(alreadyPublished = false): string {
  const title = alreadyPublished ? 'Estos cambios ya fueron publicados' : 'El enlace expiró';
  const body = alreadyPublished
    ? 'Los cambios de este enlace ya se aplicaron y publicaron antes. No se duplicó nada.'
    : 'El enlace de vista previa expiró y ya no permite aplicar cambios. Pide una nueva vista previa en tu panel de MainSpot.';
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>MainSpot — ${esc(title)}</title><style>${SHARED_CSS}</style></head>
<body><main><div class="card"><h1>${esc(title)}</h1><p>${esc(body)}</p><p><a href="/">Volver al inicio</a></p></div></main></body>
</html>`;
}

export function previewNotFoundPageHtml(): string {
  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>MainSpot — Enlace no válido</title><style>${SHARED_CSS}</style></head>
<body><main><div class="card"><h1>Enlace no válido</h1><p>Este enlace de vista previa no existe o ya no es válido.</p><p><a href="/">Volver al inicio</a></p></div></main></body>
</html>`;
}
