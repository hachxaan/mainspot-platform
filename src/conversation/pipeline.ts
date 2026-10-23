/**
 * Intake pipeline conversacional (INC-002, FLOW-001/002/003; REQ-004).
 *
 * Orden por mensaje (FLOW-001): recibir → asociar cliente/usuario (ya
 * resuelto por la capa de sesión INC-001 — el canal NO sustituye identidad,
 * RULE-001) → clasificar → auditar → enrutar (respuesta directa, borrador,
 * propuesta con confirmación, escalamiento humano o bloqueo).
 *
 * FAIL-CLOSED: sin actor/tenant resuelto el pipeline lanza y no produce
 * ningún efecto. Prohibited ⇒ sin ningún efecto persistido salvo request row
 * + auditoría deny.
 */

import type { Pool, PoolClient } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import type { AuditSink } from '../audit/sink.ts';
import type { Inc001Hooks } from '../hooks/contracts.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { resourceIdOf, type QuotaLedger, type QuotaReservationRow } from '../subscriptions/quota.ts';
import { classifyIntent } from './classifier.ts';
import type { CapabilityTarget, ClassificationResult, IngestOutcome, ProposalDraft } from './intents.ts';
import type { JevClassifier } from './jev-classifier.ts';
import { ConversationRepository, newConversationIds, type ConversationRequestRow } from './repositories.ts';
import { buildReadOnlyAnswer } from './read-answers.ts';
import { editWebsiteByInstruction, sentenceList } from '../website/edit-mapper.ts';
import type { WebsiteRepository } from '../website/repository.ts';
import { runAtomic } from './state-machine.ts';
import { normalizeWebsiteData } from '../website/template.ts';

export interface IngestInput {
  tenantId: string;
  actorId: string;
  actorRole: string | null;
  channel: 'telegram' | 'simulated';
  text: string;
  requestId: string;
  /** DEC-0005: clave de idempotencia (cabecera Idempotency-Key o el request_id). */
  idempotencyKey?: string;
}

export interface PipelineDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  hooks: Inc001Hooks;
  repo: ConversationRepository;
  websiteRepo: WebsiteRepository;
  /** DEC-0005: cuota 'conversations' reservada antes de procesar y consumida con la solicitud. */
  quota?: QuotaLedger;
  /** Opcional (JEV_MODE=shadow|primary, APR-0002): Jev como clasificador; ver jev-classifier.ts. */
  jev?: JevClassifier;
}

/** Senencia de confirmación detallada (AC-006) en lenguaje claro. */
export function confirmationText(draft: ProposalDraft): string {
  const lines = draft.patches?.length
    ? draft.patches.map((p) => `- ${p.sentence}`).join('\n')
    : `- ${draft.summary}`;
  return `Para continuar necesito que confirmes estos cambios:\n${lines}\n\nResponde CONFIRMAR para preparar la vista previa, o RECHAZAR para cancelar.`;
}

function escalationText(draft: ProposalDraft): string {
  return `Entendido. Es una decisión sensible (${draft.summary}) y no puedo aplicarla sin la aprobación de una persona autorizada. Quedó registrada y es visible en el panel de aprobaciones.`;
}

export class ConversationPipeline {
  private readonly deps: PipelineDeps;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  /** Recibe un mensaje normalizado y produce el outcome enrutado (FLOW-001). */
  async ingest(input: IngestInput): Promise<IngestOutcome> {
    if (!input.tenantId || !input.actorId) {
      throw new Error('FAIL-CLOSED: conversation intake requires a resolved actor + tenant (RULE-001)');
    }
    if (!input.text || !input.text.trim()) {
      throw new Error('FAIL-CLOSED: empty message cannot be ingested');
    }

    // DEC-0005: reserva ATÓMICA de la cuota 'conversations' ANTES de procesar
    // (fail-closed 403 limit_exceeded / subscription_required; la ruta audita el
    // deny). La reserva se consume en la misma transacción que persiste la
    // solicitud; si el procesamiento falla antes, se devuelve (o vence sola).
    let reservation: QuotaReservationRow | null = null;
    if (this.deps.quota) {
      const claim = await this.deps.quota.reserve({
        tenantId: input.tenantId, capability: 'conversations', units: 1,
        idempotencyKey: input.idempotencyKey ?? input.requestId, requestId: input.requestId,
        actorId: input.actorId, actorRole: input.actorRole,
      });
      if (claim.kind === 'replay') return this.replay(input.tenantId, claim.reservation);
      reservation = claim.reservation;
    }
    try {
      return await this.process(input, reservation);
    } catch (err) {
      if (reservation) await this.deps.quota?.release(reservation, input.actorRole, 'not_persisted');
      throw err;
    }
  }

