import crypto from "node:crypto";
import { config } from "../config.js";

/* -------------------------------------------------------------------------- */
/*  Envelope encryption for custodial wallet keys                             */
/*                                                                            */
/*    plaintext secret --AES-256-GCM(DEK)--> ciphertext                       */
/*    DEK (random, per wallet) --AES-256-GCM(KEK)--> wrapped DEK              */
/*    KEK = HKDF(MASTER_KEY)  (lives behind the KmsProvider interface)        */
/*                                                                            */
/*  Every blob is cryptographically bound to its owner via GCM AAD, so a      */
/*  blob copied to another user/address fails authentication.                 */
/* -------------------------------------------------------------------------- */

const ALG = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16; // full 128-bit authentication tag
const KEY_BYTES = 32;
const FORMAT = "v1";
const MAX_BLOB_LENGTH = 2048;

/* ------------------------------- primitives -------------------------------- */

interface Sealed {
  iv: Buffer;
  tag: Buffer;
  data: Buffer;
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Sealed {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

function open(key: Buffer, sealed: Sealed, aad: Buffer): Buffer {
  // Enforce lengths so a truncated tag can never be accepted.
  if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) {
    throw new Error("Invalid ciphertext");
  }
  const decipher = crypto.createDecipheriv(ALG, key, sealed.iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.data), decipher.final()]);
}

/** Overwrite a buffer with zeros so secrets do not linger in memory. */
export function zeroize(...buffers: Array<Buffer | undefined>): void {
  for (const b of buffers) b?.fill(0);
}

/* ------------------------------ KMS interface ------------------------------ */

export interface WrappedKey extends Sealed {
  version: number; // which key-encryption key wrapped it
}

/**
 * Anything that can wrap and unwrap data keys. LocalKms (below) uses MASTER_KEY.
 * A production deployment can implement this against AWS KMS, GCP KMS or
 * HashiCorp Vault so the master key never exists in the app at all.
 */
export interface KmsProvider {
  readonly currentVersion: number;
  wrap(dataKey: Buffer, aad: Buffer): WrappedKey;
  unwrap(wrapped: WrappedKey, aad: Buffer): Buffer;
}

class LocalKms implements KmsProvider {
  private readonly kek: Buffer;

  constructor(
    masterKeyHex: string,
    public readonly currentVersion: number
  ) {
    const ikm = Buffer.from(masterKeyHex, "hex");
    // HKDF gives domain separation: the master key is never used directly, and
    // a different label would yield a completely unrelated key.
    this.kek = Buffer.from(
      crypto.hkdfSync(
        "sha256",
        ikm,
        Buffer.from("subtle-pay/kms/salt/v1"),
        Buffer.from(`subtle-pay/wallet-kek/v${currentVersion}`),
        KEY_BYTES
      )
    );
    zeroize(ikm);
  }

  private wrapAad(aad: Buffer, version: number): Buffer {
    return Buffer.concat([aad, Buffer.from(`|kek${version}`)]);
  }

  wrap(dataKey: Buffer, aad: Buffer): WrappedKey {
    return {
      version: this.currentVersion,
      ...seal(this.kek, dataKey, this.wrapAad(aad, this.currentVersion)),
    };
  }

  unwrap(wrapped: WrappedKey, aad: Buffer): Buffer {
    if (wrapped.version !== this.currentVersion) {
      throw new Error("Unknown key version");
    }
    return open(this.kek, wrapped, this.wrapAad(aad, wrapped.version));
  }
}

/** Keyring: add older versions here when the master key is rotated. */
const keyring = new Map<number, KmsProvider>([[1, new LocalKms(config.MASTER_KEY, 1)]]);
const CURRENT_VERSION = 1;

function providerFor(version: number): KmsProvider {
  const p = keyring.get(version);
  if (!p) throw new Error("Unknown key version");
  return p;
}

export const kms = {
  currentVersion: CURRENT_VERSION,
};

/* ------------------------------ public API -------------------------------- */

/** Who a secret belongs to. Mixed into the AAD, so blobs cannot be swapped. */
export interface SecretContext {
  userId: string;
  address: string;
}

function buildAad(ctx: SecretContext): Buffer {
  return Buffer.from(
    `subtle-pay|wallet|${FORMAT}|${ctx.userId}|${ctx.address.toLowerCase()}`
  );
}

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

