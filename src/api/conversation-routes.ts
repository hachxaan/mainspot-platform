/**
 * API interna del flujo conversacional (INC-002) y website (INC-003).
 *
 * Rutas sesión-protegidas (fail-closed INC-001: session → tenant guard →
 * permiso). Invariantes:
 *  - scope tenant SIEMPRE de la sesión (body/params nunca cambian tenant).
 *  - anti-oracle: proposal/request inexistente o de otro tenant ⇒ 404 idéntico.
 *  - rate limiting en aprobación/rechazo sensibles (IP + actor + recurso).
 *  - toda transición emite auditoría con request_id (REQ-009, NFR-005).
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import { getRequestContext, type SessionSummary } from '../shared/context.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import type { AuditSink } from '../audit/sink.ts';
import type { ConversationRepository, ActionProposalRow } from '../conversation/repositories.ts';
import type { ConversationPipeline } from '../conversation/pipeline.ts';
import type { StateMachineDeps } from '../conversation/state-machine.ts';
import { approveAndPublish, confirmAndPreparePreview, rejectProposal, runAtomic, AlreadyPublishedError } from '../conversation/state-machine.ts';
import type { ActionRateLimiter } from '../boundary/action-ratelimit.ts';
import type { WebsiteRepository } from '../website/repository.ts';
import type { DomainService, ClientDomainRow } from '../domain/service.ts';
import type { ChannelAdapter } from '../channels/types.ts';
import type { LooseRequest } from '../boundary/middleware.ts';
import { requirePermission } from '../boundary/middleware.ts';
import type { ProposalStatus, RequestStatus } from '../conversation/intents.ts';

export interface ConversationRouteDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  repo: ConversationRepository;
  pipeline: ConversationPipeline;
  machine: StateMachineDeps;
  approvalRateLimiter: ActionRateLimiter;
  websiteRepo: WebsiteRepository;
  domainService: DomainService;
  channel: ChannelAdapter;
}

function rcOf(lreq: LooseRequest): { request_id: string; session: SessionSummary | null } {
  const ctx = getRequestContext();
  if (ctx) return { request_id: ctx.request_id, session: ctx.session };
  return { request_id: lreq.request_id ?? 'no-ctx', session: lreq.session ?? null };
}

function sessionOf(lreq: LooseRequest): SessionSummary {
  if (!lreq.session) throw new AppError(401, DENY_CODES.MISSING_ACTOR, 'No se encontró una sesión activa.');
  return lreq.session;
}

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

function approveAllowed(limiter: ActionRateLimiter, ip: string, actor: string, resource: string): number | null {
  if (limiter.allow(ip, actor, resource)) return null;
  return Math.max(1, Math.ceil(limiter.lockRemainingMs(ip, actor, resource) / 1000));
}

export function conversationRouter(deps: ConversationRouteDeps): Router {
  const router = Router();

  // --- Intake: recibir mensaje desde el canal (FLOW-001). ------------------
  router.post('/conversation/messages', requirePermission('conversation.send', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const { text, channel } = (req.body ?? {}) as { text?: string; channel?: 'telegram' | 'simulated' };
    if (!text || !text.trim()) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'Escribe tu solicitud para poder ayudarte.' } });
    }

    const outcome = await deps.pipeline.ingest({
      tenantId: session.tenant_id,
      actorId: session.user_id,
      actorRole: session.role_name,
      channel: channel === 'telegram' ? 'telegram' : 'simulated',
      text: text.trim(),
      requestId: rc.request_id,
    });

    // Respuesta por el canal (best-effort; el outcome JSON es la respuesta API).
    const channelSent = await deps.channel.sendMessage(session.user_id, outcome.responseText).catch(() => ({ ok: false, error: 'send_failed' }));
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'conversation.routed', resource: `request:${outcome.requestId}`,
      request_id: rc.request_id, decision: 'allow', result: outcome.actionClass,
    });

    return res.status(201).json({
      request: { request_id: outcome.requestId, status: outcome.requestStatus, action_class: outcome.actionClass, intent: outcome.intent, capability_target: outcome.capabilityTarget },
      proposal_id: outcome.proposalId ?? null,
      response: outcome.responseText,
      channel_sent: channelSent.ok,
      reply: outcome.responseText,
    });
  }));

  // --- Requests del tenant (conversation.read). -----------------------------
  router.get('/conversation/requests', requirePermission('conversation.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const status = typeof req.query.status === 'string' ? (req.query.status as RequestStatus) : undefined;
    const rows = await deps.repo.listRequests(session.tenant_id, status ? { status } : {});
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'conversation.read', resource: 'requests', request_id: rc.request_id,
      decision: 'allow', result: 'success',
    });
    return res.json({ tenant_id: session.tenant_id, requests: rows });
  }));

  // --- Proposals del tenant (conversation.read). -----------------------------
  router.get('/conversation/proposals', requirePermission('conversation.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const status = typeof req.query.status === 'string' ? (req.query.status as ProposalStatus) : undefined;
    const rows = await deps.repo.listProposals(session.tenant_id, status ? { status } : {});
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'conversation.read', resource: 'proposals', request_id: rc.request_id,
      decision: 'allow', result: 'success',
    });
    return res.json({ tenant_id: session.tenant_id, proposals: rows });
  }));

  router.get('/conversation/proposals/:id', requirePermission('conversation.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;
    const found = await deps.repo.findProposalScoped(session.tenant_id, id);
    // ANTI-ORACLE: inexistente y de otro tenant → mismo 404 y mismo evento.
    if (!found.found || !found.in_tenant) {
      await deps.sink.write({
        tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
        action: 'conversation.read', resource: `action_proposal/${id}`, request_id: rc.request_id,
        decision: 'allow', result: 'not_found',
      });
      return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró la propuesta solicitada.' } });
    }
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'conversation.read', resource: `action_proposal/${id}`, request_id: rc.request_id,
      decision: 'allow', result: 'success',
    });
    return res.json({ proposal: found.row });
  }));

  // --- Confirmar propuesta → preparar preview (conversation.confirm). --------
  router.post('/conversation/proposals/:id/confirm', requirePermission('conversation.confirm', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;
    const found = await deps.repo.findProposalScoped(session.tenant_id, id);
    if (!found.found || !found.in_tenant) {
      await deps.sink.write({
        tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
        action: 'conversation.confirm', resource: `action_proposal/${id}`, request_id: rc.request_id,
        decision: 'allow', result: 'not_found',
      });
      return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró la propuesta solicitada.' } });
    }
    const outcome = await confirmAndPreparePreview(deps.machine, {
      tenantId: session.tenant_id, proposalId: id, actorId: session.user_id, requestId: rc.request_id,
    });
    return res.json({
      proposal: outcome.proposal,
      status: outcome.proposal.status,
      preview: { preview_id: outcome.previewId, url: `/preview/${outcome.token}`, expires_at: outcome.expiresAt },
      message: 'La vista previa está lista. Revisa los cambios y aplícalos con tu aprobación.',
    });
  }));

  // --- Aprobar y publicar (operation.approve, admin). ------------------------
  router.post('/conversation/proposals/:id/approve', requirePermission('operation.approve', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;

    // Rate limiting sobre aprobación sensible (IR-06 pattern, INC-002).
    const retryAfter = approveAllowed(deps.approvalRateLimiter, req.ip ?? 'unknown', session.user_id, id);
    if (retryAfter != null) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: { code: 'too_many_attempts', message: 'Hubo demasiados intentos de aprobación. Espera un momento y vuelve a intentarlo.' } });
    }
    deps.approvalRateLimiter.recordAttempt(req.ip ?? 'unknown', session.user_id, id);

    const found = await deps.repo.findProposalScoped(session.tenant_id, id);
    if (!found.found || !found.in_tenant) {
      await deps.sink.write({
        tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
        action: 'conversation.approved', resource: `action_proposal/${id}`, request_id: rc.request_id,
        decision: 'allow', result: 'not_found',
      });
      return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró la propuesta solicitada.' } });
    }

    let outcome;
    try {
      outcome = await approveAndPublish(deps.machine, {
        tenantId: session.tenant_id, proposalId: id, actorId: session.user_id, actorRole: session.role_name,
        requestId: rc.request_id, source: 'backoffice',
      });
    } catch (err) {
      // Carrera perdida: otra aprobación publicó justo antes (replay idempotente).
      if (err instanceof AlreadyPublishedError) {
        const existing = await deps.repo.publicationByProposal(session.tenant_id, err.proposalId);
        await deps.sink.write({
          tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
          action: 'conversation.publish_attempt', resource: `action_proposal/${id}`, request_id: rc.request_id,
          decision: 'allow', result: 'already_published', evidence_ref: existing?.publication_id ?? null,
        });
        return res.json({
          proposal: (await deps.repo.findProposalScoped(session.tenant_id, id)).row,
          already_published: true,
          publication: existing,
          message: 'Esta propuesta ya estaba publicada. No se publicó de nuevo.',
        });
      }
      throw err;
    }

    if (outcome.alreadyPublished) {
      return res.json({
        proposal: outcome.proposal,
        already_published: true,
        publication: outcome.publication,
        message: 'Esta propuesta ya estaba publicada. No se publicó de nuevo.',
      });
    }
    if (!outcome.published) {
      return res.status(502).json({
        proposal: outcome.proposal,
        already_published: false,
        error: { code: 'publish_failed', message: 'La publicación falló. Revisa el registro y vuelve a intentar la aprobación.' },
      });
    }
    return res.json({
      proposal: outcome.proposal,
      status: outcome.proposal.status,
      already_published: false,
      publication: outcome.publication,
      message: 'Cambios aplicados y publicados. Gracias por tu aprobación.',
    });
  }));

  // --- Rechazar (operation.reject). ------------------------------------------
  router.post('/conversation/proposals/:id/reject', requirePermission('operation.reject', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;

    const retryAfter = approveAllowed(deps.approvalRateLimiter, req.ip ?? 'unknown', session.user_id, `reject:${id}`);
    if (retryAfter != null) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: { code: 'too_many_attempts', message: 'Hubo demasiados intentos. Espera un momento y vuelve a intentarlo.' } });
    }
    deps.approvalRateLimiter.recordAttempt(req.ip ?? 'unknown', session.user_id, `reject:${id}`);

    const found = await deps.repo.findProposalScoped(session.tenant_id, id);
    if (!found.found || !found.in_tenant) {
      await deps.sink.write({
        tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
        action: 'conversation.rejected', resource: `action_proposal/${id}`, request_id: rc.request_id,
        decision: 'allow', result: 'not_found',
      });
      return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró la propuesta solicitada.' } });
    }
    const proposal = await rejectProposal(deps.machine, {
      tenantId: session.tenant_id, proposalId: id, actorId: session.user_id, requestId: rc.request_id,
    });
    return res.json({ proposal, status: proposal.status, message: 'Cambios rechazados. No se publicó nada.' });
  }));

  // --- Website del tenant (data.read) + provisión (website.provision). --------
  router.get('/website', requirePermission('data.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const site = await deps.websiteRepo.websiteForTenant(session.tenant_id);
    const domain = await deps.domainService.findByTenant(session.tenant_id);
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'data.read', resource: 'website', request_id: rc.request_id,
      decision: 'allow', result: 'success',
    });
    return res.json({
      website: site ? {
        website_id: site.website_id,
        slug: site.slug,
        site_name: site.site_name,
        status: site.status,
        published_version: site.published_version,
        data: site.data,
      } : null,
      domain: domain ?? null,
    });
  }));

  router.post('/website/provision', requirePermission('website.provision', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);

    const site = await deps.websiteRepo.websiteForTenant(session.tenant_id);
    if (!site) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Este cliente todavía no tiene una página web configurada.' } });
    }

    // FLOW-006: provisión idempotente + auditoría sensible dentro de transacción.
    const { row, already } = await runAtomic(deps.pool, async (client) => {
      const r = await deps.domainService.ensureProvisioned(session.tenant_id, site.slug, client);
      await deps.sink.write({
        tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
        action: 'website.provisioned', resource: `client_domain/${r.row.subdomain}`, request_id: rc.request_id,
        decision: 'allow', result: r.already ? 'already_provisioned' : 'success',
      }, client);
      return r;
    });

    return res.status(already ? 200 : 201).json({
      domain: row,
      already_provisioned: already,
      message: already ? 'El subdominio ya estaba aprovisionado (no se duplicó).' : 'Subdominio aprovisionado correctamente.',
    });
  }));

  return router;
}

export type { ActionProposalRow };