  /** Misma clave de idempotencia ya consumida: el resultado original, sin reprocesar. */
  private async replay(tenantId: string, reservation: QuotaReservationRow): Promise<IngestOutcome> {
    const found = await this.deps.repo.findRequestScoped(tenantId, resourceIdOf(reservation.resource_ref));
    if (!found.found || !found.in_tenant || !found.row) {
      throw new AppError(404, DENY_CODES.NOT_FOUND, 'La solicitud original ya no está disponible.');
    }
    const r = found.row;
    // capability_target se escribió desde una ClassificationResult (columna TEXT).
    const capabilityTarget = r.capability_target as CapabilityTarget;
    return {
      requestId: r.request_id, actionClass: r.action_class, intent: r.intent, capabilityTarget,
      requestStatus: r.status, responseText: r.response_message ?? '', proposalId: r.proposal_id ?? undefined, replayed: true,
    };
  }

  private async process(input: IngestInput, reservation: QuotaReservationRow | null): Promise<IngestOutcome> {
    const ids = newConversationIds();
    const { sink } = this.deps;

    // 1) Recibido (correlación con el request_id HTTP).
    await sink.write({
      tenant_id: input.tenantId, actor_id: input.actorId, actor_role: input.actorRole,
      action: 'conversation.received', resource: `channel:${input.channel}`,
      request_id: input.requestId, decision: 'allow', result: 'received',
    });

    // 2) Clasificación (AC-004/005, REQ-004). Sin Jev decide el determinista.
    const deterministic = classifyIntent(input.text);

    // 2b) APR-0002: en shadow decide el determinista y Jev queda como
    // evidencia; en primary con el gate abierto Jev determina la clasificación
    // (D1–D3). La fila de Jev se guarda solo si la solicitud quedó persistida.
    const jev = this.deps.jev
      ? await this.deps.jev.decide({ tenantId: input.tenantId, requestId: input.requestId, text: input.text, deterministic })
      : null;
    const classification = jev?.classification ?? deterministic;
    const auditTag = `;source=${jev?.source ?? 'deterministic'}${jev?.audit ?? ''}`;
    try {
      const outcome = await this.route(input, ids, classification, auditTag, reservation);
      jev?.commit();
      return outcome;
    } catch (err) {
      jev?.abandon();
      throw err;
    }
  }

  /** NFR-0001: la solicitud persistida y el consumo de su cuota (con su evento) van en la misma transacción. */
  private async consumeReservation(client: PoolClient, reservation: QuotaReservationRow | null, input: IngestInput): Promise<void> {
    if (reservation && this.deps.quota) {
      await this.deps.quota.commitInTx(client, reservation, `conversation_request/${input.requestId}`, input.actorRole);
    }
  }

