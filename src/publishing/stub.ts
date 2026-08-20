/**
 * StubPublisher — publicador sin efecto externo para pruebas del state machine
 * (AC-007) y targets aún no implementados. Determinista e idempotente.
 */

import type { DbExecutor, PublishResult, Publisher, PublisherContext } from './publisher.ts';

export class StubPublisher implements Publisher {
  readonly name = 'stub' as const;
  /** Opcional: forzar fallo para probar la rama `failed` del FLOW-002. */
  private readonly shouldFail: (ctx: PublisherContext) => boolean;

  constructor(shouldFail: (ctx: PublisherContext) => boolean = () => false) {
    this.shouldFail = shouldFail;
  }

  async publish(ctx: PublisherContext, _db?: DbExecutor): Promise<PublishResult> {
    if (this.shouldFail(ctx)) {
      return { ok: false, external_ref: `stub_failed:${ctx.proposalId}`, error: 'stub_failure_injected' };
    }
    return { ok: true, version: 1, external_ref: `stub:${ctx.proposalId}` };
  }
}
