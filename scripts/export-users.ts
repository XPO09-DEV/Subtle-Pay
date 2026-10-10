#!/usr/bin/env node
/**
 * Export non-sensitive user login details to Excel.
 * Never includes password_hash, mpin_hash, private keys, or tokens.
 *
 * Usage: npx tsx scripts/export-users.ts
 */
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";

const db = new Database(config.DB_PATH, { readonly: true });

const rows = db
  .prepare(
    `SELECT u.id, u.currency, u.failed_attempts, u.locked_until, u.created_at, u.updated_at,
            a.alias, w.address
     FROM users u
     LEFT JOIN aliases a ON a.user_id = u.id
     LEFT JOIN wallets w ON w.user_id = u.id
     ORDER BY u.created_at`
  )
  .all() as {
  id: string;
  currency: string;
  failed_attempts: number;
  locked_until: number | null;
  created_at: number;
  updated_at: number;
  alias: string | null;
  address: string | null;
}[];

function iso(ms: number | null) {
  if (!ms) return "";
  return new Date(ms).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

// Minimal CSV fallback if openpyxl isn't available in this process.
// Prefer the Python/openpyxl artifact for formatted Excel; this script emits CSV
// that Excel opens cleanly, plus a note.
const header = [
  "Account ID",
  "Alias",
  "Currency",
  "Wallet Address",
  "Created At",
  "Updated At",
  "Failed Login Attempts",
  "Locked Until",
];

const lines = [header.join(",")];
for (const r of rows) {
  const vals = [
    r.id,
    r.alias ?? "",
    r.currency,
    r.address ?? "",
    iso(r.created_at),
    iso(r.updated_at),
    String(r.failed_attempts ?? 0),
    iso(r.locked_until),
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
  lines.push(vals.join(","));
}

const out = path.resolve("data/users-export.csv");
writeFileSync(out, lines.join("\n") + "\n");
console.log(`Exported ${rows.length} users (no credentials) → ${out}`);
db.close();
