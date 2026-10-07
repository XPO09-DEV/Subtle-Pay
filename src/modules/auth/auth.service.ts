import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { db, withTransaction, type UserRow } from "../../db.js";
import { generateAccountId, isValidAccountId, normalizeAccountId } from "../../lib/crypto.js";
import {
  assertNotLocked,
  hashPassword,
  needsRehash,
  recordLoginFailure,
  recordLoginSuccess,
  validatePasswordPolicy,
  verifyPassword,
  verifyPasswordDummy,
} from "../../lib/password.js";
import { issueSession, revokeAllSessions, type SessionMeta } from "../../lib/tokens.js";
import { encryptSecret, zeroize } from "../../lib/kms.js";
import { badRequest, invalidCredentials } from "../../lib/errors.js";
import { assertCurrency, type Currency } from "../../lib/currency.js";
import { audit } from "../../lib/audit.js";

/** One custodial wallet per account. The raw key is wiped before this returns. */
function createWallet(userId: string): string {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const secret = Buffer.from(privateKey.slice(2), "hex");
  try {
    const blob = encryptSecret(secret, { userId, address: account.address });
    db.prepare(
      `INSERT INTO wallets (user_id, address, enc_priv_key, kek_version, created_at)
       VALUES (?, ?, ?, 1, ?)`
    ).run(userId, account.address, blob, Date.now());
    return account.address;
  } finally {
    zeroize(secret);
  }
}

export async function register(password: string, meta: SessionMeta) {
  validatePasswordPolicy(password);
  const accountId = generateAccountId();
  const passwordHash = await hashPassword(password);
  const now = Date.now();

  const address = withTransaction(() => {
    db.prepare(
      `INSERT INTO users (id, password_hash, currency, created_at, updated_at)
       VALUES (?, ?, 'USD', ?, ?)`
    ).run(accountId, passwordHash, now, now);
    return createWallet(accountId);
  });

  const session = await issueSession(accountId, meta);
  audit(accountId, "auth.register", undefined, meta.ip);

  return {
    accountId,
    token: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.accessTokenExpiresIn,
    address,
  };
}

export async function login(accountIdRaw: string, password: string, meta: SessionMeta) {
  const accountId = normalizeAccountId(accountIdRaw);
  if (!isValidAccountId(accountId)) {
    await verifyPasswordDummy(password);
    throw invalidCredentials();
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(accountId) as UserRow | undefined;
  if (!user) {
    await verifyPasswordDummy(password);
    throw invalidCredentials();
  }

  assertNotLocked(user.locked_until);
  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) {
    const failure = recordLoginFailure(user.id);
    audit(user.id, "auth.login_failed", { attempts: failure.attempts }, meta.ip);
    if (failure.lockedUntil) assertNotLocked(failure.lockedUntil);
    throw invalidCredentials();
  }

  recordLoginSuccess(user.id);
  if (await needsRehash(user.password_hash)) {
    const next = await hashPassword(password);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      next,
      Date.now(),
      user.id
    );
  }

  const session = await issueSession(user.id, meta);
  audit(user.id, "auth.login", undefined, meta.ip);
  return {
    token: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.accessTokenExpiresIn,
  };
}

export async function changePassword(
  userId: string,
  sessionId: string,
  oldPassword: string,
  newPassword: string,
  ip?: string
) {
  validatePasswordPolicy(newPassword, userId);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!user) throw invalidCredentials();
  const ok = await verifyPassword(user.password_hash, oldPassword);
  if (!ok) throw badRequest("Current password is wrong", "INVALID_CREDENTIALS");
  if (oldPassword === newPassword) throw badRequest("Choose a different password");

  const next = await hashPassword(newPassword);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
    next,
    Date.now(),
    userId
  );
  revokeAllSessions(userId, sessionId);
  audit(userId, "auth.password_changed", undefined, ip);
  return { ok: true };
}

export function getMe(userId: string) {
  const user = db.prepare("SELECT id, currency FROM users WHERE id = ?").get(userId) as
    | { id: string; currency: string }
    | undefined;
  if (!user) throw invalidCredentials();
  const alias = db.prepare("SELECT alias FROM aliases WHERE user_id = ?").get(userId) as
    | { alias: string }
    | undefined;
  return { accountId: user.id, alias: alias?.alias ?? null, currency: user.currency };
}

export function setCurrency(userId: string, currency: string): { currency: Currency } {
  const code = assertCurrency(currency);
  db.prepare("UPDATE users SET currency = ?, updated_at = ? WHERE id = ?").run(code, Date.now(), userId);
  return { currency: code };
}