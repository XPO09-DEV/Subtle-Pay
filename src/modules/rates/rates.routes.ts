import type { FastifyInstance } from "fastify";
import { getRates, getAllRates, listCurrencies, quote, tokenPrice } from "./rates.service.js";

export async function ratesRoutes(app: FastifyInstance): Promise<void> {
  // Single currency view (existing)
  app.get("/rates", async (req) => {
    const query = req.query as { currency?: string };
    return getRates(query.currency ?? "USD");
  });

  // Full real-time snapshot (crypto + all currencies) for frontend dashboards
  app.get("/rates/all", async () => getAllRates());

  app.get("/rates/currencies", async () => ({ currencies: listCurrencies() }));

  app.get("/rates/quote", async (req) => {
    const query = req.query as { from?: string; to?: string; amount?: string };
    return quote(query.from ?? "USD", query.to ?? "INR", query.amount ?? "1");
  });

  app.get("/rates/token", async (req) => {
    const query = req.query as { currency?: string; amount?: string };
    return tokenPrice(query.currency ?? "USD", query.amount ?? "1");
  });
}
