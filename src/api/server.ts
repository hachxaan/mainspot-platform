/**
 * HTTP server entry — wires configuration, pool, middlewares and routes.
 * Exposes createApp() so integration tests can boot the app in-process.
 */

import { fileURLToPath } from 'node:url';
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
import { errorPageHtml } from './ui.ts';
import { log } from '../shared/logger.ts';
import { AppError } from '../shared/errors.ts';
import { buildInc001Hooks } from '../hooks/contracts.ts';
import { ConversationRepository } from '../conversation/repositories.ts';
import { ConversationPipeline } from '../conversation/pipeline.ts';
import { createJevClassifier, type JevClassifier } from '../conversation/jev-classifier.ts';
import { JevRepository } from '../conversation/jev-repository.ts';
import type { StateMachineDeps } from '../conversation/state-machine.ts';
import { WebsiteRepository } from '../website/repository.ts';
import { DomainService } from '../domain/service.ts';
import { PublisherRegistry } from '../publishing/publisher.ts';
import { StubPublisher } from '../publishing/stub.ts';
import { WebsitePublisher } from '../publishing/website.ts';
import { createChannelAdapter } from '../channels/registry.ts';
// INC-004 reputation (CAP-002/CAP-004, DEC-011/023/026)
import { SimulatedReviews } from '../reputation/simulated.ts';
import { ReputationEngine } from '../reputation/engine.ts';
import { ReputationPublisher } from '../reputation/publisher.ts';
import { reputationRouter } from './reputation-routes.ts';
// INC-005 social (CAP-003, DEC-017/026)
import { createSocialProvider } from '../social/meta.ts';
import { SocialService } from '../social/service.ts';
import { SocialPublisher } from '../social/publisher.ts';
import { SocialScheduler } from '../social/scheduler.ts';
import { socialRouter } from './social-routes.ts';
import { MetaPagesAdapter } from '../social/meta-graph.ts';
import { metaConnectionRouter, metaOAuthCallbackRouter } from './meta-connection-routes.ts';
// INC-006 subscriptions (CAP-012, DEC-024)
import { EntitlementService, SubscriptionRepository } from '../subscriptions/entitlements.ts';
import { QuotaLedger } from '../subscriptions/quota.ts';
import { subscriptionRouter } from './subscription-routes.ts';
// INC-007 analytics base (CAP-014, DEC-025)
import { ExportService } from '../analytics/export.ts';
import { RetentionService } from '../retention/service.ts';
import { AnalyticsService } from '../analytics/summary.ts';
import { analyticsRouter } from './analytics-routes.ts';
// DEV-E2E-02: teléfonos de contacto por integración (SHARED-CONTRACT §A).
import { ContactPhoneService } from '../contact/phones.ts';
import { OnboardingService } from '../identity/onboarding.ts';
import { contactRouter } from './contact-routes.ts';
// DEV-E2E-02: agente de atención por políticas, Telegram y ficha de Google (simulados sin credenciales).
import { EngagementService } from '../engagement/service.ts';
import { EngagementWorker } from '../engagement/worker.ts';
import { TelegramLinkService } from '../engagement/telegram.ts';
import { SimulatedCommentSource, SimulatedReplier } from '../engagement/providers.ts';
import { MetaCommentSource, MetaCommentReplier, RoutedReplier } from '../social/meta-engagement.ts';
import { GbpProfileService } from '../google/profile.ts';
import { engagementRouter, telegramWebhookRouter } from './engagement-routes.ts';
import type { ChannelAdapter } from '../channels/types.ts';
// DEV-E2E-04: conexión real por negocio con Google/Meta (tokens cifrados, OAuth state).
import { ProviderConnectionRepository } from '../connectors/repository.ts';
import { SecretBox } from '../connectors/secret-box.ts';
// DEV-E2E-04 (P1 Google): OAuth por negocio, ficha/reseñas reales y retención de contenido de Google.
import { createGoogleIntegration, type GoogleIntegration } from '../google/integration.ts';
import { googleConnectionRouter, googleOAuthCallbackRouter } from './google-connection-routes.ts';
// DEV-E2E-04 (P3): sitio local real por negocio (Host <slug>.<LOCAL_SITE_DOMAIN> → versión publicada).
import { localSiteMiddleware } from '../website/local-site.ts';
// DEV-E2E-04 (P2): recuperación de contraseña por correo (transporte real por configuración).
import { createMailer, type Mailer } from '../mail/mailer.ts';
import { PasswordResetService } from '../identity/password-reset.ts';
import { passwordResetRouter } from './password-reset-routes.ts';

