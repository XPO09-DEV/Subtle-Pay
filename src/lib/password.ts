import * as argon2 from "argon2";
import { config } from "../config.js";
import { db, withTransaction } from "../db.js";
import { randomToken } from "./crypto.js";
import { accountLocked, badRequest, tooManyRequests } from "./errors.js";

/* -------------------------------------------------------------------------- */
/*  Hashing parameters                                                        */
/*  argon2id, memory-hard, plus a secret pepper that lives only in the        */
/*  environment (never in the database).                                      */
/* -------------------------------------------------------------------------- */

const PEPPER = Buffer.from(config.PASSWORD_PEPPER, "hex");

const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: config.ARGON2_MEMORY_KIB,
  timeCost: config.ARGON2_TIME_COST,
  parallelism: config.ARGON2_PARALLELISM,
} as const;

/* -------------------------------------------------------------------------- */
/*  Concurrency gate                                                          */
/*  Each hash needs ~64 MiB of RAM. Limiting how many run at once (plus a     */
/*  bounded queue) stops a burst of login requests from exhausting memory.    */
/* -------------------------------------------------------------------------- */

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue: number
  ) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
    } else {
      if (this.queue.length >= this.maxQueue) {
        throw tooManyRequests(2, "Server is busy, please try again");
      }
      // The slot is handed over directly by release(), so `active` stays put.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    };
  }
}

const gate = new Semaphore(4, 64);

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  const release = await gate.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/* -------------------------------------------------------------------------- */
/*  Password policy                                                           */
/*  Length matters more than character-class rules (NIST SP 800-63B).         */
/* -------------------------------------------------------------------------- */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128; // upper bound keeps hashing cost predictable

const COMMON_PASSWORDS = new Set([
  "password1234",
  "password12345",
  "passwordpassword",
  "123456789012",
  "1234567890123",
  "12345678901234",
  "qwertyuiop12",
  "qwertyuiopas",
  "qwerty123456",
  "iloveyou1234",
  "letmein12345",
  "welcome12345",
  "administrator",
  "abcdefghijkl",
  "abc123456789",
  "monkey123456",
  "dragon123456",
  "football1234",
  "baseball1234",
  "trustno11234",
  "changeme1234",
  "subtlepay1234",
  "subtlepay12345",
  "cryptowallet",
  "bitcoin12345",
  "111111111111",
  "000000000000",
]);

/** Same normalisation everywhere, so "é" typed two ways hashes identically. */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

export function validatePasswordPolicy(password: unknown, accountId?: string): void {
  if (typeof password !== "string") {
    throw badRequest("Password is required", "VALIDATION_ERROR");
  }
  const normalized = normalizePassword(password);
  const chars = Array.from(normalized);

  if (chars.length < PASSWORD_MIN_LENGTH) {
    throw badRequest(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      "VALIDATION_ERROR"
    );
  }
  if (chars.length > PASSWORD_MAX_LENGTH || Buffer.byteLength(normalized) > 512) {
    throw badRequest(
      `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
      "VALIDATION_ERROR"
    );
  }
  if (new Set(chars).size < 5) {
    throw badRequest("Password is too repetitive", "VALIDATION_ERROR");
  }
  const lower = normalized.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    throw badRequest("Password is too common", "VALIDATION_ERROR");
  }
  if (accountId && lower.includes(accountId.toLowerCase())) {
    throw badRequest("Password must not contain your account ID", "VALIDATION_ERROR");
  }
}

/* -------------------------------------------------------------------------- */
/*  Hash / verify                                                             */
/* -------------------------------------------------------------------------- */

export async function hashPassword(password: string): Promise<string> {
  const normalized = normalizePassword(password);
  return limited(() => argon2.hash(normalized, { ...HASH_OPTIONS, secret: PEPPER }));
}

/** Returns false for a wrong password AND for a malformed stored hash. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const normalized = normalizePassword(password);
  try {
    return await limited(() => argon2.verify(hash, normalized, { secret: PEPPER }));
  } catch (err) {
    // Rethrow load-shedding errors; treat anything else as "does not match".
    if (err instanceof Error && err.name === "AppError") throw err;
    return false;
  }
}

/** True when the stored hash uses weaker parameters than the current config. */
export async function needsRehash(hash: string): Promise<boolean> {
  try {
    return await argon2.needsRehash(hash, HASH_OPTIONS);
  } catch {
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/*  Timing equalisation for unknown accounts                                  */
/*  Login for a non-existent ID still performs a full verification, so the    */
/*  response time does not reveal whether the ID exists.                      */
/* -------------------------------------------------------------------------- */

let dummyHash: string | undefined;

/** Call once at startup. Returns how long one hash takes (ms), for the log. */
export async function initPassword(): Promise<number> {
  const started = performance.now();
  dummyHash = await hashPassword(randomToken(24));
  return Math.round(performance.now() - started);
}

export async function verifyPasswordDummy(password: string): Promise<false> {
  if (!dummyHash) dummyHash = await hashPassword(randomToken(24));
  await verifyPassword(dummyHash, password);
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Lockout                                                                   */
/*  Progressive: LOGIN_LOCKOUT_MINUTES, then x2, x4, ... capped at 24 hours.  */
/*  Account IDs hold 130 bits of entropy, so nobody can lock out an account   */
/*  they do not already know the ID of.                                       */
/* -------------------------------------------------------------------------- */

const MAX_LOCKOUT_MINUTES = 24 * 60;

/** Throws a 429 if the account is currently locked. */
export function assertNotLocked(lockedUntil: number | null, now = Date.now()): void {
  if (lockedUntil !== null && lockedUntil > now) {
    throw accountLocked((lockedUntil - now) / 1000);
  }
}

export interface FailureResult {
  attempts: number;
  lockedUntil: number | null;
}

/** Count a failed login atomically and lock the account when the limit is hit. */
export function recordLoginFailure(userId: string): FailureResult {
  return withTransaction(() => {
    const now = Date.now();
    const row = db
      .prepare(
        `UPDATE users
            SET failed_attempts = failed_attempts + 1, updated_at = ?
          WHERE id = ?
      RETURNING failed_attempts`
      )
      .get(now, userId) as { failed_attempts: number } | undefined;

    if (!row) return { attempts: 0, lockedUntil: null };

    let lockedUntil: number | null = null;
    if (row.failed_attempts % config.LOGIN_MAX_FAILURES === 0) {
      const level = row.failed_attempts / config.LOGIN_MAX_FAILURES - 1;
      const minutes = Math.min(config.LOGIN_LOCKOUT_MINUTES * 2 ** level, MAX_LOCKOUT_MINUTES);
      lockedUntil = now + minutes * 60_000;
      db.prepare("UPDATE users SET locked_until = ? WHERE id = ?").run(lockedUntil, userId);
    }
    return { attempts: row.failed_attempts, lockedUntil };
  });
}

export function recordLoginSuccess(userId: string): void {
  db.prepare(
    `UPDATE users
        SET failed_attempts = 0, locked_until = NULL, updated_at = ?
      WHERE id = ?`
  ).run(Date.now(), userId);
}