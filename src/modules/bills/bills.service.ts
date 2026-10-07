import { db } from "../../db.js";
import { newId } from "../../lib/crypto.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { audit } from "../../lib/audit.js";
import { assertCurrency } from "../../lib/currency.js";
import { sendPayment } from "../payments/payments.service.js";
import { tokenPrice } from "../rates/rates.service.js";

const BILL_TTL_MS = 4 * 60 * 1000;

function merchantHandle(userId: string): string {
  const alias = db.prepare("SELECT alias FROM aliases WHERE user_id = ?").get(userId) as { alias: string } | undefined;
  return `${alias?.alias ?? userId}@monad`;
}

export async function createBill(
  merchantId: string,
  amount: string | number,
  currencyRaw: string,
  note?: string,
  ip?: string
) {
  const currency = assertCurrency(currencyRaw);
  const amountText = typeof amount === "number" ? String(amount) : amount.trim();
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(amountText) || Number(amountText) <= 0) {
    throw badRequest("Invalid amount", "INVALID_AMOUNT");
  }
  const id = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO bills (id, merchant_id, amount_text, currency, note, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(id, merchantId, amountText, currency, note ?? null, now + BILL_TTL_MS, now);
  audit(merchantId, "bill.create", { id, currency }, ip);
  return present(id);
}

export async function getBill(id: string) {
  return present(id);
}

export async function payBill(payerId: string, id: string, ip?: string) {
  const bill = row(id);
  if (bill.expires_at <= Date.now() && bill.status === "open") {
    db.prepare("UPDATE bills SET status = 'expired' WHERE id = ?").run(id);
    throw conflict("This bill has expired");
  }
  if (bill.status !== "open") throw conflict("This bill is no longer payable");
  if (bill.merchant_id === payerId) throw badRequest("You cannot pay your own bill", "SELF_PAYMENT");

  const paid = await sendPayment(payerId, {
    to: bill.merchant_id,
    amount: bill.amount_text,
    amountCurrency: bill.currency,
    note: bill.note ?? `bill ${id}`,
  }, ip);

  db.prepare(
    `UPDATE bills SET status = 'paid', payer_id = ?, tx_id = ?, paid_at = ? WHERE id = ? AND status = 'open'`
  ).run(payerId, paid.txId, Date.now(), id);
  audit(payerId, "bill.pay", { id, txId: paid.txId }, ip);
  return { ...await present(id), payment: paid };
}

async function present(id: string) {
  const bill = row(id);
  const status = bill.status === "open" && bill.expires_at <= Date.now() ? "expired" : bill.status;
  const quote = await tokenPrice(bill.currency, "1");
  return {
    billId: bill.id,
    handle: merchantHandle(bill.merchant_id),
    amount: bill.amount_text,
    currency: bill.currency,
    note: bill.note,
    status,
    expiresAt: new Date(bill.expires_at).toISOString(),
    qr: `subtlepay://bill/${bill.id}`,
    monPrice: quote.price,
    txId: bill.tx_id,
  };
}

function row(id: string) {
  const bill = db.prepare("SELECT * FROM bills WHERE id = ?").get(id) as {
    id: string;
    merchant_id: string;
    amount_text: string;
    currency: string;
    note: string | null;
    status: string;
    payer_id: string | null;
    tx_id: string | null;
    expires_at: number;
  } | undefined;
  if (!bill) throw notFound("Bill not found");
  return bill;
}
