import { badRequest } from "./errors.js";

/* -------------------------------------------------------------------------- */
/*  Units                                                                     */
/*                                                                            */
/*  USD is held in "micro-dollars" (1 USD = 1_000_000), exactly the 6         */
/*  decimals of the on-chain stablecoin, so on-chain and database amounts     */
/*  are always the same integer.                                              */
/*  Local currencies are held in "minor units" (paise, cents, ...).           */
/* -------------------------------------------------------------------------- */

export const MICRO_PER_USD = 1_000_000;
export const USD_DECIMALS = 6;

/** Per-payment limits (prototype values; tune later). */
export const MIN_PAYMENT_MICRO = 10_000; // $0.01
export const MAX_PAYMENT_MICRO = 10_000 * MICRO_PER_USD; // $10,000

interface CurrencyInfo {
  readonly name: string;
  readonly exponent: number; // digits after the decimal point (ISO 4217)
}

export const CURRENCIES = {
  USD: { name: "US Dollar", exponent: 2 },
  EUR: { name: "Euro", exponent: 2 },
  GBP: { name: "British Pound", exponent: 2 },
  INR: { name: "Indian Rupee", exponent: 2 },
  BDT: { name: "Bangladeshi Taka", exponent: 2 },
  AED: { name: "UAE Dirham", exponent: 2 },
  SAR: { name: "Saudi Riyal", exponent: 2 },
  QAR: { name: "Qatari Riyal", exponent: 2 },
  KWD: { name: "Kuwaiti Dinar", exponent: 3 },
  OMR: { name: "Omani Rial", exponent: 3 },
  BHD: { name: "Bahraini Dinar", exponent: 3 },
  SGD: { name: "Singapore Dollar", exponent: 2 },
  MYR: { name: "Malaysian Ringgit", exponent: 2 },
  THB: { name: "Thai Baht", exponent: 2 },
  IDR: { name: "Indonesian Rupiah", exponent: 2 },
  PHP: { name: "Philippine Peso", exponent: 2 },
  VND: { name: "Vietnamese Dong", exponent: 0 },
  JPY: { name: "Japanese Yen", exponent: 0 },
  CNY: { name: "Chinese Yuan", exponent: 2 },
  HKD: { name: "Hong Kong Dollar", exponent: 2 },
  KRW: { name: "South Korean Won", exponent: 0 },
  AUD: { name: "Australian Dollar", exponent: 2 },
  NZD: { name: "New Zealand Dollar", exponent: 2 },
  CAD: { name: "Canadian Dollar", exponent: 2 },
  CHF: { name: "Swiss Franc", exponent: 2 },
  SEK: { name: "Swedish Krona", exponent: 2 },
  NOK: { name: "Norwegian Krone", exponent: 2 },
  DKK: { name: "Danish Krone", exponent: 2 },
  PLN: { name: "Polish Zloty", exponent: 2 },
  CZK: { name: "Czech Koruna", exponent: 2 },
  HUF: { name: "Hungarian Forint", exponent: 2 },
  TRY: { name: "Turkish Lira", exponent: 2 },
  ZAR: { name: "South African Rand", exponent: 2 },
  NGN: { name: "Nigerian Naira", exponent: 2 },
  KES: { name: "Kenyan Shilling", exponent: 2 },
  GHS: { name: "Ghanaian Cedi", exponent: 2 },
  EGP: { name: "Egyptian Pound", exponent: 2 },
  MAD: { name: "Moroccan Dirham", exponent: 2 },
  BRL: { name: "Brazilian Real", exponent: 2 },
  MXN: { name: "Mexican Peso", exponent: 2 },
  ARS: { name: "Argentine Peso", exponent: 2 },
  CLP: { name: "Chilean Peso", exponent: 0 },
  COP: { name: "Colombian Peso", exponent: 2 },
  PKR: { name: "Pakistani Rupee", exponent: 2 },
  NPR: { name: "Nepalese Rupee", exponent: 2 },
  LKR: { name: "Sri Lankan Rupee", exponent: 2 },
  ILS: { name: "Israeli Shekel", exponent: 2 },
  RON: { name: "Romanian Leu", exponent: 2 },
} as const satisfies Record<string, CurrencyInfo>;

export type Currency = keyof typeof CURRENCIES;

export const SUPPORTED_CURRENCIES = Object.keys(CURRENCIES) as Currency[];

