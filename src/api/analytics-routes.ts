/**
 * API interna de analítica mínima (INC-007 base, CAP-014, DEC-025).
 *
 * - GET /analytics/export  (analytics.export) export ETL JSON/CSV paginado.
 * - GET /analytics/summary (analytics.read) agregados por día/acción.
 * - POST /analytics/refresh-summary (analytics.export) materializa resumen.
 * - GET /analytics/retention (analytics.retention) qué purgará la retención automática
 *   diaria (DEC-0025) para el tenant, sus plazos y la última ejecución. No borra nada.
 * Fail-closed: scope por tenant de la sesión + auditoría con request_id.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import { getRequestContext, type SessionSummary } from '../shared/context.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import type { AuditSink } from '../audit/sink.ts';
import type { ExportService, ExportFilters } from '../analytics/export.ts';
import type { RetentionService } from '../retention/service.ts';
import type { AnalyticsService } from '../analytics/summary.ts';
import { denyAndRespond, type LooseRequest } from '../boundary/middleware.ts';
import { requirePermission } from '../boundary/middleware.ts';

export interface AnalyticsRouteDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  exporter: ExportService;
  retention: RetentionService;
  analytics: AnalyticsService;
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

function queryStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function analyticsRouter(deps: AnalyticsRouteDeps): Router {
  const router = Router();

  // Export ETL (JSON/CSV) con filtros y paginación. Auditoría del exporte.
  router.get('/analytics/export', requirePermission('analytics.export', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const filters: ExportFilters = {
      from: queryStr(req.query.from),
      to: queryStr(req.query.to),
      action: queryStr(req.query.action),
      format: queryStr(req.query.format) === 'csv' ? 'csv' : 'json',
      page: req.query.page !== undefined ? Number(req.query.page) : undefined,
      pageSize: req.query.page_size !== undefined ? Number(req.query.page_size) : undefined,
    };
    const result = await deps.exporter.exportEvents(session.tenant_id, filters);
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'analytics.export',
      resource: `analytics/export?format=${result.format}&page=${result.page}`,
      request_id: rc.request_id, decision: 'allow', result: `exported:${result.total}`,
    });
    if (result.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-events-${session.tenant_id}.csv"`);
      return res.send(result.data as unknown as string);
    }
    return res.json({
      tenant_id: session.tenant_id,
      format: result.format,
      page: result.page,
      page_size: result.page_size,
      total: result.total,
      has_more: result.has_more,
      generated_at: result.generated_at,
      events: result.data,
    });
  }));

  // Agregados por día/acción (en vivo).
  router.get('/analytics/summary', requirePermission('analytics.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const rows = await deps.analytics.dailySummary(session.tenant_id, {
      from: queryStr(req.query.from), to: queryStr(req.query.to),
    });
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'analytics.read', resource: 'analytics/summary', request_id: rc.request_id,
      decision: 'allow', result: `rows:${rows.length}`,
    });
    return res.json({ tenant_id: session.tenant_id, window: { from: queryStr(req.query.from) ?? null, to: queryStr(req.query.to) ?? null }, daily: rows });
  }));

  // Materializar resumen diario (admin).
  router.post('/analytics/refresh-summary', requirePermission('analytics.export', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const { upserted } = await deps.analytics.refreshDailySummary(session.tenant_id, {
      from: queryStr(req.query.from), to: queryStr(req.query.to),
    });
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'analytics.refresh', resource: 'analytics/summary', request_id: rc.request_id,
      decision: 'allow', result: `upserted:${upserted}`,
    }).catch(() => undefined);
    return res.json({ upserted, message: 'Resumen diario actualizado.' });
  }));

  // Retención automática diaria (DEC-0021..0025): vista previa por tenant, sin efectos.
  router.get('/analytics/retention', requirePermission('analytics.retention', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const preview = await deps.retention.preview(session.tenant_id);
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'data.read', resource: 'analytics/retention', request_id: rc.request_id,
      decision: 'allow', result: 'success',
    });
    return res.json({
      tenant_id: session.tenant_id,
      ...preview,
      message: 'La retención se aplica automáticamente cada día: estos son los datos que purgará en la próxima ejecución.',
    });
  }));

  return router;
}
