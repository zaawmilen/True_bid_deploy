// authRoutes.ts
// A single demo endpoint: POST /auth/login { bidder_id } -> { token }.
// This stands in for the real auction platform's existing session layer
// vouching for a bidder - there is no password check and no user store
// by design (see auth.ts header comment). Wire into the gateway with:
//   app.post('/auth/login', loginHandler);

import type { Request, Response } from 'express';
import { signBidderToken, getTokenTtl } from './auth.js';

const BIDDER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function loginHandler(req: Request, res: Response): void {
  const bidderId = req.body?.bidder_id;
  if (typeof bidderId !== 'string' || !BIDDER_ID_PATTERN.test(bidderId)) {
    res.status(400).json({ error: 'bidder_id is required and must match ^[a-zA-Z0-9_-]{1,64}$' });
    return;
  }
  const token = signBidderToken(bidderId);
  res.status(200).json({ token, bidder_id: bidderId, expires_in: getTokenTtl() });
}
