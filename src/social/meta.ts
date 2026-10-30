/**
 * Fábrica del proveedor social (DEC-017/026, DEV-E2E-04 §2B).
 *
 * - SOCIAL_PROVIDER=meta ⇒ MetaPagesAdapter REAL: cada negocio publica con SU Page y SU page
 *   token cifrado. Sin CONNECTOR_TOKEN_KEY el arranque falla; nunca simula una operación real.
 * - SOCIAL_PROVIDER=simulated ⇒ SimulatedMeta, únicamente regresión offline explícita.
 */

import type { ProviderConnectionRepository } from '../connectors/repository.ts';
import type { AppConfig } from '../shared/config.ts';
import { MetaGraphClient, MetaPagesAdapter } from './meta-graph.ts';
import type { SocialProvider } from './provider.ts';
import { SimulatedMeta } from './simulated.ts';

export type SocialProviderConfig = Pick<AppConfig, 'socialProvider' | 'metaGraphBaseUrl' | 'metaGraphVersion' | 'metaAppId' | 'metaAppSecret'>;

export function createMetaGraphClient(config: Pick<AppConfig, 'metaGraphBaseUrl' | 'metaGraphVersion' | 'metaAppSecret'>, fetchImpl?: typeof fetch): MetaGraphClient {
  return new MetaGraphClient({ baseUrl: config.metaGraphBaseUrl, version: config.metaGraphVersion, appSecret: config.metaAppSecret, fetchImpl });
}

export function createSocialProvider(config: SocialProviderConfig, connections: ProviderConnectionRepository, fetchImpl?: typeof fetch): SocialProvider {
  if (config.socialProvider === 'meta') {
    return new MetaPagesAdapter({ client: createMetaGraphClient(config, fetchImpl), connections, appId: config.metaAppId, appSecret: config.metaAppSecret });
  }
  // La simulación se selecciona explícitamente.
  return new SimulatedMeta();
}
