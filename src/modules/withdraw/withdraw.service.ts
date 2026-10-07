import { db } from "../../db.js";
import { newId } from "../../lib/crypto.js";
import {
  assertCurrency,
  assertPaymentWithinLimits,
  localMinorToUsdMicro,
  microToDecimalString,
  minorToDecimalString,
  parseAmountMinor,
  parseUsdToMicro,
  usdMicroToLocalMinor,
  type Currency,
} from "../../lib/currency.js";
import { audit } from "../../lib/audit.js";
import { getRates } from "../rates/rates.service.js";

export async function mockWithdraw(
  userId: string,
  amount: string | number,
  currencyRaw: string,
  ip?: string
) {
  const currency = assertCurrency(currencyRaw);
  const text = typeof amount === "number" ? String(amount) : amount.trim();
  const entered = currency === "USD" ? parseUsdToMicro(text) : parseAmountMinor(text, currency);
  const rates = await getRates(currency);
  const usdMicro = currency === "USD" ? entered : localMinorToUsdMicro(entered, rates.usdLocal, currency);
  assertPaymentWithinLimits(usdMicro);

  const payoutMinor = usdMicroToLocalMinor(usdMicro, rates.usdLocal, currency);
  const id = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO withdrawals
       (id, user_id, amount_micro, currency, fx_rate, payout_minor_units, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?)`
  ).run(id, userId, usdMicro, currency, rates.usdLocal, payoutMinor, now, now);
  audit(userId, "withdraw.mock", { id, usdMicro, currency }, ip);

  return {
    withdrawalId: id,
    status: "completed" as const,
    payoutLocal: minorToDecimalString(payoutMinor, currency),
    usdValue: microToDecimalString(usdMicro),
    currency,
  };
}
