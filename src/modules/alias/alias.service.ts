import { db } from "../../db.js";
import type { AliasRow } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";

const ALIAS_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set(["admin", "support", "subtle", "subtlepay", "monad", "system", "root"]);

export function normalizeAlias(input: string): string {
  return input.trim().toLowerCase().replace(/^@/, "").replace(/@monad$/, "");
}

export function toHandle(aliasOrId: string): string {
  return `${aliasOrId}@monad`;
}

export function claimAlias(userId: string, raw: string, ip?: string): { alias: string } {
  const alias = normalizeAlias(raw);
  if (!ALIAS_RE.test(alias) || RESERVED.has(alias)) {
    throw badRequest("Alias must be 3–20 letters, numbers or underscores");
  }

  const taken = db.prepare("SELECT user_id FROM aliases WHERE alias = ?").get(alias) as
    | { user_id: string }
    | undefined;
  if (taken && taken.user_id !== userId) {
    throw conflict("That name is already taken", "ALIAS_TAKEN");
  }

  const mine = db.prepare("SELECT alias FROM aliases WHERE user_id = ?").get(userId) as
    | { alias: string }
    | undefined;
  const now = Date.now();
  if (mine) {
    db.prepare("UPDATE aliases SET alias = ?, created_at = ? WHERE user_id = ?").run(alias, now, userId);
  } else {
    db.prepare("INSERT INTO aliases (alias, user_id, created_at) VALUES (?, ?, ?)").run(alias, userId, now);
  }
  audit(userId, "alias.claim", { alias }, ip);
  return { alias };
}

export function resolveAlias(name: string): { alias: string; address: string } {
  const alias = normalizeAlias(name);
  const row = db
    .prepare(
      `SELECT a.alias, w.address
         FROM aliases a
         JOIN wallets w ON w.user_id = a.user_id
        WHERE a.alias = ?`
    )
    .get(alias) as Pick<AliasRow, "alias"> & { address: string } | undefined;
  if (!row) throw notFound("No account uses that name", "ALIAS_NOT_FOUND");
  return { alias: row.alias, address: row.address };
}