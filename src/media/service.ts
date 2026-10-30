/**
 * Biblioteca multimedia (FR-0013 §2.3, SEC-0001).
 *
 * - Entrada: bytes del proveedor de imágenes configurado o subida del dueño (con declaración de
 *   derechos). El servidor NUNCA descarga URLs propuestas por un modelo (sin SSRF).
 * - Normaliza a WebP sin metadatos (EXIF/GPS fuera), limita píxeles de entrada y genera variantes:
 *   anchos responsivos (w640/w1280/w1920) y formatos de redes (sq1080 1:1, p1080x1350 4:5).
 * - Id aleatorio de 128 bits: la URL /media/<id>/<variante>.webp es una capability URL; en el host
 *   de un sitio solo se sirven assets de ese negocio (local-site).
 */

import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_ASSETS_PER_TENANT = 300;
const ACCEPTED_FORMATS = new Set(['png', 'jpeg', 'webp']);

export interface MediaAssetRow {
  asset_id: string; tenant_id: string; kind: 'image'; source: 'ai_generated' | 'uploaded'; status: 'draft' | 'approved' | 'archived';
  purpose: string; mime: string; width: number; height: number; sha256: string; alt_text: string; license: string;
  is_illustration: boolean; generator_model: string | null; invocation_id: string | null; prompt_summary: string | null;
  created_by: string; created_at: string; updated_at: string; variants?: string[];
}

export interface StoreInput {
  tenantId: string;
  bytes: Buffer;
  source: 'ai_generated' | 'uploaded';
  purpose: string;
  alt: string;
  license: string;
  isIllustration: boolean;
  generatorModel?: string | null;
  invocationId?: string | null;
  promptSummary?: string | null;
  createdBy: string;
  requestId: string;
  actorRole?: string | null;
}

export function newAssetId(): string {
  return `ast_${randomBytes(16).toString('base64url')}`;
}

const SELECT_META = `asset_id, tenant_id, kind, source, status, purpose, mime, width, height, sha256, alt_text, license, is_illustration,
  generator_model, invocation_id, prompt_summary, created_by, created_at, updated_at,
  (SELECT array_agg(variant ORDER BY variant) FROM media_variant v WHERE v.asset_id = a.asset_id) AS variants`;

export class MediaService {
  private readonly pool: Pool;
  private readonly sink: AuditSink;

  constructor(deps: { pool: Pool; sink: AuditSink }) {
    this.pool = deps.pool;
    this.sink = deps.sink;
  }