export interface AppHandle {
  app: express.Express;
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  identityRepo: IdentityRepository;
  conversationRepo: ConversationRepository;
  conversationRoutesDeps: ConversationRouteDeps;
  /** APR-0002: clasificador Jev (solo con JEV_MODE=shadow|primary); drain() en apagado/tests. */
  jev?: JevClassifier;
  /** DEC-0005: libro de cuotas (reconciliación periódica en main; tests la invocan directamente). */
  quota: QuotaLedger;
  /** QS-0006: retención global (ejecución diaria en main; tests y scripts la invocan directamente). */
  retention: RetentionService;
  /** DEV-E2E-02: teléfonos de contacto (principal + override por integración). */
  phones: ContactPhoneService;
  /** DEV-E2E-02: agente de atención; el worker corre en main (o en su propio proceso). */
  engagement: EngagementService;
  engagementWorker: EngagementWorker;
  telegram: TelegramLinkService;
  channel: ChannelAdapter;
  /** DEV-E2E-04: conexiones por negocio con proveedores reales (tokens solo cifrados). */
  connections: ProviderConnectionRepository;
  /** DEV-E2E-04 (P4): scheduler automático de publicaciones aprobadas (arranca en main). */
  socialScheduler: SocialScheduler;
  /** DEV-E2E-04 (P2): transporte de correo (disabled por defecto) y recuperación de contraseña. */
  mailer: Mailer;
  passwordReset: PasswordResetService;
  /** DEV-E2E-04 (P1 Google): conector real (conexión OAuth, cliente, retención de contenido 30 días). */
  google: GoogleIntegration;
}

/**
 * IR-13: security headers. DEV-E2E-03: la interfaz carga solo scripts propios (sin scripts en
 * línea); los estilos en línea siguen permitidos por los atributos style del diseño y la vista
 * previa pública. Misma procedencia para fuentes, conexiones y formularios.
 */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function securityHeaders(): (req: Request, res: Response, next: NextFunction) => void {
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}

