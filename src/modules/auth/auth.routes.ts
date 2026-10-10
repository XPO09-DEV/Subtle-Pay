import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { changePassword, getMe, login, register, setCurrency, setMpin, changeMpin, banUser, unbanUser } from "./auth.service.js";
import {
  generateChallenge,
  saveCredential,
  verifyBiometricAssertion,
  hasBiometric,
  listCredentials,
} from "./webauthn.service.js";
import { getHome } from "./home.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { revokeSession, rotateSession, TokenReuseError } from "../../lib/tokens.js";
import { audit } from "../../lib/audit.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { config } from "../../config.js";

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
const mpinBody = z.object({ mpin: z.string().min(4).max(6) });
const changeMpinBody = z.object({
  oldMpin: z.string().min(4).max(6),
  newMpin: z.string().min(4).max(6),
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
      if (err instanceof TokenReuseError) {
        // Refresh-token reuse is a strong signal of token theft / impersonation.
        audit(err.userId, "auth.token_reused", undefined, req.ip);
        banUser(err.userId, "Token reuse detected — possible impersonation", "system");
      }
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

  app.post("/auth/set-mpin", { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const body = mpinBody.parse(req.body);
    return setMpin(user.id, body.mpin, req.ip);
  });

  app.post("/auth/change-mpin", { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const body = changeMpinBody.parse(req.body);
    return changeMpin(user.id, body.oldMpin, body.newMpin, req.ip);
  });

  // Biometric (WebAuthn / platform authenticator: face or fingerprint)
  app.post("/auth/biometric/register/options", { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const challenge = generateChallenge(user.id);
    return { challenge, userId: user.id };
  });

  app.post("/auth/biometric/register/verify", { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const body = z.object({
      credentialId: z.string().min(10),
      publicKey: z.string().min(10),
      transports: z.string().optional(),
    }).parse(req.body);
    return saveCredential(user.id, body.credentialId, body.publicKey, body.transports);
  });

  app.post("/auth/biometric/auth/options", { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    if (!hasBiometric(user.id)) throw badRequest("No biometric registered");
    const challenge = generateChallenge(user.id);
    const creds = listCredentials(user.id);
    return { challenge, credentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports })) };
  });

  app.get("/auth/biometric/status", { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    return { hasBiometric: hasBiometric(user.id) };
  });

  app.get("/me", { preHandler: requireAuth }, async (req) => getMe(currentUser(req).id));

  app.get("/home", { preHandler: requireAuth }, async (req) => getHome(currentUser(req).id));

  // Operator-only: ban a user attempting to impersonate a legit token (or any abuse)
  app.post("/admin/ban", async (req) => {
    const key = req.headers["x-operator-key"];
    if (!config.OPERATOR_BAN_KEY || key !== config.OPERATOR_BAN_KEY) {
      throw unauthorized("Invalid operator key");
    }
    const body = z.object({
      accountId: z.string().min(10).max(40),
      reason: z.string().min(1).max(200).default("Impersonation of legitimate token"),
    }).parse(req.body);
    return banUser(body.accountId, body.reason, "operator");
  });

  app.post("/admin/unban", async (req) => {
    const key = req.headers["x-operator-key"];
    if (!config.OPERATOR_BAN_KEY || key !== config.OPERATOR_BAN_KEY) {
      throw unauthorized("Invalid operator key");
    }
    const body = z.object({ accountId: z.string().min(10).max(40) }).parse(req.body);
    return unbanUser(body.accountId, "operator");
  });

  app.put("/me/currency", { preHandler: requireAuth }, async (req) => {
    const body = currencyBody.parse(req.body);
    return setCurrency(currentUser(req).id, body.currency);
  });
}
