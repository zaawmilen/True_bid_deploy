import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  signBidderToken,
  verifyToken,
  extractWsToken,
  assertAuthConfigSafe,
  INSECURE_DEFAULT_SECRET,
} from '../../src/auth.js';

describe('signBidderToken / verifyToken', () => {
  it('round-trips a valid bidder_id', () => {
    const token = signBidderToken('bidder-7');
    const result = verifyToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.bidder_id).toBe('bidder-7');
  });

  it('rejects a missing token', () => {
    const result = verifyToken(undefined);
    expect(result).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a tampered token (bad signature)', () => {
    const token = signBidderToken('bidder-7');
    const tampered = token.slice(0, -3) + 'xxx';
    const result = verifyToken(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('rejects an expired token', () => {
    // Sign directly with jsonwebtoken (bypassing our default TTL) so we
    // can construct an already-expired token deterministically.
    const expired = jwt.sign({ bidder_id: 'bidder-7' }, INSECURE_DEFAULT_SECRET, {
      issuer: 'truebid-auth-simulator',
      subject: 'bidder-7',
      expiresIn: -10, // expired 10 seconds ago
    });
    const result = verifyToken(expired);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ bidder_id: 'bidder-7' }, 'some-other-secret', {
      issuer: 'truebid-auth-simulator',
      subject: 'bidder-7',
      expiresIn: '2h',
    });
    const result = verifyToken(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('rejects a token with no issuer claim (wrong issuer)', () => {
    const wrongIssuer = jwt.sign({ bidder_id: 'bidder-7' }, INSECURE_DEFAULT_SECRET, {
      expiresIn: '2h',
    });
    const result = verifyToken(wrongIssuer);
    expect(result.ok).toBe(false);
  });

  it('rejects a well-formed token missing the bidder_id claim', () => {
    const noClaim = jwt.sign({ sub: 'someone' }, INSECURE_DEFAULT_SECRET, {
      issuer: 'truebid-auth-simulator',
      expiresIn: '2h',
    });
    const result = verifyToken(noClaim);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('throws on signBidderToken with an empty bidder_id', () => {
    expect(() => signBidderToken('')).toThrow();
  });
});

describe('extractWsToken', () => {
  it('reads the token query param', () => {
    expect(extractWsToken('/ws/LOT-1001?token=abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('returns undefined when there is no token param', () => {
    expect(extractWsToken('/ws/LOT-1001')).toBeUndefined();
  });

  it('returns undefined for a malformed URL', () => {
    expect(extractWsToken(undefined)).toBeUndefined();
  });
});

describe('assertAuthConfigSafe', () => {
  const originalSecret = process.env.JWT_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  it('throws when NODE_ENV=production and JWT_SECRET is unset', () => {
    delete process.env.JWT_SECRET;
    expect(() => assertAuthConfigSafe('production')).toThrow(/JWT_SECRET/);
  });

  it('does not throw when NODE_ENV=production and a real secret is set', () => {
    process.env.JWT_SECRET = 'a-real-production-secret';
    expect(() => assertAuthConfigSafe('production')).not.toThrow();
  });

  it('does not throw outside production even with the default secret', () => {
    delete process.env.JWT_SECRET;
    expect(() => assertAuthConfigSafe('development')).not.toThrow();
    expect(() => assertAuthConfigSafe(undefined)).not.toThrow();
  });
});