export function isSupportedCurrency(code: string): code is Currency {
  return Object.hasOwn(CURRENCIES, code);
}

export function assertCurrency(code: string): Currency {
  const upper = code.trim().toUpperCase();
  if (!isSupportedCurrency(upper)) {
    throw badRequest(`Unsupported currency: ${code}`, "INVALID_CURRENCY");
  }
  return upper;
}

export const exponentOf = (currency: Currency): number => CURRENCIES[currency].exponent;

/* -------------------------------------------------------------------------- */
/*  Strict decimal parsing (no floating point involved)                       */
/* -------------------------------------------------------------------------- */

// Up to 9 whole digits keeps every result a safe integer even with 6 decimals.
const DECIMAL_RE = /^(\d{1,9})(?:\.(\d{1,6}))?$/;

/** "12.34" with decimals=2 -> 1234. Rejects signs, exponents, extra decimals. */
export function parseDecimalAmount(input: string, decimals: number): number {
  const m = DECIMAL_RE.exec(input.trim());
  if (!m) throw badRequest("Invalid amount", "INVALID_AMOUNT");

  const whole = m[1];
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    throw badRequest(`At most ${decimals} decimal places are allowed`, "INVALID_AMOUNT");
  }

  const units = Number(whole + frac.padEnd(decimals, "0"));
  if (!Number.isSafeInteger(units)) throw badRequest("Invalid amount", "INVALID_AMOUNT");
  return units;
}

/** "5.25" -> 5_250_000 micro-dollars. */
export function parseUsdToMicro(input: string): number {
  return parseDecimalAmount(input, USD_DECIMALS);
}

/** "436.80" in INR -> 43680 minor units (paise). */
export function parseAmountMinor(input: string, currency: Currency): number {
  return parseDecimalAmount(input, exponentOf(currency));
}

/** 43680 minor units, exponent 2 -> "436.80" (for API responses). */
export function minorToDecimalString(minor: number, currency: Currency): string {
  const exp = exponentOf(currency);
  if (exp === 0) return String(minor);
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(exp + 1, "0");
  const out = `${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
  return negative ? `-${out}` : out;
}

/** 5_250_000 micro-dollars -> "5.250000". */
export function microToDecimalString(micro: number): string {
  const negative = micro < 0;
  const digits = String(Math.abs(micro)).padStart(USD_DECIMALS + 1, "0");
  const out = `${digits.slice(0, -USD_DECIMALS)}.${digits.slice(-USD_DECIMALS)}`;
  return negative ? `-${out}` : out;
}

/* -------------------------------------------------------------------------- */
/*  Conversion. `rate` = how many units of `currency` equal 1 USD.            */
/* -------------------------------------------------------------------------- */

function assertRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("Invalid exchange rate");
  }
}

function assertSafe(n: number): number {
  if (!Number.isSafeInteger(n)) throw badRequest("Amount out of range", "INVALID_AMOUNT");
  return n;
}

export function usdMicroToLocalMinor(micro: number, rate: number, currency: Currency): number {
  assertRate(rate);
  const exp = exponentOf(currency);
  return assertSafe(Math.round((micro * rate * 10 ** exp) / MICRO_PER_USD));
}

export function localMinorToUsdMicro(minor: number, rate: number, currency: Currency): number {
  assertRate(rate);
  const exp = exponentOf(currency);
  return assertSafe(Math.round((minor * MICRO_PER_USD) / (rate * 10 ** exp)));
}

/** Check a payment amount against the global limits. Throws a 4xx error. */
export function assertPaymentWithinLimits(micro: number): void {
  if (!Number.isSafeInteger(micro) || micro < MIN_PAYMENT_MICRO) {
    throw badRequest("Amount is below the minimum of $0.01", "INVALID_AMOUNT");
  }
  if (micro > MAX_PAYMENT_MICRO) {
    throw badRequest("Amount is above the maximum of $10,000 per payment", "INVALID_AMOUNT");
  }
}

/* -------------------------------------------------------------------------- */
/*  Formatting (display only; never parse these strings back)                 */
/* -------------------------------------------------------------------------- */

export function formatMoneyMinor(minor: number, currency: Currency, locale = "en"): string {
  const exp = exponentOf(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(minor / 10 ** exp);
}

export function formatUsdMicro(micro: number, locale = "en"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(micro / MICRO_PER_USD);
}