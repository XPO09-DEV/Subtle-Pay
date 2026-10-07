import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { newId } from "../../lib/crypto.js";

const CHAINS = ["base", "arbitrum", "ethereum"] as const;

/**
 * Prototype only. No bridge message is sent. The response is labeled simulated
 * so a demo screen can show the intended path without claiming funds moved.
 */
export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/bridge/preview", { preHandler: requireAuth }, async (req) => {
    const body = z
      .object({
        sourceChain: z.enum(CHAINS),
        amount: z.union([z.string(), z.number()]),
        currency: z.string().length(3),
        to: z.string().min(2).max(64),
      })
      .parse(req.body);
    return {
      intentId: newId(),
      mode: "simulated",
      settled: false,
      sourceChain: body.sourceChain,
      amount: String(body.amount),
      currency: body.currency.toUpperCase(),
      to: body.to,
      destinationChain: "monad-testnet",
      chainId: 10143,
      steps: [
        `Lock ${body.amount} ${body.currency.toUpperCase()} on ${body.sourceChain}`,
        "Wait for the bridge message",
        `Credit ${body.to} on Monad`,
      ],
      note: "Preview only. No funds move. Live settlement is the Monad send and the merchant bill.",
      requestedBy: currentUser(req).id,
    };
  });
}
