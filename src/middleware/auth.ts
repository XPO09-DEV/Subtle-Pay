import type { FastifyReply, FastifyRequest } from "fastify";
import { parseBearer, verifyAccessToken } from "../lib/tokens.js";
import { unauthorized, forbidden } from "../lib/errors.js";
import { db } from "../db.js";

export interface AuthUser {
  id: string;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = parseBearer(req.headers.authorization);
  if (!token) throw unauthorized("Invalid or missing token");
  const claims = await verifyAccessToken(token);

  const banned = db.prepare("SELECT banned_at FROM users WHERE id = ?").get(claims.userId) as
    | { banned_at: number | null }
    | undefined;
  if (banned?.banned_at) throw forbidden("This account has been banned", "ACCOUNT_BANNED");

  req.user = { id: claims.userId, sessionId: claims.sessionId };
}

export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}