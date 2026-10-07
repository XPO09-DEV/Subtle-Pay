import type { FastifyInstance } from "fastify";
import { getRates } from "./rates.service.js";

export async function ratesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/rates", async (req) => {
    const query = req.query as { currency?: string };
    return getRates(query.currency ?? "USD");
  });
}