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

// Frankfurter: free, no-key, ECB-sourced real-time FX rates
const FRANKFURTER_URL = "https://api.frankfurter.app/latest?from=USD";
// CoinGecko for crypto (MON + major assets)
const CRYPTO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=monad,bitcoin,ethereum,usd-coin,tether&vs_currencies=usd";

const TTL_MS = 30_000; // 30s for fresher real-time feel
const TOKEN_USD_FALLBACK = 0.025;

interface Cache {
  tokenUsd: number;
  crypto: Record<string, number>; // id -> usd price
  fx: Record<string, number>; // currency -> units per 1 USD
  updatedAt: number;
  source: { fx: string; crypto: string };
}

let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;

async function load(): Promise<Cache> {
  // Fiat via Frankfurter
  const fxRes = await fetch(FRANKFURTER_URL, { signal: AbortSignal.timeout(6_000) });
  if (!fxRes.ok) throw new Error(`frankfurter ${fxRes.status}`);
  const fxJson = (await fxRes.json()) as { rates?: Record<string, number>; date?: string };
  if (!fxJson.rates?.EUR) throw new Error("frankfurter payload missing rates");

  // Crypto
  const crypto: Record<string, number> = { monad: TOKEN_USD_FALLBACK };
  try {
    const cryptoRes = await fetch(CRYPTO_URL, { signal: AbortSignal.timeout(6_000) });
    if (cryptoRes.ok) {
      const cryptoJson = (await cryptoRes.json()) as Record<string, { usd?: number }>;
      for (const [id, val] of Object.entries(cryptoJson)) {
        if (val?.usd && val.usd > 0) crypto[id] = val.usd;
      }
    }
  } catch {
    // Non-fatal; keep fallback for MON
  }

  const tokenUsd = crypto.monad ?? TOKEN_USD_FALLBACK;

  return {
    tokenUsd,
    crypto,
    fx: { USD: 1, ...fxJson.rates },
    updatedAt: Date.now(),
    source: { fx: "frankfurter.app (ECB)", crypto: "coingecko" },
  };
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
    source: snap.source,
  };
}

/** Full snapshot for the frontend dashboard */
export async function getAllRates() {
  const snap = await current();
  const currencies: Record<string, number> = {};
  for (const code of SUPPORTED_CURRENCIES) {
    if (snap.fx[code]) currencies[code] = snap.fx[code];
  }
  return {
    crypto: snap.crypto,
    currencies,
    monUsd: snap.tokenUsd,
    updatedAt: new Date(snap.updatedAt).toISOString(),
    source: snap.source,
  };
}

export function listCurrencies() {
  return SUPPORTED_CURRENCIES.map((code) => ({
    code,
    name: CURRENCIES[code].name,
    exponent: CURRENCIES[code].exponent,
  }));
}

/** X to Y through USD. 1 unit of `from` buys `rate` units of `to`. */
export async function quote(fromRaw: string, toRaw: string, amountRaw: string) {
  const from = assertCurrency(fromRaw);
  const to = assertCurrency(toRaw);
  const snap = await current();
  const fromPerUsd = usdRate(snap, from);
  const toPerUsd = usdRate(snap, to);
  const rate = toPerUsd / fromPerUsd;
  const entered =
    from === "USD"
      ? parseUsdToMicro(amountRaw) / 1_000_000
      : parseAmountMinor(amountRaw, from) / 10 ** exponentOf(from);
  const convertedMinor = Math.round(entered * rate * 10 ** exponentOf(to));
  return {
    from,
    to,
    amount: amountRaw,
    rate,
    converted: minorToDecimalString(convertedMinor, to),
    updatedAt: new Date(snap.updatedAt).toISOString(),
    source: snap.source.fx,
  };
}

export async function tokenPrice(currencyRaw: string, amountRaw = "1") {
  const currency = assertCurrency(currencyRaw);
  const snap = await current();
  const localPerUsd = usdRate(snap, currency);
  const price = snap.tokenUsd * localPerUsd;
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest("Invalid amount", "INVALID_AMOUNT");
  const valueMinor = Math.round(amount * price * 10 ** exponentOf(currency));
  return {
    asset: "MON",
    currency,
    tokenUsd: snap.tokenUsd,
    price: minorToDecimalString(Math.round(price * 10 ** exponentOf(currency)), currency),
    amount: amountRaw,
    value: minorToDecimalString(valueMinor, currency),
    updatedAt: new Date(snap.updatedAt).toISOString(),
    source: snap.source,
  };
}

export type { Currency };
