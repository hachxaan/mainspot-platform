/**
 * API del agente de atención, vínculo de Telegram, ficha de Google y simulador de desarrollo
 * (DEV-E2E-02). Tenant SIEMPRE de la sesión; anti-oracle 404 idéntico; RBAC por acción.
 *
 * El simulador (`/dev/simulator/*`) solo existe fuera de producción y siempre opera sobre el
 * tenant de la sesión: inyecta reseñas/comentarios ficticios, fallos y muestra las respuestas
 * «publicadas» en simulación. Nunca llama a Google/Meta.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { requirePermission } from '../boundary/middleware.ts';
import type { AppConfig } from '../shared/config.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import type { EngagementService } from '../engagement/service.ts';
import type { TelegramLinkService } from '../engagement/telegram.ts';
import type { EngagementWorker } from '../engagement/worker.ts';
import type { GbpProfileService } from '../google/profile.ts';
import { actorOf } from './contact-routes.ts';

export interface EngagementRouteDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  engagement: EngagementService;
  telegram: TelegramLinkService;
  worker: EngagementWorker;
  gbp: GbpProfileService;
}

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

function caseNotFound(res: Response): Response {
  return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró el caso solicitado.' } });
}

export function engagementRouter(deps: EngagementRouteDeps): Router {
  const router = Router();
  const read = requirePermission('engagement.read', deps.sink, deps.pool);

  // ---- casos
  router.get('/engagement/cases', read, ah(async (req, res) => {
    const actor = actorOf(req);
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const origin = typeof req.query.origin === 'string' ? req.query.origin : undefined;
    const cases = await deps.engagement.listCases(actor.tenantId, { state, origin });
    await deps.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role, action: 'engagement.read',
      resource: 'engagement_cases', request_id: actor.requestId, decision: 'allow', result: 'success',
    });
    return res.json({ tenant_id: actor.tenantId, cases });
  }));

  router.get('/engagement/cases/:id', read, ah(async (req, res) => {
    const actor = actorOf(req);
    const row = await deps.engagement.getCase(actor.tenantId, String(req.params.id));
    if (!row) return caseNotFound(res);
    return res.json({ case: row });
  }));

  router.post('/engagement/cases/:id/drafts/:index', requirePermission('engagement.respond', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    try {
      return res.json({ case: await deps.engagement.editDraft(actor, String(req.params.id), Number(req.params.index) - 1, req.body?.text) });
    } catch (err) {
      if (err instanceof AppError && err.code === DENY_CODES.NOT_FOUND) return caseNotFound(res);
      throw err;
    }
  }));

  router.post('/engagement/cases/:id/approve', requirePermission('engagement.approve', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    const id = String(req.params.id);
    try {
      const body = req.body ?? {};
      const draftIndex = body.draft_number === undefined ? undefined : Number(body.draft_number) - 1;
      const r = await deps.engagement.approve(actor, id, { draft_index: draftIndex, text: body.text }, 'panel');
      const after = r.already ? r.case : (await deps.engagement.respondCase(id)) ?? r.case;
      return res.json({
        case: after, already_approved: r.already,
        message: r.already ? 'Ya habías aprobado este caso. No se publicará dos veces.'
          : after.state === 'responded' ? `Respuesta publicada (${after.delivery_mode === 'simulated' ? 'simulación' : 'proveedor'}).`
            : 'Aprobado. La publicación se reintentará automáticamente.',
      });
    } catch (err) {
      if (err instanceof AppError && err.code === DENY_CODES.NOT_FOUND) return caseNotFound(res);
      throw err;
    }
  }));

  router.post('/engagement/cases/:id/reject', requirePermission('engagement.approve', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    try {
      const r = await deps.engagement.reject(actor, String(req.params.id), 'panel');
      return res.json({ case: r.case, already_rejected: r.already });
    } catch (err) {
      if (err instanceof AppError && err.code === DENY_CODES.NOT_FOUND) return caseNotFound(res);
      throw err;
    }
  }));

  // ---- políticas
  router.get('/engagement/policies', read, ah(async (req, res) => {
    const actor = actorOf(req);
    return res.json({ tenant_id: actor.tenantId, policies: await deps.engagement.currentPolicies(actor.tenantId) });
  }));

  router.put('/engagement/policies', requirePermission('engagement.policy.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    const policy = await deps.engagement.setPolicy(actor, req.body);
    return res.json({ policy });
  }));

  // ---- «Procesar ahora»: solo el tenant de la sesión
  router.post('/engagement/run', requirePermission('engagement.policy.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    return res.json({ report: await deps.worker.tickTenant(actor.tenantId, true) });
  }));

  // ---- Telegram (vínculo del chat de avisos de la persona en sesión)
  router.get('/telegram/link', requirePermission('telegram.link', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    return res.json(await deps.telegram.status(actor.tenantId, actor.userId));
  }));
  router.post('/telegram/link-code', requirePermission('telegram.link', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    const code = await deps.telegram.createCode(actor);
    return res.status(201).json({
      ...code,
      instructions: `Abre el bot de MainSpot en Telegram y envía: /start ${code.code}`,
      channel_mode: deps.config.channelPrimary === 'telegram' && deps.config.telegramBotToken ? 'real' : 'simulated',
    });
  }));
  router.delete('/telegram/link', requirePermission('telegram.link', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    await deps.telegram.unlink(actor);
    return res.json({ ok: true });
  }));

  // ---- Ficha de Google (simulada)
  router.get('/google/profile', requirePermission('data.read', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    return res.json(await deps.gbp.view(actor.tenantId));
  }));
  router.put('/google/profile', requirePermission('client.config.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    return res.json({ profile: await deps.gbp.save(actor, req.body) });
  }));
  router.post('/google/profile/simulate-verification', requirePermission('client.config.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    return res.json({ profile: await deps.gbp.simulateVerification(actor) });
  }));

  // ---- Simulador de proveedores (fuera de producción)
  const devOnly = (req: Request, res: Response, next: () => void) => {
    if (deps.config.appEnv === 'production') {
      res.status(404).json({ error: { code: 'not_found', message: 'No disponible.' } });
      return;
    }
    next();
  };
  const simPerm = requirePermission('engagement.policy.manage', deps.sink, deps.pool);

  router.post('/dev/simulator/google-reviews', devOnly, simPerm, ah(async (req, res) => {
    const actor = actorOf(req);
    const b = req.body ?? {};
    const rating = Number(b.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new AppError(400, 'validation_error', 'La calificación debe ser de 1 a 5.');
    if (typeof b.body !== 'string' || !b.body.trim() || b.body.length > 4000) throw new AppError(400, 'validation_error', 'Escribe el texto de la reseña.');
    const author = typeof b.author_label === 'string' && b.author_label.trim() ? b.author_label.trim().slice(0, 120) : 'Cliente de prueba';
    const ref = typeof b.external_ref === 'string' && b.external_ref ? b.external_ref.slice(0, 120) : `sim_g_${randomUUID().slice(0, 12)}`;
    const ins = await deps.pool.query(
      `INSERT INTO sim_provider_event (tenant_id, origin, external_ref, author_label, body, rating)
       VALUES ($1,'google_review',$2,$3,$4,$5) ON CONFLICT (tenant_id, origin, external_ref) DO NOTHING RETURNING event_seq`,
      [actor.tenantId, ref, author, b.body.trim(), rating]);
    return res.status(201).json({ external_ref: ref, created: (ins.rowCount ?? 0) > 0, provider_mode: 'simulated' });
  }));

  router.post('/dev/simulator/facebook-comments', devOnly, simPerm, ah(async (req, res) => {
    const actor = actorOf(req);
    const b = req.body ?? {};
    if (typeof b.body !== 'string' || !b.body.trim() || b.body.length > 4000) throw new AppError(400, 'validation_error', 'Escribe el texto del comentario.');
    const post = await deps.pool.query<{ post_id: string }>(
      `SELECT post_id FROM social_post WHERE tenant_id = $1 AND post_id = $2 AND status = 'published'`, [actor.tenantId, String(b.post_id ?? '')]);
    if (!post.rows[0]) return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró una publicación publicada con ese identificador.' } });
    const author = typeof b.author_label === 'string' && b.author_label.trim() ? b.author_label.trim().slice(0, 120) : 'Persona de prueba';
    const ref = typeof b.external_ref === 'string' && b.external_ref ? b.external_ref.slice(0, 120) : `sim_fbc_${randomUUID().slice(0, 12)}`;
    const ins = await deps.pool.query(
      `INSERT INTO sim_provider_event (tenant_id, origin, external_ref, post_ref, author_label, body)
       VALUES ($1,'facebook_comment',$2,$3,$4,$5) ON CONFLICT (tenant_id, origin, external_ref) DO NOTHING RETURNING event_seq`,
      [actor.tenantId, ref, post.rows[0].post_id, author, b.body.trim()]);
    return res.status(201).json({ external_ref: ref, created: (ins.rowCount ?? 0) > 0, provider_mode: 'simulated' });
  }));

  router.post('/dev/simulator/faults', devOnly, simPerm, ah(async (req, res) => {
    const actor = actorOf(req);
    const b = req.body ?? {};
    if (!['google_review', 'facebook_comment', 'telegram'].includes(b.origin) || !['error', 'timeout', 'list_error'].includes(b.kind)) {
      throw new AppError(400, 'validation_error', 'Fallo simulado no válido.');
    }
    const count = Number(b.count ?? 1);
    if (!Number.isInteger(count) || count < 0 || count > 20) throw new AppError(400, 'validation_error', 'El número de fallos debe estar entre 0 y 20.');
    await deps.pool.query(
      `INSERT INTO sim_provider_fault (tenant_id, origin, kind, remaining) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, origin, kind) DO UPDATE SET remaining = EXCLUDED.remaining`, [actor.tenantId, b.origin, b.kind, count]);
    return res.json({ ok: true });
  }));

  router.get('/dev/simulator/replies', devOnly, read, ah(async (req, res) => {
    const actor = actorOf(req);
    const rows = await deps.pool.query(
      `SELECT origin, target_ref, text, external_ref, created_at FROM sim_provider_reply WHERE tenant_id = $1 ORDER BY created_at`, [actor.tenantId]);
    return res.json({ provider_mode: 'simulated', replies: rows.rows });
  }));

  return router;
}

/**
 * Webhook público de Telegram (forma de Update). Con TELEGRAM_WEBHOOK_SECRET exige la cabecera
 * `X-Telegram-Bot-Api-Secret-Token`; sin secreto solo se acepta fuera de producción (simulación).
 */
export function telegramWebhookRouter(deps: { config: AppConfig; telegram: TelegramLinkService }): Router {
  const router = Router();
  router.post('/api/telegram/webhook', ah(async (req, res) => {
    const secret = deps.config.telegramWebhookSecret;
    if (secret) {
      const got = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''));
      const want = Buffer.from(secret);
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        return res.status(401).json({ error: { code: 'unauthorized', message: 'Solicitud no autorizada.' } });
      }
    } else if (deps.config.appEnv === 'production') {
      return res.status(503).json({ error: { code: 'not_configured', message: 'Webhook no configurado.' } });
    }
    const result = await deps.telegram.handleUpdate(req.body ?? {});
    return res.json({ ok: true, ...result });
  }));
  return router;
}
