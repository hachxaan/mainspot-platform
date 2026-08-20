/**
 * Minimal in-memory login rate limiter (IR-06).
 *
 * Policy: N failures per (IP + login) inside a sliding window → the key is
 * locked for lockMs (backoff). A successful login resets the key.
 * In-memory, per instance: sufficient for the single-instance pilot; document
 * that multi-instance deployments need a shared store before exposing login.
 */

export interface RateWindow {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

export class LoginRateLimiter {
  private readonly state = new Map<string, RateWindow>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly lockMs: number;

  constructor(max: number, windowMs: number, lockMs: number) {
    this.max = max;
    this.windowMs = windowMs;
    this.lockMs = lockMs;
    if (max < 1 || windowMs < 1 || lockMs < 1) {
      throw new Error('rate limiter config must be positive');
    }
  }

  private key(ip: string, login: string): string {
    return `${ip}:${login.trim().toLowerCase()}`;
  }

  /** Returns true when the attempt may proceed. */
  allow(ip: string, login: string): boolean {
    const k = this.key(ip, login);
    const now = Date.now();
    const w = this.state.get(k);
    if (!w) return true;
    if (w.lockedUntil > now) return false;
    // Window expired: reset.
    if (now - w.firstAt > this.windowMs) {
      this.state.delete(k);
      return true;
    }
    return w.count < this.max;
  }

  /** Record a failed attempt; locks the key once the max is reached. */
  recordFailure(ip: string, login: string): void {
    const k = this.key(ip, login);
    const now = Date.now();
    const existing = this.state.get(k);
    if (!existing || now - existing.firstAt > this.windowMs) {
      this.state.set(k, { count: 1, firstAt: now, lockedUntil: 0 });
      return;
    }
    const nextCount = existing.count + 1;
    existing.count = nextCount;
    if (nextCount >= this.max) {
      existing.lockedUntil = now + this.lockMs;
    }
  }

  /** Record a successful login: resets the key. */
  recordSuccess(ip: string, login: string): void {
    this.state.delete(this.key(ip, login));
  }

  /** Milliseconds remaining until the key is unlocked (0 = not locked). */
  lockRemainingMs(ip: string, login: string): number {
    const w = this.state.get(this.key(ip, login));
    if (!w) return 0;
    return Math.max(0, w.lockedUntil - Date.now());
  }

  /** For tests: current tracked keys. */
  size(): number {
    return this.state.size;
  }
}
