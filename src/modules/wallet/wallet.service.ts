import { formatEther } from "viem";
import { config } from "../../config.js";
import { formatMon, formatToken, getNativeBalance, getTokenBalance } from "../../chain/monad.js";
import { db, type UserRow, type WalletRow } from "../../db.js";
import {
  microToDecimalString,
  minorToDecimalString,
  usdMicroToLocalMinor,
  type Currency,
} from "../../lib/currency.js";
import { notFound } from "../../lib/errors.js";
import { getRates } from "../rates/rates.service.js";

export function getWalletRow(userId: string): WalletRow {
  const row = db.prepare("SELECT * FROM wallets WHERE user_id = ?").get(userId) as WalletRow | undefined;
  if (!row) throw notFound("Wallet not found");
  return row;
}

export async function getWalletView(userId: string) {
  const user = db.prepare("SELECT currency FROM users WHERE id = ?").get(userId) as Pick<UserRow, "currency">;
  const wallet = getWalletRow(userId);
  const currency = user.currency as Currency;
  const rates = await getRates(currency);
  const address = wallet.address as `0x${string}`;

  const nativeWei = await getNativeBalance(address);
  const tokenRaw = await getTokenBalance(address);
  const balanceToken = tokenRaw !== null ? formatToken(tokenRaw, 6) : formatMon(nativeWei);

  const usd = tokenRaw !== null ? Number(tokenRaw) / 1e6 : Number(formatEther(nativeWei)) * rates.tokenUsd;
  const balanceUsdMicro = Math.round(usd * 1_000_000);
  const localMinor = usdMicroToLocalMinor(balanceUsdMicro, rates.usdLocal, currency);

  return {
    address: wallet.address,
    balanceToken,
    balanceUsd: microToDecimalString(balanceUsdMicro),
    balanceLocal: minorToDecimalString(localMinor, currency),
    currency,
    asset: config.STABLE_TOKEN_ADDRESS ? "USD" : "MON",
    chainId: config.MONAD_CHAIN_ID,
  };
}