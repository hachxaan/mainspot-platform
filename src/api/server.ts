/**
 * HTTP server entry — wires configuration, pool, middlewares and routes.
 * Exposes createApp() so integration tests can boot the app in-process.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { loadConfig, type AppConfig } from '../shared/config.ts';
import { getPool } from '../db/pool.ts';
import { AuditSink, auditedOperation } from '../audit/sink.ts';
import { IdentityRepository } from '../identity/repository.ts';
import { SessionResolver } from '../boundary/session.ts';
import { requestContext, resolveSession, requireSession, rejectTenantOverride } from '../boundary/middleware.ts';
import { TenantDataRepository, DemoActionRepository } from '../boundary/datasource.ts';
import { authRouter, backofficeRouter } from './routes.ts';
import { loginPageHtml, panelPageHtml, errorPageHtml } from './ui.ts';
import { log } from '../shared/logger.ts';
import { AppError } from '../shared/errors.ts';

export interface AppHandle {
  app: express.Express;
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  identityRepo: IdentityRepository;
}

export function createApp(overrides: { config?: AppConfig; pool?: Pool } = {}): AppHandle {
  const config = overrides.config ?? loadConfig();
  const pool = overrides.pool ?? getPool({ connectionString: config.databaseUrl });
  const sink = new AuditSink(pool);
  const identityRepo = new IdentityRepository(pool);
  const sessionResolver = new SessionResolver(identityRepo, config.jwtSecret);
  const dataRepo = new TenantDataRepository(pool);
  const actionRepo = new DemoActionRepository(pool);

  const deps = {
    pool,
    config,
    sink,
    identityRepo,
    sessionResolver,
    dataRepo,
    actionRepo,
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // Correlation + structured access logs for every request.
  app.use(requestContext());

  // Auth (public endpoints: login/logout).
  app.use('/api/auth', authRouter(deps));

  // Protected backoffice API: session -> tenant override guard -> permission.
  app.use('/api/backoffice', resolveSession(sessionResolver, sink, pool));
  app.use('/api/backoffice', requireSession());
  app.use('/api/backoffice', rejectTenantOverride(pool));
  app.use('/api/backoffice', backofficeRouter(deps));

  // Minimal UX pages (AC-008).
  app.get('/', (req, res) => res.type('html').send(loginPageHtml()));
  app.get('/panel', (req, res) => res.type('html').send(panelPageHtml()));
  app.get('/health', (req, res) => res.json({ ok: true, app: 'mainspot-platform', increment: 'INC-001' }));

  // Central error handling: controlled + plain language (AC-008), structured log.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof SyntaxError && req.path.startsWith('/api') && res.statusCode === 400) {
      res.status(400).json({ error: { code: 'validation_error', message: 'El mensaje enviado no es válido. Revisa los datos e inténtalo de nuevo.' } });
      return;
    }
    if (err instanceof AppError) {
      const status = err.status || 400;
      res.status(status).json({ error: { code: err.code ?? 'validation_error', message: err.userMessage } });
      return;
    }
    log.error('http.error', 'unhandled error', { error: (err as Error).message, path: req.path });
    if (req.path.startsWith('/api')) {
      res.status(500).json({ error: { code: 'internal_error', message: 'Ocurrió un problema interno. Inténtalo de nuevo más tarde.' } });
    } else {
      res.status(500).send(errorPageHtml('Ocurrió un problema interno. Inténtalo de nuevo más tarde.', 500));
    }
  });

  return { app, pool, config, sink, identityRepo };
}

async function main(): Promise<void> {
  const { app, config } = createApp();
  app.listen(config.port, () => {
    log.info('server.started', `mainspot-platform listening on :${config.port}`, { port: config.port });
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
