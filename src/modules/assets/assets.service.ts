import { config } from "../../config.js";
import { badRequest, unprocessable } from "../../lib/errors.js";

export interface PayAsset {
  code: "MON" | "USDC" | "USDT" | "BTC";
  name: string;
  chain: string;
  settles: boolean;
  reason?: string;
}

export function listAssets(): PayAsset[] {
  const stableReady = Boolean(config.STABLE_TOKEN_ADDRESS);
  return [
    { code: "MON", name: "Monad", chain: "monad-testnet", settles: true },
    {
      code: "USDC",
      name: "USD Coin",
      chain: "monad-testnet",
      settles: stableReady,
      reason: stableReady ? undefined : "Stable token address is not configured",
    },
    {
      code: "USDT",
      name: "Tether",
      chain: "monad-testnet",
      settles: stableReady,
      reason: stableReady ? undefined : "Stable token address is not configured",
    },
    { code: "BTC", name: "Bitcoin", chain: "bitcoin", settles: false, reason: "No Bitcoin rail in this build" },
  ];
}

export function assertPayableAsset(code: string | undefined): PayAsset["code"] {
  const asset = (code ?? "MON").toUpperCase();
  const known = listAssets().find((item) => item.code === asset);
  if (!known) throw badRequest("Choose MON, USDC, USDT, or BTC", "BAD_REQUEST");
  if (!known.settles) {
    throw unprocessable(`${known.code} is on the picker, but only a configured asset can settle`, "CHAIN_UNAVAILABLE");
  }
  return known.code;
}
