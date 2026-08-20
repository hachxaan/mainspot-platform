/**
 * Rutas PÚBLICAS de preview/sandbox (INC-002, CAP-008, FLOW-002).
 *
 * - GET  /preview/:token  → página de vista previa (sin sesión; lenguaje claro)
 * - POST /preview/:token/apply → "Aplicar cambios": aprobación + publicación
 *   idempotente (AC-007). Rate limiting por IP.
 *
 * El token es la capacidad (alta entropía, single-use, expiración
 * configurable); nunca se guarda crudo (hash SHA-256). TENTATIVA:
 * audiencia/revocación adicional pendiente (canon 05).
 */

import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../shared/config.ts';
import { getRequestContext } from '../shared/context.ts';
import type { AuditSink } from '../audit/sink.ts';
import type { ConversationRepository } from '../conversation/repositories.ts';
import type { StateMachineDeps } from '../conversation/state-machine.ts';
import { approveAndPublish, AlreadyPublishedError, expirePreviewAndProposal, resolvePreviewByToken } from '../conversation/state-machine.ts';
import type { ActionRateLimiter } from '../boundary/action-ratelimit.ts';
import { previewPageHtml, previewExpiredPageHtml, previewNotFoundPageHtml } from './ui.ts';
import { renderSite, normalizeWebsiteData } from '../website/template.ts';
import type { PublisherContext } from '../publishing/publisher.ts';

export interface PreviewRouteDeps {
  config: AppConfig;
  sink: AuditSink;
  repo: ConversationRepository;
  machine: StateMachineDeps;
  approvalRateLimiter: ActionRateLimiter;
}

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

function requestIdOf(): string {
  return getRequestContext()?.request_id ?? `pv_${crypto.randomUUID()}`;
}

export function previewRouter(deps: PreviewRouteDeps): Router {
  const router = Router();
  const previewActor = 'preview_token'; // actor simbólico: el poseedor del enlace

  router.get('/preview/:token', ah(async (req, res) => {
    const resolved = await resolvePreviewByToken(deps.repo, req.params.token as string);
    if (!resolved) {
      return res.status(404).type('html').send(previewNotFoundPageHtml());
    }
    const { proposal } = resolved;
    if (resolved.used) {
      // single-use: ya se aplicó (o el preview se invalidó). Si la propuesta
      // quedó publicada, lo decimos sin duplicar nada (AC-007 idempotencia).
      return res.status(200).type('html').send(previewExpiredPageHtml(proposal.status === 'published'));
    }
    if (resolved.expired) {
      await expirePreviewAndProposal(deps.machine, {
        tenantId: resolved.tenantId, previewId: resolved.previewId, proposalId: proposal.proposal_id,
        requestId: requestIdOf(), actorId: previewActor,
      }).catch(() => undefined);
      return res.status(410).type('html').send(previewExpiredPageHtml());
    }
    if (proposal.status === 'published') {
      return res.status(200).type('html').send(previewExpiredPageHtml(true));
    }

    // Render del sitio propuesto (INC-003) para cambios de web.
    let previewHtml: string | null = null;
    if (proposal.capability_target === 'website') {
      const payload = (proposal.detail ?? {}) as PublisherContext['payload'];
      previewHtml = renderSite(normalizeWebsiteData(payload['after']), { previewBanner: 'Vista previa — aún no publicado' });
    }

    return res.status(200).type('html').send(previewPageHtml({
      token: req.params.token as string,
      summary: proposal.summary,
      detail: proposal.detail,
      previewHtml,
      expiresAt: resolved.expired ? null : undefined,
    }));
  }));

  router.post('/preview/:token/apply', ah(async (req, res) => {
    const token = req.params.token as string;
    const ip = req.ip ?? 'unknown';

    const retryAfter = deps.approvalRateLimiter.allow(ip, previewActor, `apply:${token.slice(0, 24)}`)
      ? null
      : Math.max(1, Math.ceil(deps.approvalRateLimiter.lockRemainingMs(ip, previewActor, `apply:${token.slice(0, 24)}`) / 1000));
    if (retryAfter != null) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: { code: 'too_many_attempts', message: 'Hubo demasiados intentos. Espera un momento y vuelve a intentarlo.' } });
    }
    deps.approvalRateLimiter.recordAttempt(ip, previewActor, `apply:${token.slice(0, 24)}`);

    const resolved = await resolvePreviewByToken(deps.repo, token);
    if (!resolved) {
      return res.status(404).json({ error: { code: 'not_found', message: 'El enlace de vista previa no es válido.' } });
    }
    const { proposal } = resolved;
    if (resolved.used) {
      if (proposal.status === 'published') {
        const existing = await deps.repo.publicationByProposal(resolved.tenantId, proposal.proposal_id);
        return res.json({ already_published: true, publication: existing, message: 'Estos cambios ya estaban publicados.' });
      }
      return res.status(409).json({ error: { code: 'preview_used', message: 'Este enlace de vista previa ya fue utilizado.' } });
    }
    if (resolved.expired) {
      await expirePreviewAndProposal(deps.machine, {
        tenantId: resolved.tenantId, previewId: resolved.previewId, proposalId: proposal.proposal_id,
        requestId: requestIdOf(), actorId: previewActor,
      }).catch(() => undefined);
      return res.status(410).json({ error: { code: 'preview_expired', message: 'El enlace de vista previa expiró. Pide una nueva vista previa.' } });
    }
    if (proposal.status === 'published') {
      const existing = await deps.repo.publicationByProposal(resolved.tenantId, proposal.proposal_id);
      return res.json({ already_published: true, publication: existing, message: 'Estos cambios ya estaban publicados.' });
    }
    if (proposal.status !== 'preview_ready') {
      return res.status(409).json({ error: { code: 'validation_error', message: 'Este preview no está listo para aplicarse.' } });
    }

    let outcome;
    try {
      outcome = await approveAndPublish(deps.machine, {
        tenantId: resolved.tenantId, proposalId: proposal.proposal_id,
        actorId: previewActor, actorRole: null, requestId: requestIdOf(), source: 'preview',
      });
    } catch (err) {
      if (err instanceof AlreadyPublishedError) {
        const existing = await deps.repo.publicationByProposal(resolved.tenantId, err.proposalId);
        return res.json({ already_published: true, publication: existing, message: 'Estos cambios ya estaban publicados.' });
      }
      throw err;
    }

    if (outcome.published) {
      await deps.repo.setPreviewStatus(resolved.tenantId, resolved.previewId, 'used');
      return res.json({
        applied: true,
        status: outcome.proposal.status,
        publication: outcome.publication,
        message: 'Cambios aplicados y publicados.',
      });
    }
    return res.status(502).json({ error: { code: 'publish_failed', message: 'La publicación falló. Inténtalo de nuevo más tarde.' } });
  }));

  return router;
}
