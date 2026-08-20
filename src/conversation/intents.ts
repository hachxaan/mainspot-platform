/**
 * Conversation domain types (INC-002). Canonical anchors: CAP-005, CAP-008,
 * FLOW-001/002/003, matriz de autonomía (05-GOVERNANCE-SECURITY).
 */

export type ActionClass =
  | 'read_only'
  | 'draft'
  | 'preview_required'
  | 'human_approval_required'
  | 'prohibited';

export type CapabilityTarget = 'website' | 'social' | 'domain' | 'unknown';

export type ProposalStatus =
  | 'drafted'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'preview_ready'
  | 'approved_for_publish'
  | 'published'
  | 'rejected'
  | 'expired'
  | 'failed';

export type RequestStatus =
  | 'received'
  | 'classified'
  | 'answered'
  | 'awaiting_confirmation'
  | 'needs_approval'
  | 'blocked'
  | 'needs_clarification';

export interface ClassificationResult {
  intent: string;                 // p.ej. 'website.update_contact', 'query.schedule'
  actionClass: ActionClass;
  capabilityTarget: CapabilityTarget;
  proposalType: string | null;    // solo cuando genera propuesta
  confidence: 'high' | 'medium' | 'low'; // TENTATIVA: determinista por reglas
  reason: string;                 // motivo legible para auditoría (sin texto crudo del usuario)
}

/** Diff conceptual en lenguaje claro (AC-006). */
export interface PatchSentence {
  field: string;                  // 'contact.phone', 'site.name', 'section.add', ...
  kind: 'change' | 'add' | 'remove';
  sentence: string;               // español llano, legible por el usuario
}

export interface ProposalDraft {
  proposalType: string;
  capabilityTarget: CapabilityTarget;
  actionClass: Extract<ActionClass, 'draft' | 'preview_required' | 'human_approval_required'>;
  summary: string;                // diff conceptual (AC-006)
  detail: Record<string, unknown>;
  patches?: PatchSentence[];
}

export interface IngestOutcome {
  requestId: string;
  actionClass: ActionClass;
  intent: string;
  capabilityTarget: CapabilityTarget;
  responseText: string;           // mensaje que el canal envía al usuario
  proposalId?: string;
  previewUrl?: string;
  requestStatus: RequestStatus;
}
