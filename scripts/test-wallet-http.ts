/**
 * Slice 2. Server must already be running:
 *   npx tsx scripts/test-wallet-http.ts
 */
const BASE = process.env.API_BASE ?? "http://localhost:4000";

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${extra && !ok ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
};

async function req(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function errorCode(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    return (body as { error?: { code?: string } }).error?.code;
  }
  return undefined;
}

try {
  const created = await req("/auth/register", {
    method: "POST",
    body: JSON.stringify({ password: "correct-horse-battery" }),
  });
  const account = created.body as { token?: string; address?: string };
  check("register still works", created.status === 200 && typeof account.token === "string");
  const token = account.token ?? "";
  const auth = { authorization: `Bearer ${token}` };

  const wallet = await req("/wallet", { headers: auth });
  const walletBody = wallet.body as {
    address?: string;
    balanceToken?: string;
    balanceUsd?: string;
    balanceLocal?: string;
    currency?: string;
  };
  check("GET /wallet is 200", wallet.status === 200, `status ${wallet.status} ${errorCode(wallet.body) ?? ""}`);
  check("wallet address matches register", walletBody.address === account.address);
  check("wallet has token, usd, and local balances", Boolean(walletBody.balanceToken && walletBody.balanceUsd && walletBody.balanceLocal));

  const noAuth = await req("/wallet");
  check("GET /wallet without token is 401", noAuth.status === 401);

  const badAlias = await req("/alias", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ alias: "a" }),
  });
  check("short alias rejected", badAlias.status === 400);

  const alias = `ani${Date.now().toString(36)}`.slice(0, 12);
  const claimed = await req("/alias", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ alias: alias.toUpperCase() }),
  });
  check("alias claim stores lowercase", claimed.status === 200 && (claimed.body as { alias?: string }).alias === alias);

  const me = await req("/me", { headers: auth });
  check("GET /me shows the alias", (me.body as { alias?: string }).alias === alias);

  const resolved = await req(`/alias/${alias}`);
  check("public alias lookup returns the address", resolved.status === 200 && (resolved.body as { address?: string }).address === account.address);

  const missing = await req("/alias/no_such_name_zzz");
  check("unknown alias is 404", missing.status === 404 && errorCode(missing.body) === "ALIAS_NOT_FOUND");

  const other = await req("/auth/register", {
    method: "POST",
    body: JSON.stringify({ password: "correct-horse-battery" }),
  });
  const otherToken = (other.body as { token?: string }).token ?? "";
  const stolen = await req("/alias", {
    method: "POST",
    headers: { authorization: `Bearer ${otherToken}` },
    body: JSON.stringify({ alias }),
  });
  check("taken alias is 409", stolen.status === 409 && errorCode(stolen.body) === "ALIAS_TAKEN");

  const rates = await req("/rates?currency=INR");
  const ratesBody = rates.body as { tokenUsd?: number; usdLocal?: number; updatedAt?: string };
  check("GET /rates is 200", rates.status === 200, `status ${rates.status}`);
  check("rates include tokenUsd and usdLocal", typeof ratesBody.tokenUsd === "number" && typeof ratesBody.usdLocal === "number" && ratesBody.usdLocal > 1);
} catch (err) {
  check("server reachable on :4000", false, err instanceof Error ? err.message : String(err));
}

console.log(failed === 0 ? "\nALL WALLET TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
