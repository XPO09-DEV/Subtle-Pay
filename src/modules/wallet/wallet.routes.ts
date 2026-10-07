import type { FastifyInstance } from "fastify";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { getWalletView } from "./wallet.service.js";

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  app.get("/wallet", { preHandler: requireAuth }, async (req) => getWalletView(currentUser(req).id));
}