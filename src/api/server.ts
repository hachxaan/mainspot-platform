/**
 * HTTP server entry — wires configuration, pool, middlewares and routes.
 * Exposes createApp() so integration tests can boot the app in-process.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { loadConfig, type AppConfig } from '../shared/config.ts';
import { getPool } from '../db/pool.ts';
import { AuditSink } from '../audit/sink.ts';
import { IdentityRepository } from '../identity/repository.ts';
import { SessionResolver } from '../boundary/session.ts';
import { requestContext, resolveSession, requireSession, rejectTenantOverride } from '../boundary/middleware.ts';
import { TenantDataRepository, DemoActionRepository } from '../boundary/datasource.ts';
import { LoginRateLimiter } from '../boundary/ratelimit.ts';
import { ActionRateLimiter } from '../boundary/action-ratelimit.ts';
import { authRouter, backofficeRouter } from './routes.ts';
import { conversationRouter, type ConversationRouteDeps } from './conversation-routes.ts';
import { previewRouter } from './preview-routes.ts';
import { loginPageHtml, panelPageHtml, errorPageHtml } from './ui.ts';
import { log } from '../shared/logger.ts';
import { AppError } from '../shared/errors.ts';
import { buildInc001Hooks } from '../hooks/contracts.ts';
import { ConversationRepository } from '../conversation/repositories.ts';
import { ConversationPipeline } from '../conversation/pipeline.ts';
import type { StateMachineDeps } from '../conversation/state-machine.ts';
import { WebsiteRepository } from '../website/repository.ts';
import { DomainService } from '../domain/service.ts';
import { PublisherRegistry } from '../publishing/publisher.ts';
import { StubPublisher } from '../publishing/stub.ts';
import { WebsitePublisher } from '../publishing/website.ts';
import { createChannelAdapter } from '../channels/registry.ts';
// INC-004 reputation (CAP-002/CAP-004, DEC-011/023/026)
import { createReputationProvider } from '../reputation/google.ts';
import { ReputationEngine } from '../reputation/engine.ts';
import { ReputationPublisher } from '../reputation/publisher.ts';
import { reputationRouter } from './reputation-routes.ts';
// INC-005 social (CAP-003, DEC-017/026)
import { createSocialProvider } from '../social/meta.ts';
import { SocialService } from '../social/service.ts';
import { SocialPublisher } from '../social/publisher.ts';
import { socialRouter } from './social-routes.ts';
// INC-006 subscriptions (CAP-012, DEC-024)
import { EntitlementService, SubscriptionRepository } from '../subscriptions/entitlements.ts';
import { subscriptionRouter } from './subscription-routes.ts';
// INC-007 analytics base (CAP-014, DEC-025)
import { ExportService } from '../analytics/export.ts';
import { RetentionService } from '../analytics/retention.ts';
import { AnalyticsService } from '../analytics/summary.ts';
import { analyticsRouter } from './analytics-routes.ts';

export interface AppHandle {
  app: express.Express;
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  identityRepo: IdentityRepository;
  conversationRepo: ConversationRepository;
  conversationRoutesDeps: ConversationRouteDeps;
}

/** IR-13: basic security headers (CSP baseline, HSTS, nosniff, frame guard). */
export function securityHeaders(): (req: Request, res: Response, next: NextFunction) => void {
  return (_req, res, next) => {
    // The pilot UI is a single page with inline styles/scripts; CSP baseline
    // keeps inline allowed but restricts origins to self + data: images.
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}

export function createApp(overrides: { config?: AppConfig; pool?: Pool } = {}): AppHandle {
  const config = overrides.config ?? loadConfig();
  const pool = overrides.pool ?? getPool({ connectionString: config.databaseUrl });
  const sink = new AuditSink(pool);
  const identityRepo = new IdentityRepository(pool);
  const sessionResolver = new SessionResolver(identityRepo, config.jwtSecret);
  const dataRepo = new TenantDataRepository(pool);
  const actionRepo = new DemoActionRepository(pool);
  const loginRateLimiter = new LoginRateLimiter(config.rateLimitMax, config.rateLimitWindowMs, config.rateLimitLockMs);

  // INC-002/INC-003 wiring (DEC-016, DEC-019, DEC-026).
  const hooks = buildInc001Hooks({ pool, jwtSecret: config.jwtSecret, sink });
  const conversationRepo = new ConversationRepository(pool);
  const websiteRepo = new WebsiteRepository(pool);
  const domainService = new DomainService(pool, config);
  const channel = createChannelAdapter(config);
  const publishers = new PublisherRegistry();
  publishers.register(new WebsitePublisher(pool, domainService));
  publishers.register(new StubPublisher());
  // INC-004/005: publishers de reputación y social (solo tras aprobación humana).
  const reputationProvider = createReputationProvider(config);
  publishers.register(new ReputationPublisher(pool, reputationProvider, sink));
  const socialProvider = createSocialProvider(config);
  publishers.register(new SocialPublisher(pool, socialProvider, sink));
  // INC-006: entitlements (límites por plan configurable, DEC-024).
  const entitlements = new EntitlementService({ pool, sink });
  const subscriptionRepo = new SubscriptionRepository(pool);
  // INC-004: reputación (engine)
  const reputationEngine = new ReputationEngine({ pool, config, sink, provider: reputationProvider, conversationRepo, entitlements });
  // INC-005: social (service + cola de programación)
  const socialService = new SocialService({ pool, config, sink, provider: socialProvider, conversationRepo, entitlements });
  // INC-007: analítica mínima (export/retention/summary)
  const exporter = new ExportService(pool);
  const retention = new RetentionService({ pool, retentionDays: config.retentionDays });
  const analyticsService = new AnalyticsService({ pool });
  const machine: StateMachineDeps = {
    pool,
    sink,
    repo: conversationRepo,
    publishers,
    previewTtlMinutes: config.previewTokenTtlMinutes,
  };
  const pipeline = new ConversationPipeline({ pool, config, sink, hooks, repo: conversationRepo, websiteRepo });
  const approvalRateLimiter = new ActionRateLimiter(
    config.approvalRateLimitMax,
    config.approvalRateLimitWindowMs,
    config.approvalRateLimitLockMs,
  );

  const deps = {
    pool,
    config,
    sink,
    identityRepo,
    sessionResolver,
    dataRepo,
    actionRepo,
    loginRateLimiter,
  };

  const conversationDeps: ConversationRouteDeps = {
    pool,
    config,
    sink,
    repo: conversationRepo,
    pipeline,
    machine,
    approvalRateLimiter,
    websiteRepo,
    domainService,
    channel,
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.use(express.json({ limit: '100kb' }));

  // Correlation + structured access logs for every request.
  app.use(requestContext());

  // Auth (public endpoints: login/logout).
  app.use('/api/auth', authRouter(deps));

  // Preview/sandbox público (INC-002, CAP-008): enlace seguro con token.
  app.use(previewRouter({ config, sink, repo: conversationRepo, machine, approvalRateLimiter }));

  // Protected backoffice API: session -> tenant override guard -> permission.
  app.use('/api/backoffice', resolveSession(sessionResolver, sink, pool));
  app.use('/api/backoffice', requireSession());
  app.use('/api/backoffice', rejectTenantOverride(pool));
  app.use('/api/backoffice', backofficeRouter(deps));
  app.use('/api/backoffice', conversationRouter(conversationDeps));
  app.use('/api/backoffice', reputationRouter({ pool, config, sink, engine: reputationEngine }));
  app.use('/api/backoffice', socialRouter({ pool, config, sink, service: socialService }));
  app.use('/api/backoffice', subscriptionRouter({ pool, config, sink, entitlements, subscriptionRepo }));
  app.use('/api/backoffice', analyticsRouter({ pool, config, sink, exporter, retention, analytics: analyticsService }));

  // Minimal UX pages (AC-008).
  app.get('/', (req, res) => res.type('html').send(loginPageHtml()));
  app.get('/panel', (req, res) => res.type('html').send(panelPageHtml()));
  app.get('/health', (req, res) => res.json({ ok: true, app: 'mainspot-platform', increments: ['INC-001', 'INC-002', 'INC-003', 'INC-004', 'INC-005', 'INC-006', 'INC-007'] }));

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

  return { app, pool, config, sink, identityRepo, conversationRepo, conversationRoutesDeps: conversationDeps };
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
