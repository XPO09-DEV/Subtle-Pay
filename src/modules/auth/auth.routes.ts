import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { changePassword, getMe, login, register, setCurrency } from "./auth.service.js";
import { getHome } from "./home.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { revokeSession, rotateSession, TokenReuseError } from "../../lib/tokens.js";
import { audit } from "../../lib/audit.js";

const passwordSchema = z.string().min(1).max(128);
const registerBody = z.object({ password: passwordSchema });
const loginBody = z.object({
  accountId: z.string().min(10).max(40),
  password: passwordSchema,
});
const changeBody = z.object({
  oldPassword: passwordSchema,
  newPassword: passwordSchema,
});
const currencyBody = z.object({ currency: z.string().length(3) });
const refreshBody = z.object({ refreshToken: z.string().min(20).max(128) });

function meta(req: { ip: string; headers: { "user-agent"?: string | string[] } }) {
  const ua = req.headers["user-agent"];
  return { ip: req.ip, userAgent: Array.isArray(ua) ? ua[0] : ua };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (req) => {
    const body = registerBody.parse(req.body);
    return register(body.password, meta(req));
  });

  app.post("/auth/login", async (req) => {
    const body = loginBody.parse(req.body);
    return login(body.accountId, body.password, meta(req));
  });

  app.post("/auth/refresh", async (req) => {
    const body = refreshBody.parse(req.body);
    try {
      const next = await rotateSession(body.refreshToken, meta(req));
      return {
        token: next.accessToken,
        refreshToken: next.refreshToken,
        expiresIn: next.accessTokenExpiresIn,
      };
    } catch (err) {
      if (err instanceof TokenReuseError) audit(err.userId, "auth.token_reused", undefined, req.ip);
      throw err;
    }
  });

  app.post("/auth/logout", { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    revokeSession(user.sessionId);
    audit(user.id, "auth.logout", undefined, req.ip);
    return { ok: true };
  });

  app.post("/auth/change-password", { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const body = changeBody.parse(req.body);
    return changePassword(user.id, user.sessionId, body.oldPassword, body.newPassword, req.ip);
  });

  app.get("/me", { preHandler: requireAuth }, async (req) => getMe(currentUser(req).id));

  app.get("/home", { preHandler: requireAuth }, async (req) => getHome(currentUser(req).id));

  app.put("/me/currency", { preHandler: requireAuth }, async (req) => {
    const body = currencyBody.parse(req.body);
    return setCurrency(currentUser(req).id, body.currency);
  });
}
