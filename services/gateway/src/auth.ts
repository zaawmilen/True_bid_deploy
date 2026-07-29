// auth.ts
// Simulates the hand-off TrueBid would get from the real auction
// platform's existing session layer (see bid-stream-consumer's header
// comment - it already simulates that platform's bid feed; this module
// simulates its auth). /auth/login is a stand-in for "the real platform
// already authenticated this bidder and is vouching for them" - it is
// NOT a real login system (no password check, no user store). That's an
// intentional, documented simplification for a demo, not an oversight.

import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

export interface BidderClaims {
  bidder_id: string;
}

// Loud, obviously-fake marker string. If this literal value is ever seen
// in a production environment, assertAuthConfigSafe() below refuses to
// start rather than silently signing tokens anyone could forge by
// reading this file on GitHub.
export const INSECURE_DEFAULT_SECRET = 'truebid-local-dev-insecure-secret-change-me';

function getJwtSecret(): string {
  return process.env.JWT_SECRET ?? INSECURE_DEFAULT_SECRET;
}

export function getTokenTtl(): string {
  return process.env.JWT_EXPIRY ?? '2h';
}

const ISSUER = 'truebid-auth-simulator';

/**
 * Fail-fast config check, meant to be called from the gateway's existing
 * config.ts validation step (see TESTING.md's "fail loudly via
 * logger.fatal(...) + process.exit(1)" pattern already used for
 * DATABASE_URL). Throws if running in production without a real secret
 * configured - mirrors the existing fail-fast philosophy rather than
 * introducing a new one.
 */
export function assertAuthConfigSafe(nodeEnv: string | undefined): void {
  const secret = getJwtSecret();
  if (nodeEnv === 'production' && secret === INSECURE_DEFAULT_SECRET) {
    throw new Error(
      'JWT_SECRET is unset (or still the insecure demo default) while NODE_ENV=production. ' +
        'Refusing to start - set a real JWT_SECRET before deploying.'
    );
  }
}

/** Issues a token asserting the given bidder's identity. */
export function signBidderToken(bidderId: string): string {
  if (!bidderId || typeof bidderId !== 'string') {
    throw new Error('signBidderToken requires a non-empty bidder_id string');
  }
  return jwt.sign({ bidder_id: bidderId }, getJwtSecret(), {
    expiresIn: getTokenTtl(),
    issuer: ISSUER,
    subject: bidderId,
  } as jwt.SignOptions);
}

export type VerifyResult =
  | { ok: true; claims: BidderClaims }
  | { ok: false; reason: 'expired' | 'invalid' | 'missing' };

/** Verifies a token. Never throws - callers branch on `ok`. */
export function verifyToken(token: string | undefined | null): VerifyResult {
  if (!token) return { ok: false, reason: 'missing' };
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { issuer: ISSUER }) as JwtPayload;
    if (!decoded.bidder_id || typeof decoded.bidder_id !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, claims: { bidder_id: decoded.bidder_id } };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      bidder?: BidderClaims;
    }
  }
}

/** Express middleware: requires `Authorization: Bearer <token>`. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  const result = verifyToken(token);
  if (!result.ok) {
    res.status(401).json({ error: 'unauthorized', reason: result.reason });
    return;
  }
  req.bidder = result.claims;
  next();
}

/**
 * Extracts a token from a WebSocket upgrade request URL. Browsers can't
 * set custom headers during a WS handshake, so the token travels as a
 * query param: /ws/LOT-1001?token=<jwt>. Called from the gateway's `ws`
 * upgrade handler before accepting the connection.
 */
export function extractWsToken(requestUrl: string | undefined): string | undefined {
  if (!requestUrl) return undefined;
  try {
    const url = new URL(requestUrl, 'http://internal');
    return url.searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}