  /** Audita la clasificación y enruta (respuesta, borrador, propuesta, escalamiento o bloqueo). */
  private async route(
    input: IngestInput,
    ids: ReturnType<typeof newConversationIds>,
    classification: ClassificationResult,
    auditTag: string,
    reservation: QuotaReservationRow | null,
  ): Promise<IngestOutcome> {
    const { sink } = this.deps;
    await sink.write({
      tenant_id: input.tenantId, actor_id: input.actorId, actor_role: input.actorRole,
      action: 'conversation.classified',
      resource: `request:${input.requestId}`,
      request_id: input.requestId,
      decision: classification.actionClass === 'prohibited' ? 'deny' : 'allow',
      result: `${classification.intent}:${classification.actionClass}${auditTag}`,
    });

    switch (classification.actionClass) {
      case 'prohibited': {
        return this.handleProhibited(input, input.requestId, classification, reservation);
      }
      case 'human_approval_required': {
        const draft: ProposalDraft = {
          proposalType: classification.proposalType ?? 'sensitive.business_decision',
          capabilityTarget: classification.capabilityTarget,
          actionClass: 'human_approval_required',
          summary: 'Es una decisión sensible que requiere aprobación humana explícita.',
          detail: { hints: classification.reason },
        };
        const outcome = await this.createProposal(input, ids, classification.intent, draft, { status: 'needs_approval', responseMessage: escalationText(draft), blocked: false }, reservation);
        await sink.write({
          tenant_id: input.tenantId, actor_id: input.actorId, actor_role: input.actorRole,
          action: 'conversation.proposal.created', resource: `action_proposal/${outcome.proposalId}`,
          request_id: input.requestId, decision: 'allow', result: 'human_approval_required',
        });
        return outcome;
      }
      case 'draft': {
        if (classification.intent === 'request.needs_clarification') {
          // Ambigüedad: sin efecto, pedir aclaración (FLOW-001 alternativa).
          const request = await this.persistRequest(input, input.requestId, classification, 'needs_clarification',
            'No entendí bien tu solicitud. Puedes pedirme por ejemplo: "cambia el teléfono", "agrega la sección servicios" o preguntarme por el horario de tu negocio.', reservation);
          return {
            requestId: request.request_id, actionClass: 'draft', intent: classification.intent,
            capabilityTarget: classification.capabilityTarget, requestStatus: 'needs_clarification',
            responseText: request.response_message ?? '',
          };
        }
        const draft: ProposalDraft = {
          proposalType: classification.proposalType ?? 'content.suggestion',
          capabilityTarget: 'website',
          actionClass: 'draft',
          summary: 'Propuesta borrador: sugerencia de contenido.', // TENTATIVA: sin generativo en esta tanda
          detail: { hints: classification.reason, suggestion: input.text },
        };
        const outcome = await this.createProposal(input, ids, classification.intent, draft, { status: 'classified', responseMessage: 'Aquí está mi propuesta (borrador): no se publica nada sin tu aprobación.' }, reservation);
        await sink.write({
          tenant_id: input.tenantId, actor_id: input.actorId, actor_role: input.actorRole,
          action: 'conversation.proposal.created', resource: `action_proposal/${outcome.proposalId}`,
          request_id: input.requestId, decision: 'allow', result: 'drafted',
        });
        return outcome;
      }
      case 'read_only': {
        // RULE-002: responde sin approval gate y sin efectos externos (AC-005).
        const answer = await buildReadOnlyAnswer(this.deps.websiteRepo, input.tenantId, classification, input.text);
        const request = await this.persistRequest(input, input.requestId, classification, 'answered', answer, reservation);
        await sink.write({
          tenant_id: input.tenantId, actor_id: input.actorId, actor_role: input.actorRole,
          action: 'conversation.answered', resource: `request:${request.request_id}`,
          request_id: input.requestId, decision: 'allow', result: 'answered',
        });
        return {
          requestId: request.request_id, actionClass: 'read_only', intent: classification.intent,
          capabilityTarget: classification.capabilityTarget, requestStatus: 'answered',
          responseText: answer,
        };
      }
      case 'preview_required': {
        // Cambio visible: edición asistida (INC-003) → propuesta + confirmación detallada (AC-006).
        const site = await this.deps.websiteRepo.websiteForTenant(input.tenantId);
        const current = site ? this.deps.websiteRepo.dataOf(site) : normalizeWebsiteData({});
        const edit = editWebsiteByInstruction(current, input.text);
        const draft: ProposalDraft = {
          proposalType: classification.proposalType ?? 'website.edit',
          capabilityTarget: 'website',
          actionClass: 'preview_required',
          summary: edit.sentences.join(' ') || 'Cambio visible en la página web.',
          detail: { after: edit.after, diff_sentences: edit.sentences, patches: edit.patches },
          patches: sentenceList(edit.patches),
        };
        const outcome = await this.createProposal(input, ids, classification.intent, draft, { status: 'awaiting_confirmation', responseMessage: confirmationText(draft), blocked: false }, reservation);
        await sink.write({
          tenant_id: input.tenantId, actor_id: input.actorId, actor_role: input.actorRole,
          action: 'conversation.proposal.created', resource: `action_proposal/${outcome.proposalId}`,
          request_id: input.requestId, decision: 'allow', result: 'awaiting_confirmation',
        });
        return outcome;
      }
      default: {
        // Fail-closed: clase desconocida nunca es default-allow.
        throw new Error(`FAIL-CLOSED: unknown action_class ${String(classification.actionClass)}`);
      }
    }
  }

