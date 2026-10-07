import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { mockWithdraw } from "./withdraw.service.js";

export async function withdrawRoutes(app: FastifyInstance): Promise<void> {
  app.post("/withdraw", { preHandler: requireAuth }, async (req) => {
    const body = z
      .object({
        amount: z.union([z.string(), z.number()]),
        currency: z.string().length(3),
      })
      .parse(req.body);
    return mockWithdraw(currentUser(req).id, body.amount, body.currency, req.ip);
  });
}
