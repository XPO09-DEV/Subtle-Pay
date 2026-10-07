import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { createBill, getBill, payBill } from "./bills.service.js";

export async function billRoutes(app: FastifyInstance): Promise<void> {
  app.post("/bills", { preHandler: requireAuth }, async (req) => {
    const body = z
      .object({
        amount: z.union([z.string(), z.number()]),
        currency: z.string().length(3),
        note: z.string().max(140).optional(),
      })
      .parse(req.body);
    return createBill(currentUser(req).id, body.amount, body.currency, body.note, req.ip);
  });

  app.get("/bills/:id", async (req) => getBill((req.params as { id: string }).id));

  app.post("/bills/:id/pay", { preHandler: requireAuth }, async (req) =>
    payBill(currentUser(req).id, (req.params as { id: string }).id, req.ip)
  );
}
