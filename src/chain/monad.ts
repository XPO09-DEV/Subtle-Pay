import { createPublicClient, erc20Abi, formatEther, formatUnits, http, type Address } from "viem";
import { config } from "../config.js";
import { serviceUnavailable } from "../lib/errors.js";

export const publicClient = createPublicClient({
  transport: http(config.MONAD_RPC_URL, { timeout: 12_000, retryCount: 1 }),
});

export async function getNativeBalance(address: Address): Promise<bigint> {
  try {
    return await publicClient.getBalance({ address });
  } catch (err) {
    throw serviceUnavailable("Monad is unreachable. Try again in a moment.", "CHAIN_UNAVAILABLE", err);
  }
}

/** Null when no stablecoin is configured. Balance is then native MON. */
export async function getTokenBalance(address: Address): Promise<bigint | null> {
  if (!config.STABLE_TOKEN_ADDRESS) return null;
  try {
    return await publicClient.readContract({
      address: config.STABLE_TOKEN_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
  } catch (err) {
    throw serviceUnavailable("Could not read token balance", "CHAIN_UNAVAILABLE", err);
  }
}

export function formatMon(wei: bigint): string {
  return formatEther(wei);
}

export function formatToken(amount: bigint, decimals = 6): string {
  return formatUnits(amount, decimals);
}