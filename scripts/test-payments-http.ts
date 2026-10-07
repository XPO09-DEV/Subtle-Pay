/**
 * Slice 3. Restart the server first, then:
 *   npx tsx scripts/test-payments-http.ts
 * An unfunded wallet must fail the send with INSUFFICIENT_FUNDS. That is a pass.
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

async function register(alias: string) {
  const created = await req("/auth/register", {
    method: "POST",
    body: JSON.stringify({ password: "correct-horse-battery" }),
  });
  const body = created.body as { token?: string; address?: string };
  const token = body.token ?? "";
  await req("/alias", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ alias }),
  });
  return { token, address: body.address ?? "" };
}

try {
  const sender = await register(`from${Date.now().toString(36)}`.slice(0, 12));
  const receiver = await register(`to${Date.now().toString(36)}`.slice(0, 12));
  check("two accounts registered", Boolean(sender.token && receiver.token));
  const auth = { authorization: `Bearer ${sender.token}` };

  const self = await req("/payments/send", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ to: sender.address, amount: "1", amountCurrency: "USD" }),
  });
  check("self payment rejected", self.status === 422 && errorCode(self.body) === "SELF_PAYMENT");

  const tiny = await req("/payments/send", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ to: receiver.address, amount: "0", amountCurrency: "USD" }),
  });
  check("zero amount rejected", tiny.status === 400);

  const missing = await req("/payments/send", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ to: "no_such_alias", amount: "1", amountCurrency: "USD" }),
  });
  check("unknown alias is 404", missing.status === 404 && errorCode(missing.body) === "ALIAS_NOT_FOUND");

  const send = await req("/payments/send", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ to: receiver.address, amount: "1.00", amountCurrency: "USD" }),
  });
  const unfunded = send.status === 422 && errorCode(send.body) === "INSUFFICIENT_FUNDS";
  const sent = send.status === 200 && typeof (send.body as { txId?: string }).txId === "string";
  check("send is insufficient funds or a real tx", unfunded || sent, `status ${send.status} ${errorCode(send.body) ?? ""}`);

  const history = await req("/payments", { headers: auth });
  check("GET /payments is a list", history.status === 200 && Array.isArray(history.body));

  const withdraw = await req("/withdraw", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ amount: "10", currency: "INR" }),
  });
  const withdrawBody = withdraw.body as { withdrawalId?: string; status?: string; payoutLocal?: string };
  check("mock withdraw completes", withdraw.status === 200 && withdrawBody.status === "completed" && Boolean(withdrawBody.payoutLocal));
} catch (err) {
  check("server reachable on :4000", false, err instanceof Error ? err.message : String(err));
}

console.log(failed === 0 ? "\nALL PAYMENT TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
