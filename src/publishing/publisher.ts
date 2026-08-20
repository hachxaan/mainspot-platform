/**
 * Publisher contract genérico (INC-002, reutilizable en INC-003/INC-005).
 *
 * Un Publisher ejecuta el EFECTO de un proposal aprobado. Contrato estable:
 *   publish(ctx) => PublishResult
 * Debe ser idempotente (mismo proposal + payload ⇒ mismo resultado) y
 * devolver un identificador único de publicación (external_ref) para AC-007.
 *
 * `db` opcional permite que el efecto participe en la MISMA transacción que
 * el registro de publicación + auditoría (fail-closed, INC-001) y es la base
 * para reutilizar el contrato en INC-003 (website) / INC-005 (social).
 */

import type { Pool, PoolClient } from 'pg';

export type DbExecutor = Pool | PoolClient;

export interface PublisherContext {
  tenantId: string;
  proposalId: string;
  proposalType: string;
  payload: Record<string, unknown>; // detail del proposal (tenant-scoped)
}

export interface PublishResult {
  ok: boolean;
  /** Versión del contenido publicado (p.ej. website_content.version). */
  version?: number;
  /** Identificador único de la publicación (evidencia AC-007). */
  external_ref: string;
  error?: string;
}

export interface Publisher {
  readonly name: string; // 'website' | 'stub' | (future: 'social', ...)
  publish(ctx: PublisherContext, db?: DbExecutor): Promise<PublishResult>;
}

export class PublisherRegistry {
  private readonly publishers = new Map<string, Publisher>();

  register(p: Publisher): void {
    this.publishers.set(p.name, p);
  }

  get(name: string): Publisher | null {
    return this.publishers.get(name) ?? null;
  }
}
