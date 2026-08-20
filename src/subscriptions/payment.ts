/**
 * PaymentProvider — interfaz ABSTRACT de pago (INC-006, CAP-012, DEC-024).
 *
 * DEC-024: el piloto NO cobra y NO usa procesador de pagos. Esta interfaz es
 * el esqueleto futuro; SimulatedPaymentProvider siempre responde ok y NO hace
 * llamadas externas. 'stripe' queda como nombre TENTATIVA (requiere credenciales
 * y decisión comercial Q-004).
 */

import { createHash } from 'node:crypto';

export interface PaymentInput {
  tenantId: string;
  subscriptionId: string;
  amountCents: number;
  currency: string;
}

export interface PaymentResult {
  ok: boolean;
  external_ref: string;
  error?: string;
  /** true cuando el pago es simulado (piloto sin cobro, DEC-024). */
  simulated: boolean;
}

export interface PaymentProvider {
  readonly provider: 'simulated' | 'stripe';
  charge(input: PaymentInput): Promise<PaymentResult>;
}

/** Proveedor simulado: SIEMPRE ok, sin efecto externo (DEC-024). */
export class SimulatedPaymentProvider implements PaymentProvider {
  readonly provider = 'simulated' as const;

  async charge(input: PaymentInput): Promise<PaymentResult> {
    const hash = createHash('sha256').update(`${input.subscriptionId}:${input.amountCents}`).digest('hex').slice(0, 16);
    return { ok: true, external_ref: `sim_pay:${hash}`, simulated: true };
  }
}
