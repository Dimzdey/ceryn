import type { CanonicalId } from './token.js';

const INLINE_MEMBERSHIP_LIMIT = 8;

/** Ordered dependency trace with constant-time active-token membership. */
export class ResolutionPath {
  private readonly ordered: CanonicalId[];
  private active?: Set<CanonicalId>;

  constructor(tokens: readonly CanonicalId[] = []) {
    this.ordered = tokens.slice();
    if (tokens.length > INLINE_MEMBERSHIP_LIMIT) this.active = new Set(tokens);
  }

  get tokens(): readonly CanonicalId[] {
    return this.ordered;
  }

  get length(): number {
    return this.ordered.length;
  }

  has(token: CanonicalId): boolean {
    if (this.active) return this.active.has(token);
    return this.ordered.includes(token);
  }

  enter(token: CanonicalId): void {
    if (!this.tryEnter(token)) throw new Error(`ResolutionPath duplicate enter: ${token}`);
  }

  tryEnter(token: CanonicalId): boolean {
    if (this.has(token)) return false;
    this.ordered.push(token);
    if (this.active) this.active.add(token);
    else if (this.ordered.length > INLINE_MEMBERSHIP_LIMIT) this.active = new Set(this.ordered);
    return true;
  }

  leave(token: CanonicalId): void {
    if (this.ordered[this.ordered.length - 1] !== token) {
      throw new Error(`ResolutionPath leave order mismatch: ${token}`);
    }
    this.ordered.pop();
    this.active?.delete(token);
  }

  cycle(token: CanonicalId): CanonicalId[] {
    const start = this.ordered.indexOf(token);
    return start < 0 ? [token] : this.ordered.slice(start).concat(token);
  }

  fork(): ResolutionPath {
    return new ResolutionPath(this.ordered);
  }
}
