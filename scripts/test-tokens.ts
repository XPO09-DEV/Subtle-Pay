import { db, closeDb } from "../src/db.js";
import { generateAccountId, sha256Hex } from "../src/lib/crypto.js";
import { AppError } from "../src/lib/errors.js";
import {
  isSessionActive,
  issueSession,
  revokeSession,
  rotateSession,
  TokenReuseError,
  verifyAccessToken,
} from "../src/lib/tokens.js";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failed++;
};

async function expectCode(name: string, fn: () => unknown, code: string) {
  try {
    await fn();
    check(name, false);
  } catch (e) {
    check(name, e instanceof AppError && e.code === code);
  }
}

const userId = generateAccountId();
const now = Date.now();
db.prepare(
  "INSERT INTO users (id, password_hash, currency, created_at, updated_at) VALUES (?, 'x', 'USD', ?, ?)"
).run(userId, now, now);

try {
  // 1. Issue and verify
  const s1 = await issueSession(userId, { ip: "127.0.0.1", userAgent: "test" });
  const claims = await verifyAccessToken(s1.accessToken);
  check("access token verifies and carries the user id", claims.userId === userId);

  // 2. Tampering is rejected
  const tampered = s1.accessToken.slice(0, -2) + (s1.accessToken.endsWith("AA") ? "BB" : "AA");
  await expectCode("tampered access token rejected", () => verifyAccessToken(tampered), "UNAUTHORIZED");
  await expectCode("garbage access token rejected", () => verifyAccessToken("not.a.jwt"), "UNAUTHORIZED");

  // 3. Rotation
  const s2 = await rotateSession(s1.refreshToken);
  check("rotation returns a different refresh token", s2.refreshToken !== s1.refreshToken);
  check("rotation keeps the same session", s2.sessionId === s1.sessionId && s2.userId === userId);

  // 4. Immediate replay = harmless race, session survives
  await expectCode("immediate replay rejected", () => rotateSession(s1.refreshToken), "UNAUTHORIZED");
  check("session survives a client race", isSessionActive(s1.sessionId));

  // 5. Replay after the grace window = theft: whole session revoked
  db.prepare("UPDATE refresh_tokens SET used_at = used_at - 60000 WHERE token_hash = ?").run(
    sha256Hex(s1.refreshToken)
  );
  try {
    await rotateSession(s1.refreshToken);
    check("late replay detected as theft", false);
  } catch (e) {
    check("late replay detected as theft", e instanceof TokenReuseError);
  }
  check("theft revokes the whole session", !isSessionActive(s1.sessionId));
  await expectCode("newest refresh token dead after theft", () => rotateSession(s2.refreshToken), "UNAUTHORIZED");
  await expectCode("access token dead after theft", () => verifyAccessToken(s2.accessToken), "UNAUTHORIZED");

  // 6. Logout is immediate
  const s3 = await issueSession(userId);
  await verifyAccessToken(s3.accessToken);
  revokeSession(s3.sessionId);
  await expectCode("access token dead right after logout", () => verifyAccessToken(s3.accessToken), "UNAUTHORIZED");

  // 7. Malformed refresh tokens
  await expectCode("garbage refresh token rejected", () => rotateSession("nope"), "UNAUTHORIZED");
} finally {
  db.prepare("DELETE FROM users WHERE id = ?").run(userId); // cascades to its tokens
  closeDb();
}

console.log(failed === 0 ? "\nALL TOKEN TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);