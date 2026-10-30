/**
 * DEV-E2E-04 §2A — composición del conector REAL de Google Business Profile para createApp().
 *
 * La selección explícita REPUTATION_PROVIDER=google_business_profile usa el conector real incluso
 * sin credenciales: en ese caso las operaciones fallan cerradas, nunca simulan éxito. Las rutas
 * de conexión reportan los nombres de los prerrequisitos externos ausentes.
 */

import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import type { ProviderConnectionRepository } from '../connectors/repository.ts';
import type { AppConfig } from '../shared/config.ts';
import { GoogleBusinessClient } from './client.ts';
import { GoogleConnectionService } from './connection.ts';
import { GoogleLocationService } from './location.ts';
import { GoogleOAuthClient, type FetchLike } from './oauth.ts';
import { GoogleContentRetention } from './retention.ts';
import { GoogleEngagementReplier, GoogleReputationProvider } from './reviews.ts';

export interface GoogleIntegration {
  oauth: GoogleOAuthClient;
  client: GoogleBusinessClient;
  connection: GoogleConnectionService;
  location: GoogleLocationService;
  reputationProvider: GoogleReputationProvider;
  replier: GoogleEngagementReplier;
  retention: GoogleContentRetention;
}


export function createGoogleIntegration(deps: { pool: Pool; sink: AuditSink; connections: ProviderConnectionRepository; config: AppConfig; fetchImpl?: FetchLike }): GoogleIntegration {
  const { pool, sink, connections, config } = deps;
  const oauth = new GoogleOAuthClient(config.google, deps.fetchImpl);
  const client = new GoogleBusinessClient({ cfg: config.google, connections, oauth, fetchImpl: deps.fetchImpl });
  const reputationProvider = new GoogleReputationProvider({ pool, sink, connections, client });
  return {
    oauth,
    client,
    connection: new GoogleConnectionService({ pool, sink, connections, oauth, client, cfg: config.google, publicBaseUrl: config.publicBaseUrl }),
    location: new GoogleLocationService(client),
    reputationProvider,
    replier: new GoogleEngagementReplier(reputationProvider),
    retention: new GoogleContentRetention({ pool, sink }),
  };
}