  /** Persiste la solicitud y consume su cuota en UNA transacción (NFR-0001). */
  private async persistRequest(
    input: IngestInput,
    requestId: string,
    classification: ReturnType<typeof classifyIntent>,
    status: ConversationRequestRow['status'],
    responseMessage: string,
    reservation: QuotaReservationRow | null,
  ): Promise<ConversationRequestRow> {
    return runAtomic(this.deps.pool, async (client) => {
      const request = await this.deps.repo.createRequest({
        requestId,
        tenantId: input.tenantId,
        actorId: input.actorId,
        channel: input.channel,
        rawMessage: input.text,
        intent: classification.intent,
        capabilityTarget: classification.capabilityTarget,
        actionClass: classification.actionClass,
        status,
        responseMessage,
      }, client);
      await this.consumeReservation(client, reservation, input);
      return request;
    });
  }

  /** Bloqueo (prohibited): sin propuesta, sin efecto, con auditoría deny. */
  private async handleProhibited(
    input: IngestInput,
    requestId: string,
    classification: ReturnType<typeof classifyIntent>,
    reservation: QuotaReservationRow | null,
  ): Promise<IngestOutcome> {
    const responseText = classification.intent === 'capability.unsupported'
      ? 'Todavía no puedo hacer cambios en redes sociales o publicaciones. Puedo ayudarte con tu página web.'
      : 'No puedo inventar precios, descuentos ni condiciones comerciales. Esa información la define el equipo de MainSpot o tú mismo en el panel. La solicitud quedó registrada y bloqueada.';
    // El write de deny es fail-open (no debe cajear la respuesta del usuario);
    // pero en un sistema fail-closed la persistencia es confiable por diseño.
    const request = await this.persistRequest(input, requestId, {
      intent: classification.intent,
      actionClass: 'prohibited',
      capabilityTarget: classification.capabilityTarget,
      proposalType: null,
      confidence: 'high',
      reason: 'blocked_without_effect',
    }, 'blocked', responseText, reservation);
    await this.deps.sink.write({
      tenant_id: input.tenantId, actor_id: input.actorId, actor_role: input.actorRole,
      action: 'conversation.prohibited', resource: `request:${request.request_id}`,
      request_id: input.requestId, decision: 'deny', result: classification.intent === 'capability.unsupported' ? 'unsupported_capability' : 'prohibited',
    });
    log.warn('conversation.blocked', 'prohibited request blocked', {
      tenant_id: input.tenantId, intent: classification.intent, request_id: input.requestId,
    });
    return {
      requestId: request.request_id, actionClass: 'prohibited', intent: classification.intent,
      capabilityTarget: classification.capabilityTarget, requestStatus: 'blocked', responseText,
    };
  }

  /** Crea la propuesta (request + proposal atómicos) y responde. */
  private async createProposal(
    input: IngestInput,
    ids: ReturnType<typeof newConversationIds>,
    intent: string,
    draft: ProposalDraft,
    opts: { status: ConversationRequestRow['status']; responseMessage: string; blocked?: boolean },
    reservation: QuotaReservationRow | null,
  ): Promise<IngestOutcome> {
    const request = await runAtomic(this.deps.pool, async (client) => {
      const r = await this.deps.repo.createRequest({
        requestId: input.requestId,
        tenantId: input.tenantId,
        actorId: input.actorId,
        channel: input.channel,
        rawMessage: input.text,
        intent,
        capabilityTarget: draft.capabilityTarget,
        actionClass: draft.actionClass,
        status: opts.status,
        responseMessage: opts.responseMessage,
        proposalId: ids.proposalId,
      }, client);
      await this.deps.repo.createProposal({
        proposalId: ids.proposalId,
        tenantId: input.tenantId,
        requestId: input.requestId,
        capabilityTarget: draft.capabilityTarget,
        proposalType: draft.proposalType,
        actionClass: draft.actionClass,
        summary: draft.summary,
        detail: draft.detail,
        status: draft.actionClass === 'human_approval_required' ? 'drafted' : draft.actionClass === 'draft' ? 'drafted' : 'awaiting_confirmation',
        createdBy: input.actorId,
      }, client);
      await this.consumeReservation(client, reservation, input);
      return r;
    });

    return {
      requestId: request.request_id,
      actionClass: draft.actionClass,
      intent,
      capabilityTarget: draft.capabilityTarget,
      requestStatus: opts.status as IngestOutcome['requestStatus'],
      responseText: opts.responseMessage,
      proposalId: ids.proposalId,
    };
  }
}
