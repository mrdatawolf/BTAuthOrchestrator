// CONTRACT-005 §3: an in-memory, single-process counter of failed
// /auth/local-login attempts per source IP over a rolling window — same
// class of mechanism, and same accepted "resets on restart" tradeoff, as
// CONTRACT-001's in-memory OIDC handshake store (src/oidc.ts's
// createHandshakeStore). A secondary defense against spraying across many
// usernames from one source, which per-account lockout alone does not stop.

export interface IpThrottle {
  /** True if sourceIp has reached maxAttempts failures within the rolling window, as of `now`. */
  isThrottled(sourceIp: string, now: number): boolean;
  /** Records one failed /auth/local-login attempt from sourceIp at `now`. */
  recordFailure(sourceIp: string, now: number): void;
}

export function createIpThrottle(maxAttempts: number, windowMs: number): IpThrottle {
  const failureTimestampsByIp = new Map<string, number[]>();

  function pruneAndGet(sourceIp: string, now: number): number[] {
    const existing = failureTimestampsByIp.get(sourceIp);
    if (existing === undefined) return [];
    const pruned = existing.filter((timestamp) => now - timestamp < windowMs);
    if (pruned.length === 0) {
      failureTimestampsByIp.delete(sourceIp);
    } else if (pruned.length !== existing.length) {
      failureTimestampsByIp.set(sourceIp, pruned);
    }
    return pruned;
  }

  return {
    isThrottled(sourceIp, now) {
      return pruneAndGet(sourceIp, now).length >= maxAttempts;
    },
    recordFailure(sourceIp, now) {
      const pruned = pruneAndGet(sourceIp, now);
      pruned.push(now);
      failureTimestampsByIp.set(sourceIp, pruned);
    },
  };
}
