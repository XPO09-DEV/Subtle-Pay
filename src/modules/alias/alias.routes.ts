import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { claimAlias, resolveAlias } from "./alias.service.js";

export async function aliasRoutes(app: FastifyInstance): Promise<void> {
  app.post("/alias", { preHandler: requireAuth }, async (req) => {
    const body = z.object({ alias: z.string().min(1).max(24) }).parse(req.body);
    return claimAlias(currentUser(req).id, body.alias, req.ip);
  });

  app.get("/alias/:name", async (req) => {
    const { name } = req.params as { name: string };
    return resolveAlias(name);
  });
}