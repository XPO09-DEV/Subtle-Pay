import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { listPayments, sendPayment } from "./payments.service.js";

const sendBody = z.object({
  to: z.string().min(2).max(64),
  amount: z.union([z.string(), z.number()]),
  amountCurrency: z.string().length(3),
  note: z.string().max(140).optional(),
});

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/payments/send", { preHandler: requireAuth }, async (req) => {
    const body = sendBody.parse(req.body);
    return sendPayment(currentUser(req).id, body, req.ip);
  });

  app.get("/payments", { preHandler: requireAuth }, async (req) => listPayments(currentUser(req).id));
}
