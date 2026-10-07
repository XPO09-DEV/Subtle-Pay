import type { FastifyInstance } from "fastify";
import { listAssets } from "./assets.service.js";

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  app.get("/assets", async () => ({ assets: listAssets() }));
}