function serialize(wrapped: WrappedKey, data: Sealed): string {
  return [
    FORMAT,
    String(wrapped.version),
    b64(wrapped.iv),
    b64(wrapped.tag),
    b64(wrapped.data),
    b64(data.iv),
    b64(data.tag),
    b64(data.data),
  ].join(".");
}

function parse(blob: string): { wrapped: WrappedKey; data: Sealed } {
  if (blob.length > MAX_BLOB_LENGTH) throw new Error("Invalid ciphertext");
  const p = blob.split(".");
  if (p.length !== 8 || p[0] !== FORMAT) throw new Error("Invalid ciphertext");
  const version = Number(p[1]);
  if (!Number.isInteger(version) || version < 1) throw new Error("Invalid ciphertext");
  return {
    wrapped: { version, iv: unb64(p[2]), tag: unb64(p[3]), data: unb64(p[4]) },
    data: { iv: unb64(p[5]), tag: unb64(p[6]), data: unb64(p[7]) },
  };
}

/**
 * Encrypt a secret (such as a wallet private key) for storage.
 * The caller should zeroize `secret` afterwards.
 */
export function encryptSecret(secret: Buffer, ctx: SecretContext): string {
  const aad = buildAad(ctx);
  const dek = crypto.randomBytes(KEY_BYTES);
  try {
    const data = seal(dek, secret, aad);
    const wrapped = providerFor(CURRENT_VERSION).wrap(dek, aad);
    return serialize(wrapped, data);
  } finally {
    zeroize(dek);
  }
}

/**
 * Decrypt a stored secret. The returned buffer MUST be zeroized by the caller;
 * prefer withDecryptedSecret(), which does that automatically.
 * Every failure gives the same generic error (no padding/oracle details leak).
 */
export function decryptSecret(blob: string, ctx: SecretContext): Buffer {
  let dek: Buffer | undefined;
  try {
    const aad = buildAad(ctx);
    const { wrapped, data } = parse(blob);
    dek = providerFor(wrapped.version).unwrap(wrapped, aad);
    return open(dek, data, aad);
  } catch {
    throw new Error("Failed to decrypt secret");
  } finally {
    zeroize(dek);
  }
}

/** Decrypt, run `fn`, and always wipe the plaintext afterwards. */
export async function withDecryptedSecret<T>(
  blob: string,
  ctx: SecretContext,
  fn: (secret: Buffer) => Promise<T> | T
): Promise<T> {
  const secret = decryptSecret(blob, ctx);
  try {
    return await fn(secret);
  } finally {
    zeroize(secret);
  }
}

/** True if the blob was wrapped by an older master-key version. */
export function needsRewrap(blob: string): boolean {
  return parse(blob).wrapped.version !== CURRENT_VERSION;
}

/**
 * Master-key rotation: re-wrap the data key under the newest KEK without ever
 * decrypting the wallet secret itself.
 */
export function rewrap(blob: string, ctx: SecretContext): string {
  let dek: Buffer | undefined;
  try {
    const aad = buildAad(ctx);
    const { wrapped, data } = parse(blob);
    dek = providerFor(wrapped.version).unwrap(wrapped, aad);
    return serialize(providerFor(CURRENT_VERSION).wrap(dek, aad), data);
  } catch {
    throw new Error("Failed to rewrap secret");
  } finally {
    zeroize(dek);
  }
}

/**
 * Startup self-test: proves the cipher works, that tampering is detected and
 * that a blob cannot be moved to another owner. Call once when the server boots.
 */
export function kmsSelfTest(): void {
  const ctx: SecretContext = {
    userId: "SELFTESTSELFTESTSELFTEST234",
    address: "0x0000000000000000000000000000000000000001",
  };
  const secret = crypto.randomBytes(32);
  const blob = encryptSecret(secret, ctx);

  const back = decryptSecret(blob, ctx);
  const roundTrip = back.equals(secret);
  zeroize(back);
  if (!roundTrip) throw new Error("KMS self-test failed: round trip");

  const mustFail = (fn: () => unknown, label: string) => {
    try {
      fn();
    } catch {
      return;
    }
    throw new Error(`KMS self-test failed: ${label}`);
  };

  mustFail(
    () => decryptSecret(blob, { ...ctx, userId: "OTHERUSEROTHERUSEROTHERUS23" }),
    "blob accepted for the wrong user"
  );
  const parts = blob.split(".");
  parts[7] = b64(crypto.randomBytes(32));
  mustFail(() => decryptSecret(parts.join("."), ctx), "tampered ciphertext accepted");

  zeroize(secret);
}