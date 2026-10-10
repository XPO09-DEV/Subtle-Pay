import crypto from "node:crypto";
import { db, type UserRow } from "../../db.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { newId, sha256Hex } from "../../lib/crypto.js";
import { audit } from "../../lib/audit.js";
import { badRequest, unauthorized, notFound } from "../../lib/errors.js";
import { revokeAllSessions } from "../../lib/tokens.js";

const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

const EMBEDDED_ADMIN = { name: "ani12345", password: "xpo123456" };

export async function ensureBootstrapAdmin() {
  const existing = db.prepare("SELECT id FROM admins WHERE email = ?").get(EMBEDDED_ADMIN.name);
  if (existing) return;
  const id = newId();
  const hash = await hashPassword(EMBEDDED_ADMIN.password);
  db.prepare("INSERT INTO admins (id, email, password_hash, role, created_at) VALUES (?, ?, ?, 'super', ?)").run(
    id,
    EMBEDDED_ADMIN.name,
    hash,
    Date.now()
  );
  audit("system", "admin.bootstrap", { name: EMBEDDED_ADMIN.name });
}

export async function adminLogin(name: string, password: string, ip?: string) {
  const admin = db.prepare("SELECT * FROM admins WHERE email = ?").get(name.toLowerCase()) as
    | { id: string; email: string; password_hash: string; role: string }
    | undefined;
  if (!admin || !(await verifyPassword(admin.password_hash, password))) {
    throw unauthorized("Invalid admin credentials");
  }
  const raw = crypto.randomBytes(32).toString("base64url");
  const id = newId();
  db.prepare(
    "INSERT INTO admin_sessions (id, admin_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, admin.id, sha256Hex(raw), Date.now() + ADMIN_TTL_MS, Date.now());
  audit(admin.id, "admin.login", undefined, ip);
  return { token: raw, admin: { id: admin.id, email: admin.email, role: admin.role } };
}

export function adminFromToken(token: string) {
  const row = db
    .prepare(
      `SELECT s.id as session_id, s.expires_at, s.revoked_at, a.id, a.email, a.role
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.token_hash = ?`
    )
    .get(sha256Hex(token)) as
    | { session_id: string; expires_at: number; revoked_at: number | null; id: string; email: string; role: string }
    | undefined;
  if (!row || row.revoked_at || row.expires_at < Date.now()) throw unauthorized("Admin session invalid");
  return { id: row.id, email: row.email, role: row.role, sessionId: row.session_id };
}

export function adminLogout(sessionId: string) {
  db.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE id = ?").run(Date.now(), sessionId);
}

export function overview() {
  const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  const banned = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE banned_at IS NOT NULL").get() as { n: number }).n;
  const merchants = db
    .prepare("SELECT status, COUNT(*) AS n FROM merchant_verifications GROUP BY status")
    .all() as { status: string; n: number }[];
  const mandates = (db.prepare("SELECT COUNT(*) AS n FROM mandates WHERE status = 'active'").get() as { n: number }).n;
  const payments = (db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n;
  const pending = merchants.find((m) => m.status === "pending")?.n ?? 0;
  const verified = merchants.find((m) => m.status === "verified")?.n ?? 0;
  return {
    users,
    banned,
    pendingMerchants: pending,
    verifiedMerchants: verified,
    activeAutopay: mandates,
    payments,
    health: "ok",
    updatedAt: new Date().toISOString(),
  };
}

export function listUsers(q?: string, limit = 50, offset = 0) {
  const like = q ? `%${q.toLowerCase()}%` : "%";
  const rows = db
    .prepare(
      `SELECT u.id, u.currency, u.created_at, u.updated_at, u.banned_at, u.ban_reason,
              a.alias, w.address
       FROM users u
       LEFT JOIN aliases a ON a.user_id = u.id
       LEFT JOIN wallets w ON w.user_id = u.id
       WHERE u.id LIKE ? OR lower(coalesce(a.alias,'')) LIKE ? OR lower(coalesce(w.address,'')) LIKE ?
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(like, like, like, limit, offset) as Array<{
    id: string;
    currency: string;
    created_at: number;
    updated_at: number;
    banned_at: number | null;
    ban_reason: string | null;
    alias: string | null;
    address: string | null;
  }>;
  return rows.map((r) => ({
    accountId: r.id,
    alias: r.alias,
    currency: r.currency,
    address: r.address,
    banned: !!r.banned_at,
    banReason: r.ban_reason,
    createdAt: r.created_at,
  }));
}

export function userDetail(accountId: string) {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(accountId) as UserRow | undefined;
  if (!user) throw notFound("User not found");
  const alias = db.prepare("SELECT alias FROM aliases WHERE user_id = ?").get(accountId) as { alias: string } | undefined;
  const wallet = db.prepare("SELECT address FROM wallets WHERE user_id = ?").get(accountId) as { address: string } | undefined;
  const merchant = db
    .prepare("SELECT status, business_name, note FROM merchant_verifications WHERE user_id = ?")
    .get(accountId) as { status: string; business_name: string; note: string | null } | undefined;
  const payments = db
    .prepare("SELECT id, amount_micro, status, created_at FROM transactions WHERE from_user = ? ORDER BY created_at DESC LIMIT 20")
    .all(accountId);
  return {
    accountId: user.id,
    currency: user.currency,
    alias: alias?.alias ?? null,
    address: wallet?.address ?? null,
    banned: !!user.banned_at,
    banReason: user.ban_reason,
    bannedAt: user.banned_at,
    merchant,
    recentPayments: payments,
    createdAt: user.created_at,
  };
}

export function banUser(adminId: string, accountId: string, reason: string, ip?: string) {
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(accountId);
  if (!user) throw notFound("User not found");
  if (!reason.trim()) throw badRequest("Reason required");
  const now = Date.now();
  db.prepare("UPDATE users SET banned_at = ?, ban_reason = ?, updated_at = ? WHERE id = ?").run(now, reason.slice(0, 200), now, accountId);
  revokeAllSessions(accountId);
  audit(adminId, "admin.user_banned", { target: accountId, reason }, ip);
  return { ok: true, accountId, banned: true };
}

export function unbanUser(adminId: string, accountId: string, ip?: string) {
  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(accountId);
  if (!user) throw notFound("User not found");
  db.prepare("UPDATE users SET banned_at = NULL, ban_reason = NULL, updated_at = ? WHERE id = ?").run(Date.now(), accountId);
  audit(adminId, "admin.user_unbanned", { target: accountId }, ip);
  return { ok: true, accountId, banned: false };
}

export function listMerchants(status?: string) {
  const rows = status
    ? db.prepare("SELECT * FROM merchant_verifications WHERE status = ? ORDER BY requested_at DESC").all(status)
    : db.prepare("SELECT * FROM merchant_verifications ORDER BY requested_at DESC").all();
  return rows;
}

export function reviewMerchant(adminId: string, accountId: string, approve: boolean, note?: string, ip?: string) {
  const row = db.prepare("SELECT user_id FROM merchant_verifications WHERE user_id = ?").get(accountId);
  if (!row) throw notFound("No verification request");
  const status = approve ? "verified" : "rejected";
  db.prepare("UPDATE merchant_verifications SET status = ?, note = ?, reviewed_at = ? WHERE user_id = ?").run(
    status,
    note ?? null,
    Date.now(),
    accountId
  );
  audit(adminId, "admin.merchant_reviewed", { target: accountId, status }, ip);
  return { ok: true, accountId, status };
}

export function listMandates() {
  return db
    .prepare(
      `SELECT m.id, m.user_id, m.merchant_id, m.cap_micro, m.currency, m.interval_days, m.status, m.created_at,
              ua.alias AS user_alias, ma.alias AS merchant_alias
       FROM mandates m
       LEFT JOIN aliases ua ON ua.user_id = m.user_id
       LEFT JOIN aliases ma ON ma.user_id = m.merchant_id
       ORDER BY m.created_at DESC LIMIT 200`
    )
    .all();
}

export function revokeMandate(adminId: string, id: string, ip?: string) {
  const row = db.prepare("SELECT id FROM mandates WHERE id = ?").get(id);
  if (!row) throw notFound("Mandate not found");
  db.prepare("UPDATE mandates SET status = 'revoked' WHERE id = ?").run(id);
  audit(adminId, "admin.mandate_revoked", { id }, ip);
  return { ok: true, id, status: "revoked" };
}

export function listAudit(limit = 100, offset = 0, action?: string) {
  if (action) {
    return db
      .prepare("SELECT seq, ts, actor, action, details, ip FROM audit_log WHERE action LIKE ? ORDER BY seq DESC LIMIT ? OFFSET ?")
      .all(`%${action}%`, limit, offset);
  }
  return db.prepare("SELECT seq, ts, actor, action, details, ip FROM audit_log ORDER BY seq DESC LIMIT ? OFFSET ?").all(limit, offset);
}

const SAFE_TABLES = ["users", "aliases", "wallets", "transactions", "withdrawals", "bills", "mandates", "merchant_verifications", "audit_log"] as const;
const REDACT = new Set(["password_hash", "mpin_hash", "enc_priv_key", "token_hash"]);

export function listTables() {
  return SAFE_TABLES;
}

export function tableRows(table: string, limit = 50, offset = 0) {
  if (!SAFE_TABLES.includes(table as (typeof SAFE_TABLES)[number])) throw badRequest("Table not allowed");
  const rows = db.prepare(`SELECT * FROM ${table} LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[];
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k] = REDACT.has(k) ? "[redacted]" : v;
    }
    return out;
  });
}
