import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { runIdempotent } from "../../middleware/idempotency.js";
import { listPayments, sendPayment } from "./payments.service.js";

const sendBody = z.object({
  to: z.string().min(2).max(64),
  amount: z.union([z.string(), z.number()]),
  amountCurrency: z.string().length(3),
  note: z.string().max(140).optional(),
});

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/payments/send", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = sendBody.parse(req.body);
    const key = req.headers["idempotency-key"];
    return runIdempotent(currentUser(req).id, Array.isArray(key) ? key[0] : key, body, reply, () =>
      sendPayment(currentUser(req).id, body, req.ip)
    );
  });

  app.get("/payments", { preHandler: requireAuth }, async (req) => listPayments(currentUser(req).id));
}