export function createApp(overrides: { config?: AppConfig; pool?: Pool; mailer?: Mailer } = {}): AppHandle {
  const config = overrides.config ?? loadConfig();
  const pool = overrides.pool ?? getPool({ connectionString: config.databaseUrl });
  const sink = new AuditSink(pool);
  const identityRepo = new IdentityRepository(pool);
  const sessionResolver = new SessionResolver(identityRepo, config.jwtSecret);
  const dataRepo = new TenantDataRepository(pool);
  const actionRepo = new DemoActionRepository(pool);
  const loginRateLimiter = new LoginRateLimiter(config.rateLimitMax, config.rateLimitWindowMs, config.rateLimitLockMs);
  // DEV-E2E-04: una clave mal formada falla al arrancar; sin clave no se guardan tokens.
  const connections = new ProviderConnectionRepository(pool, config.connectorTokenKey ? SecretBox.fromBase64(config.connectorTokenKey) : null);
  // DEV-E2E-04 (P1 Google): rutas de conexión siempre presentes; modo real solo con OAuth + clave.
  const google = createGoogleIntegration({ pool, sink, connections, config });
  // DEV-E2E-04 (P2): configuración incompleta del correo falla al arrancar; sin transporte no se envía nada.
  const mailer = overrides.mailer ?? createMailer(config.mail);
  const passwordReset = new PasswordResetService({ pool, sink, mailer, publicBaseUrl: config.publicBaseUrl });

  // INC-002/INC-003 wiring (DEC-016, DEC-019, DEC-026).
  const hooks = buildInc001Hooks({ pool, jwtSecret: config.jwtSecret, sink });
  const conversationRepo = new ConversationRepository(pool);
  const websiteRepo = new WebsiteRepository(pool);
  const domainService = new DomainService(pool, config);
  const channel = createChannelAdapter(config);
  const publishers = new PublisherRegistry();
  const phones = new ContactPhoneService({
    pool, sink,
    providerModes: {
      google_business_profile: config.reputationProvider === 'google_business_profile' ? 'real' : 'simulated',
      facebook: config.socialProvider === 'meta' ? 'real' : 'simulated',
    },
  });
  publishers.register(new WebsitePublisher(pool, domainService, phones));
  publishers.register(new StubPublisher());
  // INC-004/005: publishers de reputación y social (solo tras aprobación humana).
  const reputationProvider = config.reputationProvider === 'google_business_profile' ? google.reputationProvider : new SimulatedReviews(pool);
  publishers.register(new ReputationPublisher(pool, reputationProvider, sink));
  // DEV-E2E-04 §2B: el proveedor real publica con la Page y el token cifrado de CADA negocio.
  const socialProvider = createSocialProvider(config, connections);
  publishers.register(new SocialPublisher(pool, socialProvider, sink));
  // DEV-E2E-04 P4: scheduler automático de publicaciones aprobadas (arranca en main; el
  // tick manual /social/process-due usa su mismo reclamo acotado al tenant de la sesión).
  const socialScheduler = new SocialScheduler({ pool, sink, provider: socialProvider, timezone: config.socialSchedulerTimezone });
  // INC-006: entitlements (límites por plan configurable, DEC-024); DEC-0005:
  // consumo atómico de cuota por tenant con auditoría conjunta (NFR-0001).
  const entitlements = new EntitlementService({ pool, sink });
  const quota = new QuotaLedger({ pool, sink });
  const subscriptionRepo = new SubscriptionRepository(pool);
  // INC-004: reputación (engine)
  const reputationEngine = new ReputationEngine({ pool, config, sink, provider: reputationProvider, conversationRepo, quota });
  // INC-005: social (service + cola de programación)
  const socialService = new SocialService({ pool, config, sink, provider: socialProvider, conversationRepo, quota, scheduler: socialScheduler });
  // INC-007: analítica mínima (export/summary); QS-0006: retención global automática.
  const exporter = new ExportService(pool);
  const retention = new RetentionService({ pool, sink });
  const analyticsService = new AnalyticsService({ pool });
  // Un modo real explícito nunca cae al simulador por carecer de credenciales.
  const realGoogle = config.reputationProvider === 'google_business_profile';
  const realMeta = socialProvider instanceof MetaPagesAdapter;
  const simulatedReplier = new SimulatedReplier(pool);
  const replier = new RoutedReplier({
    google_review: realGoogle ? google.replier : simulatedReplier,
    facebook_comment: realMeta ? new MetaCommentReplier(pool, socialProvider) : simulatedReplier,
  });
  const engagement = new EngagementService({ pool, sink, replier, phones, channel, panelUrl: `${config.publicBaseUrl}/panel` });
  const engagementWorker = new EngagementWorker({
    pool, service: engagement, reputationEngine,
    comments: realMeta ? new MetaCommentSource(pool, socialProvider) : new SimulatedCommentSource(pool),
    pollIntervalMs: config.engagementPollIntervalMs,
  });
  const telegram = new TelegramLinkService({ pool, sink, channel, engagement });
  const gbp = new GbpProfileService({ pool, sink, phones, mode: realGoogle ? 'real' : 'simulated', google: google.location, connections });
  const machine: StateMachineDeps = {
    pool,
    sink,
    repo: conversationRepo,
    publishers,
    previewTtlMinutes: config.previewTokenTtlMinutes,
  };
  // APR-0002: Jev como clasificador — UN cliente por proceso, solo con
  // JEV_MODE=shadow|primary y solo para tenants sintéticos (DEC-0019).
  const jev = createJevClassifier(config.jev, new JevRepository(pool));
  const pipeline = new ConversationPipeline({ pool, config, sink, hooks, repo: conversationRepo, websiteRepo, quota, jev, phones });
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
    onboarding: new OnboardingService({ pool, sink }),
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
    quota,
    phones,
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.use(express.json({ limit: '100kb' }));

  // Correlation + structured access logs for every request.
  app.use(requestContext());

  // DEV-E2E-04 (P3): peticiones con Host de sitio de cliente (<slug>.<LOCAL_SITE_DOMAIN>) se atienden
  // aquí y nunca llegan al panel ni a la API; el host del panel (PUBLIC_BASE_URL) queda excluido.
  app.use(localSiteMiddleware({ pool, domain: config.localSiteDomain, excludeHosts: [new URL(config.publicBaseUrl).hostname] }));

  // Auth (public endpoints: login/logout).
  app.use('/api/auth', authRouter(deps));
  app.use('/api/auth/password', passwordResetRouter({ service: passwordReset }));

  // Webhook de Telegram (público; secreto obligatorio en todo entorno).
  app.use(telegramWebhookRouter({ config, telegram }));

  // Callback público de OAuth de Google (autenticado solo por el state de un solo uso).
  app.use(googleOAuthCallbackRouter({ service: google.connection, publicBaseUrl: config.publicBaseUrl }));

  // DEV-E2E-04 §2B: callback público de Facebook Login (autenticado solo por el state de un solo uso).
  const metaRouteDeps = { pool, config, sink, connections, meta: socialProvider instanceof MetaPagesAdapter ? socialProvider : null };
  app.use(metaOAuthCallbackRouter(metaRouteDeps));

  // Preview/sandbox público (INC-002, CAP-008): enlace seguro con token.
  app.use(previewRouter({ config, sink, repo: conversationRepo, machine, approvalRateLimiter, phones }));

  // Protected backoffice API: session -> tenant override guard -> permission.
  app.use('/api/backoffice', resolveSession(sessionResolver, sink, pool));
  app.use('/api/backoffice', requireSession());
  app.use('/api/backoffice', rejectTenantOverride(pool));
  app.use('/api/backoffice', backofficeRouter(deps));
  app.use('/api/backoffice', conversationRouter(conversationDeps));
  app.use('/api/backoffice', reputationRouter({ pool, config, sink, engine: reputationEngine, approvalRateLimiter }));
  app.use('/api/backoffice', socialRouter({ pool, config, sink, service: socialService, approvalRateLimiter }));
  app.use('/api/backoffice', metaConnectionRouter(metaRouteDeps));
  app.use('/api/backoffice', subscriptionRouter({ pool, config, sink, entitlements, subscriptionRepo }));
  app.use('/api/backoffice', analyticsRouter({ pool, config, sink, exporter, retention, analytics: analyticsService }));
  app.use('/api/backoffice', contactRouter({ pool, sink, phones }));
  app.use('/api/backoffice', engagementRouter({ pool, config, sink, engagement, telegram, worker: engagementWorker, gbp, channel }));
  app.use('/api/backoffice', googleConnectionRouter({ pool, sink, service: google.connection, publicBaseUrl: config.publicBaseUrl }));

  // DEV-E2E-03: interfaz de Claude Design integrada (src/web/panel, adaptada del prototipo
  // docs/ux/claude-design/deliverables). Un solo shell para entrar, invitación y panel; las
  // rutas internas van en el fragmento (#/…), así el token de invitación nunca llega al servidor.
  app.use('/assets', express.static(fileURLToPath(new URL('../web/panel/assets/', import.meta.url)), { index: false, maxAge: 0 }));
  const panelShell = fileURLToPath(new URL('../web/panel/index.html', import.meta.url));
  app.get(['/', '/panel', '/invitacion', '/restablecer'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(panelShell);
  });
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

  return { app, pool, config, sink, identityRepo, conversationRepo, conversationRoutesDeps: conversationDeps, jev, quota, retention, phones, engagement, engagementWorker, telegram, channel, connections, socialScheduler, mailer, passwordReset, google };
}

