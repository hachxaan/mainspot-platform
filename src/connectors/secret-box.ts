/**
 * DEV-E2E-04 — cifrado de credenciales de proveedores por negocio (tokens OAuth, page tokens,
 * verificadores PKCE). AES-256-GCM con IV aleatorio de 12 bytes; el par tenant/proveedor (y el
 * uso) va como datos autenticados (AAD): un cifrado copiado a otra fila o a otro propósito no
 * descifra. La clave sale de CONNECTOR_TOKEN_KEY (32 bytes en base64, fuera de Git); sin clave
 * válida no se guarda ni se lee ningún token (fail closed), nunca se cae a texto plano.
 *
 * Formato: [1 byte versión=1][12 bytes IV][16 bytes tag][N bytes cifrado].
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class ConnectorKeyError extends Error {
  readonly code = 'connector_key_missing';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorKeyError';
  }
}

export interface SealContext {
  tenantId: string;
  provider: string;
  /** Qué se guarda (p. ej. 'tokens', 'pkce_verifier'); un sobre no sirve para otro uso. */
  purpose: string;
}

function aad(ctx: SealContext): Buffer {
  return Buffer.from(`mainspot/connector/v1\u0000${ctx.tenantId}\u0000${ctx.provider}\u0000${ctx.purpose}`, 'utf8');
}

export class SecretBox {
  private readonly key: Buffer;
  /** Identificador NO secreto de la clave (para rotación): primeros 8 bytes de SHA-256. */
  readonly keyId: string;

  private constructor(key: Buffer) {
    this.key = key;
    this.keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  /** Clave en base64 (32 bytes). Mensajes de error sin el valor. */
  static fromBase64(value: string | undefined): SecretBox {
    if (!value) throw new ConnectorKeyError('CONNECTOR_TOKEN_KEY is not configured: provider tokens cannot be stored or read.');
    const key = Buffer.from(value, 'base64');
    if (key.length !== 32) throw new ConnectorKeyError('CONNECTOR_TOKEN_KEY must be 32 bytes encoded in base64.');
    return new SecretBox(key);
  }

  seal(plaintext: string, ctx: SealContext): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(aad(ctx));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  open(box: Buffer, ctx: SealContext): string {
    if (box.length < 1 + IV_BYTES + TAG_BYTES || box[0] !== VERSION) throw new Error('connector token box: unsupported format');
    const iv = box.subarray(1, 1 + IV_BYTES);
    const tag = box.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(aad(ctx));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(box.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  sealJson(value: unknown, ctx: SealContext): Buffer {
    return this.seal(JSON.stringify(value), ctx);
  }

  openJson<T>(box: Buffer, ctx: SealContext): T {
    return JSON.parse(this.open(box, ctx)) as T;
  }
}

/** Para guardar `state` OAuth y similares: solo el hash, nunca el valor. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
