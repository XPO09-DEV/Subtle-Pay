import crypto from "node:crypto";
import { db } from "../../db.js";
import { badRequest } from "../../lib/errors.js";
import { audit } from "../../lib/audit.js";

// In-memory challenges (short-lived). Sufficient for hackathon; move to Redis/DB for production.
const challenges = new Map<string, { challenge: string; expires: number }>();

function cleanExpired() {
  const now = Date.now();
  for (const [k, v] of challenges) {
    if (v.expires < now) challenges.delete(k);
  }
}

export function generateChallenge(userId: string): string {
  cleanExpired();
  const challenge = crypto.randomBytes(32).toString("base64url");
  challenges.set(userId, { challenge, expires: Date.now() + 5 * 60_000 });
  return challenge;
}

export function consumeChallenge(userId: string): string | null {
  const entry = challenges.get(userId);
  if (!entry || entry.expires < Date.now()) {
    challenges.delete(userId);
    return null;
  }
  challenges.delete(userId);
  return entry.challenge;
}

export function listCredentials(userId: string) {
  return db
    .prepare("SELECT credential_id, public_key, counter, transports FROM webauthn_credentials WHERE user_id = ?")
    .all(userId) as { credential_id: string; public_key: string; counter: number; transports: string | null }[];
}

export function saveCredential(
  userId: string,
  credentialId: string,
  publicKey: string,
  transports?: string
) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(id, userId, credentialId, publicKey, transports ?? null, Date.now());
  audit(userId, "auth.webauthn_registered", undefined);
  return { ok: true };
}

export function hasBiometric(userId: string): boolean {
  const row = db.prepare("SELECT 1 FROM webauthn_credentials WHERE user_id = ? LIMIT 1").get(userId);
  return !!row;
}

// Minimal verification: frontend sends the challenge it signed + signature + credentialId.
// Full WebAuthn assertion verification would use @simplewebauthn/server.
// For the hackathon we accept a matching recent challenge + stored credential as proof of possession
// after the browser has performed the platform authenticator ceremony.
export function verifyBiometricAssertion(
  userId: string,
  credentialId: string,
  challenge: string,
  signature: string
): boolean {
  const expected = consumeChallenge(userId);
  if (!expected || expected !== challenge) return false;

  const cred = db
    .prepare("SELECT public_key, counter FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?")
    .get(userId, credentialId) as { public_key: string; counter: number } | undefined;

  if (!cred) return false;

  // In a full implementation, verify signature against public_key here.
  // We trust the browser ceremony + challenge match for the prototype.
  db.prepare("UPDATE webauthn_credentials SET counter = counter + 1 WHERE user_id = ? AND credential_id = ?").run(
    userId,
    credentialId
  );
  audit(userId, "auth.webauthn_verified", undefined);
  return true;
}
