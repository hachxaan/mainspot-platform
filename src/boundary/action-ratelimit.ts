/**
 * ActionRateLimiter — rate limiting para aprobaciones sensibles (INC-002,
 * "rate limiting en endpoints de login y aprobación sensible").
 *
 * Política: N intentos por (ip + actor + recurso) en ventana deslizante →
 * bloqueo por lockMs. In-memory por instancia (análogo a LoginRateLimiter:
 * multi-instancia requiere store compartido antes de exponer).
 */

export interface ActionRateWindow {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

export class ActionRateLimiter {
  private readonly state = new Map<string, ActionRateWindow>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly lockMs: number;

  constructor(max: number, windowMs: number, lockMs: number) {
    this.max = max;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    if (max < 1 || windowMs < 1 || lockMs < 1) {
      throw new Error('action rate limiter config must be positive');
    }
  }

  private key(ip: string, actor: string, resource: string): string {
    return `${ip}|${actor.trim()}|${resource}`;
  }

  /** True si el intento puede continuar. */
  allow(ip: string, actor: string, resource: string): boolean {
    const k = this.key(ip, actor, resource);
    const now = Date.now();
    const w = this.state.get(k);
    if (!w) return true;
    if (w.lockedUntil > now) return false;
    if (now - w.firstAt > this.windowMs) {
      this.state.delete(k);
      return true;
    }
    return w.count < this.max;
  }

  recordAttempt(ip: string, actor: string, resource: string): void {
    const k = this.key(ip, actor, resource);
    const now = Date.now();
    const existing = this.state.get(k);
    if (!existing || now - existing.firstAt > this.windowMs) {
      this.state.set(k, { count: 1, firstAt: now, lockedUntil: 0 });
      return;
    }
    existing.count += 1;
    if (existing.count >= this.max) {
      existing.lockedUntil = now + this.lockMs;
    }
  }

  lockRemainingMs(ip: string, actor: string, resource: string): number {
    const w = this.state.get(this.key(ip, actor, resource));
    if (!w) return 0;
    return Math.max(0, w.lockedUntil - Date.now());
  }

  /** Tests: cantidad de claves rastreadas. */
  size(): number {
    return this.state.size;
  }

  reset(): void {
    this.state.clear();
  }
}
