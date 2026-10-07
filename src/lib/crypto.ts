import crypto from "node:crypto";

/* -------------------------------------------------------------------------- */
/*  Account IDs                                                               */
/*                                                                            */
/*  27 characters from a 32-character alphabet (no 0/O/1/I look-alikes).      */
/*  26 random characters (130 bits of entropy) + 1 check character that       */
/*  catches mistyped IDs before any database lookup.                          */
/* -------------------------------------------------------------------------- */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ACCOUNT_ID_LENGTH = 27;
const ID_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ2-9]{27}$/;

/**
 * Weighted checksum. Odd weights (2i+1) are invertible mod 32, so any single
 * mistyped character always changes the result.
 */
function checkChar(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    sum += ALPHABET.indexOf(body[i]) * (2 * i + 1);
  }
  return ALPHABET[sum % 32];
}

export function generateAccountId(): string {
  // 256 is a multiple of 32, so (byte & 31) is perfectly uniform: no modulo bias.
  const bytes = crypto.randomBytes(ACCOUNT_ID_LENGTH - 1);
  let body = "";
  for (const b of bytes) body += ALPHABET[b & 31];
  return body + checkChar(body);
}

/** Clean user input: trim, upper-case, drop spaces and dashes. */
export function normalizeAccountId(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, "");
}

export function isValidAccountId(id: string): boolean {
  if (!ID_PATTERN.test(id)) return false;
  return checkChar(id.slice(0, ACCOUNT_ID_LENGTH - 1)) === id[ACCOUNT_ID_LENGTH - 1];
}

/** Display form for the UI: XXXXXXXXX-XXXXXXXXX-XXXXXXXXX */
export function formatAccountId(id: string): string {
  return id.match(/.{1,9}/g)?.join("-") ?? id;
}

/* -------------------------------------------------------------------------- */
/*  Random values and hashing                                                 */
/* -------------------------------------------------------------------------- */

export function newId(): string {
  return crypto.randomUUID();
}

/** URL-safe random token (default 256 bits). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

/**
 * Constant-time string comparison. Both sides are hashed first, so the
 * comparison takes the same time no matter where (or whether) they differ,
 * and strings of different lengths are handled safely.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* -------------------------------------------------------------------------- */
/*  Canonical JSON: same data always gives the same string (and hash)         */
/* -------------------------------------------------------------------------- */

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}