import { badRequest, serviceUnavailable } from "../../lib/errors.js";
import {
  assertCurrency,
  exponentOf,
  minorToDecimalString,
  parseAmountMinor,
  parseUsdToMicro,
  SUPPORTED_CURRENCIES,
  CURRENCIES,
  type Currency,
} from "../../lib/currency.js";

const FX_URL = "https://open.er-api.com/v6/latest/USD";
const TOKEN_URL = "https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd";
const TTL_MS = 60_000;
const TOKEN_USD_FALLBACK = 0.025;

interface Cache {
  tokenUsd: number;
  fx: Record<string, number>;
  updatedAt: number;
}

let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;

async function load(): Promise<Cache> {
  const fxRes = await fetch(FX_URL, { signal: AbortSignal.timeout(5_000) });
  if (!fxRes.ok) throw new Error(`fx ${fxRes.status}`);
  const fxJson = (await fxRes.json()) as { rates?: Record<string, number> };
  if (!fxJson.rates?.INR || !fxJson.rates?.EUR) throw new Error("fx payload missing rates");

  let tokenUsd = TOKEN_USD_FALLBACK;
  try {
    const tokenRes = await fetch(TOKEN_URL, { signal: AbortSignal.timeout(5_000) });
    if (tokenRes.ok) {
      const tokenJson = (await tokenRes.json()) as { monad?: { usd?: number } };
      if (tokenJson.monad?.usd && tokenJson.monad.usd > 0) tokenUsd = tokenJson.monad.usd;
    }
  } catch {
    // A missing MON quote must not blank the wallet.
  }

  return { tokenUsd, fx: { USD: 1, ...fxJson.rates }, updatedAt: Date.now() };
}

async function current(): Promise<Cache> {
  if (cache && Date.now() - cache.updatedAt < TTL_MS) return cache;
  if (!inflight) {
    inflight = load()
      .then((next) => {
        cache = next;
        return next;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch (err) {
    if (cache) return cache;
    throw serviceUnavailable("Exchange rates are unavailable", "RATES_UNAVAILABLE", err);
  }
}

function usdRate(snap: Cache, code: Currency): number {
  const rate = snap.fx[code];
  if (!rate || rate <= 0) throw badRequest(`No rate for ${code}`, "INVALID_CURRENCY");
  return rate;
}

export async function getRates(currency: string) {
  const code = assertCurrency(currency);
  const snap = await current();
  return {
    tokenUsd: snap.tokenUsd,
    usdLocal: usdRate(snap, code),
    currency: code,
    updatedAt: new Date(snap.updatedAt).toISOString(),
  };
}

export function listCurrencies() {
  return SUPPORTED_CURRENCIES.map((code) => ({ code, name: CURRENCIES[code].name, exponent: CURRENCIES[code].exponent }));
}

/** X to Y through USD. 1 unit of `from` buys `rate` units of `to`. */
export async function quote(fromRaw: string, toRaw: string, amountRaw: string) {
  const from = assertCurrency(fromRaw);
  const to = assertCurrency(toRaw);
  const snap = await current();
  const fromPerUsd = usdRate(snap, from);
  const toPerUsd = usdRate(snap, to);
  const rate = toPerUsd / fromPerUsd;
  const entered = from === "USD" ? parseUsdToMicro(amountRaw) / 1_000_000 : parseAmountMinor(amountRaw, from) / 10 ** exponentOf(from);
  const convertedMinor = Math.round(entered * rate * 10 ** exponentOf(to));
  return {
    from,
    to,
    amount: amountRaw,
    rate,
    converted: minorToDecimalString(convertedMinor, to),
    updatedAt: new Date(snap.updatedAt).toISOString(),
  };
}

export type { Currency };