/** DEC-0005: cada cuánto se cierran las reservas de cuota vencidas (caídas a mitad). */
export const QUOTA_RECONCILE_INTERVAL_MS = 60_000;
/** DEC-0025: cada cuánto se comprueba si toca la ejecución diaria de retención. */
export const RETENTION_CHECK_INTERVAL_MS = 15 * 60_000;

async function main(): Promise<void> {
  const { app, config, jev, quota, retention, engagementWorker, socialScheduler, google } = createApp();
  app.listen(config.port, () => {
    log.info('server.started', `mainspot-platform listening on :${config.port}`, { port: config.port });
  });
  const reconcile = () => {
    quota.reconcile().catch((err: unknown) => {
      log.error('quota.reconcile.failed', 'quota reconciliation failed', { error_name: err instanceof Error ? err.name : 'unknown' });
    });
  };
  reconcile();
  const reconcileTimer = setInterval(reconcile, QUOTA_RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();
  const retain = () => {
    // Se purga con un día de margen frente al máximo de 30 días, también al arrancar.
    google.retention.purge().catch((err: unknown) => {
      log.error('google.retention.failed', 'google content purge failed', { error_name: err instanceof Error ? err.name : 'unknown' });
    });
    retention.runScheduledIfDue().catch((err: unknown) => {
      log.error('retention.scheduled.failed', 'scheduled retention run failed', { error_name: err instanceof Error ? err.name : 'unknown' });
    });
  };
  retain();
  const retentionTimer = setInterval(retain, RETENTION_CHECK_INTERVAL_MS);
  retentionTimer.unref();
  // DEV-E2E-02: observador del agente de atención (sin navegador abierto).
  if (config.engagementWorkerEnabled) {
    engagementWorker.start(config.engagementWorkerIntervalMs);
    log.info('engagement.worker.started', 'engagement worker running in server process', { interval_ms: config.engagementWorkerIntervalMs });
  }
  // DEV-E2E-04 (P4): publicaciones aprobadas se publican solas a su hora (restart-safe).
  if (config.socialSchedulerEnabled) {
    socialScheduler.start(config.socialSchedulerIntervalMs);
    log.info('social.scheduler.started', 'social scheduler running in server process', {
      interval_ms: config.socialSchedulerIntervalMs, timezone: config.socialSchedulerTimezone, provider: socialScheduler.provider.provider,
    });
  }
  if (jev) {
    // Apagado ordenado: espera las clasificaciones Jev pendientes de persistir
    // (cada llamada acotada a 10 s) antes de salir.
    const shutdown = (signal: string) => {
      log.info('server.stopping', `received ${signal}; draining Jev classifications`, {});
      void jev.drain().finally(() => process.exit(0));
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
