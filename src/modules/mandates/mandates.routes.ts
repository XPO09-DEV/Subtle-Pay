import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { createMandate, runMandate } from "./mandates.service.js";

export async function mandateRoutes(app: FastifyInstance): Promise<void> {
  app.post("/mandates", { preHandler: requireAuth }, async (req) => {
    const body = z
      .object({
        merchant: z.string().min(3).max(40),
        cap: z.string().min(1),
        currency: z.string().length(3),
        intervalDays: z.number().int().min(1).max(365),
      })
      .parse(req.body);
    return createMandate(currentUser(req).id, body.merchant, body.cap, body.currency, body.intervalDays, req.ip);
  });

  app.post("/mandates/:id/run", { preHandler: requireAuth }, async (req) => {
    const body = z.object({ amount: z.string().min(1) }).parse(req.body);
    return runMandate(currentUser(req).id, (req.params as { id: string }).id, body.amount, req.ip);
  });
}