  async store(input: StoreInput): Promise<MediaAssetRow> {
    if (input.bytes.length > MAX_INPUT_BYTES) throw new AppError(413, 'validation_error', 'La imagen supera 8 MB.');
    const alt = input.alt.trim();
    if (!alt || alt.length > 160) throw new AppError(400, 'validation_error', 'Describe la imagen en 1 a 160 caracteres (texto alternativo).');
    let meta: sharp.Metadata;
    try {
      meta = await sharp(input.bytes, { limitInputPixels: 40_000_000 }).metadata();
    } catch {
      throw new AppError(400, 'validation_error', 'El archivo no es una imagen válida.');
    }
    if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) throw new AppError(400, 'validation_error', 'Usa una imagen PNG, JPG o WebP.');
    const count = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM media_asset WHERE tenant_id = $1 AND status <> 'archived'`, [input.tenantId]);
    if (Number(count.rows[0]?.n ?? 0) >= MAX_ASSETS_PER_TENANT) throw new AppError(403, DENY_CODES.LIMIT_EXCEEDED, 'Tu biblioteca llegó al máximo de imágenes. Archiva algunas para continuar.');

    // Rotación EXIF aplicada y metadatos descartados (sharp no copia metadatos salvo withMetadata()).
    const base = sharp(input.bytes, { limitInputPixels: 40_000_000 }).rotate();
    const original = await base.clone().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer({ resolveWithObject: true });
    const variants: Array<{ name: string; buf: Buffer; width: number; height: number }> = [];
    for (const w of [640, 1280, 1920]) {
      if (w > original.info.width && w !== 640) continue;
      const r = await sharp(original.data).resize({ width: Math.min(w, original.info.width) }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
      variants.push({ name: `w${w}`, buf: r.data, width: r.info.width, height: r.info.height });
    }
    for (const [name, w, h] of [['sq1080', 1080, 1080], ['p1080x1350', 1080, 1350]] as const) {
      const r = await sharp(original.data).resize({ width: w, height: h, fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
      variants.push({ name, buf: r.data, width: r.info.width, height: r.info.height });
    }
    const assetId = newAssetId();
    const sha = createHash('sha256').update(original.data).digest('hex');
    return runAtomic(this.pool, async (client) => {
      await client.query(
        `INSERT INTO media_asset (asset_id, tenant_id, source, purpose, mime, width, height, bytes, sha256, alt_text, license, is_illustration,
           generator_model, invocation_id, prompt_summary, created_by)
         VALUES ($1,$2,$3,$4,'image/webp',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [assetId, input.tenantId, input.source, input.purpose.slice(0, 60), original.info.width, original.info.height, original.data, sha, alt,
          input.license.slice(0, 200), input.isIllustration, input.generatorModel ?? null, input.invocationId ?? null, input.promptSummary?.slice(0, 300) ?? null, input.createdBy]);
      for (const v of variants) {
        await client.query('INSERT INTO media_variant (asset_id, tenant_id, variant, mime, width, height, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [assetId, input.tenantId, v.name, 'image/webp', v.width, v.height, v.buf]);
      }
      await this.sink.write({
        tenant_id: input.tenantId, actor_id: input.createdBy, actor_role: input.actorRole ?? null, action: 'media.asset.stored',
        resource: `media_asset/${assetId}`, request_id: input.requestId, decision: 'allow', result: `${input.source}:${input.purpose}`.slice(0, 120),
      }, client);
      const row = (await client.query<MediaAssetRow>(`SELECT ${SELECT_META} FROM media_asset a WHERE asset_id = $1`, [assetId])).rows[0];
      return row as MediaAssetRow;
    });
  }

  /** Anti-oráculo: inexistente y de otro negocio son iguales (null). */
  async get(tenantId: string, assetId: string): Promise<MediaAssetRow | null> {
    const r = await this.pool.query<MediaAssetRow>(`SELECT ${SELECT_META} FROM media_asset a WHERE asset_id = $1`, [assetId]);
    const row = r.rows[0];
    return row && row.tenant_id === tenantId ? row : null;
  }

  async list(tenantId: string, opts: { status?: string; limit?: number } = {}): Promise<MediaAssetRow[]> {
    const r = await this.pool.query<MediaAssetRow>(
      `SELECT ${SELECT_META} FROM media_asset a WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT $3`,
      [tenantId, opts.status ?? null, Math.min(opts.limit ?? 100, 300)]);
    return r.rows;
  }

  async setStatus(actor: { tenantId: string; userId: string; role: string | null; requestId: string }, assetId: string, status: 'approved' | 'archived', alt?: string): Promise<MediaAssetRow> {
    const found = await this.get(actor.tenantId, assetId);
    if (!found) throw new AppError(404, DENY_CODES.NOT_FOUND, 'No encontramos esa imagen.');
    const nextAlt = alt === undefined ? found.alt_text : alt.trim();
    if (!nextAlt || nextAlt.length > 160) throw new AppError(400, 'validation_error', 'Describe la imagen en 1 a 160 caracteres.');
    if (status === 'archived') {
      const used = await this.pool.query('SELECT 1 FROM client_website WHERE tenant_id = $1 AND position($2 in data::text) > 0', [actor.tenantId, assetId]);
      if (used.rowCount) throw new AppError(409, 'validation_error', 'Tu página publicada usa esta imagen; cámbiala en la página antes de archivarla.');
    }
    return runAtomic(this.pool, async (client) => {
      await client.query('UPDATE media_asset SET status = $3, alt_text = $4, updated_at = now() WHERE asset_id = $1 AND tenant_id = $2', [assetId, actor.tenantId, status, nextAlt]);
      await this.sink.write({ tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role, action: `media.asset.${status}`, resource: `media_asset/${assetId}`, request_id: actor.requestId, decision: 'allow', result: status }, client);
      return (await client.query<MediaAssetRow>(`SELECT ${SELECT_META} FROM media_asset a WHERE asset_id = $1`, [assetId])).rows[0] as MediaAssetRow;
    });
  }

  /** Bytes de una variante. `tenantScope` restringe al negocio (host de su sitio). */
  async variant(assetId: string, variant: string, tenantScope?: string): Promise<{ mime: string; bytes: Buffer; tenantId: string } | null> {
    if (!/^ast_[A-Za-z0-9_-]{16,64}$/.test(assetId) || !/^(original|w\d{3,4}|sq1080|p1080x1350)$/.test(variant)) return null;
    const r = variant === 'original'
      ? await this.pool.query<{ mime: string; bytes: Buffer; tenant_id: string; status: string }>('SELECT mime, bytes, tenant_id, status FROM media_asset WHERE asset_id = $1', [assetId])
      : await this.pool.query<{ mime: string; bytes: Buffer; tenant_id: string; status: string }>(
        'SELECT v.mime, v.bytes, v.tenant_id, a.status FROM media_variant v JOIN media_asset a ON a.asset_id = v.asset_id WHERE v.asset_id = $1 AND v.variant = $2', [assetId, variant]);
    const row = r.rows[0];
    if (!row || row.status === 'archived') return null;
    if (tenantScope && row.tenant_id !== tenantScope) return null;
    return { mime: row.mime, bytes: row.bytes, tenantId: row.tenant_id };
  }
}
