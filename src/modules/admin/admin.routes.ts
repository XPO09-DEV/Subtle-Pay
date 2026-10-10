import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { unauthorized } from "../../lib/errors.js";
import {
  adminFromToken,
  adminLogin,
  adminLogout,
  overview,
  listUsers,
  userDetail,
  banUser,
  unbanUser,
  listMerchants,
  reviewMerchant,
  listMandates,
  revokeMandate,
  listAudit,
  listTables,
  tableRows,
} from "./admin.service.js";

function requireLocal(req: { ip: string }) {
  const ip = req.ip || "";
  const local = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.endsWith("127.0.0.1");
  if (!local) throw unauthorized("Admin is restricted to the operator network");
}

function requireAdmin(req: FastifyRequest) {
  requireLocal(req);
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw unauthorized("Admin token required");
  return adminFromToken(token);
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post("/admin/login", async (req) => {
    requireLocal(req);
    const body = z.object({ email: z.string().min(1).max(80), password: z.string().min(1) }).parse(req.body);
    return adminLogin(body.email, body.password, req.ip);
  });

  app.post("/admin/logout", async (req) => {
    const admin = requireAdmin(req);
    adminLogout(admin.sessionId);
    return { ok: true };
  });

  app.get("/admin/me", async (req) => requireAdmin(req));

  app.get("/admin/overview", async (req) => {
    requireAdmin(req);
    return overview();
  });

  app.get("/admin/users", async (req) => {
    requireAdmin(req);
    const q = req.query as { q?: string; limit?: string; offset?: string };
    return { users: listUsers(q.q, Number(q.limit) || 50, Number(q.offset) || 0) };
  });

  app.get("/admin/users/:id", async (req) => {
    requireAdmin(req);
    return userDetail((req.params as { id: string }).id);
  });

  app.post("/admin/users/:id/ban", async (req) => {
    const admin = requireAdmin(req);
    const body = z.object({ reason: z.string().min(1).max(200) }).parse(req.body);
    return banUser(admin.id, (req.params as { id: string }).id, body.reason, req.ip);
  });

  app.post("/admin/users/:id/unban", async (req) => {
    const admin = requireAdmin(req);
    return unbanUser(admin.id, (req.params as { id: string }).id, req.ip);
  });

  app.get("/admin/merchants", async (req) => {
    requireAdmin(req);
    const q = req.query as { status?: string };
    return { merchants: listMerchants(q.status) };
  });

  app.post("/admin/merchants/:id/review", async (req) => {
    const admin = requireAdmin(req);
    const body = z.object({ approve: z.boolean(), note: z.string().max(200).optional() }).parse(req.body);
    return reviewMerchant(admin.id, (req.params as { id: string }).id, body.approve, body.note, req.ip);
  });

  app.get("/admin/autopay", async (req) => {
    requireAdmin(req);
    return { mandates: listMandates() };
  });

  app.post("/admin/autopay/:id/revoke", async (req) => {
    const admin = requireAdmin(req);
    return revokeMandate(admin.id, (req.params as { id: string }).id, req.ip);
  });

  app.get("/admin/audit", async (req) => {
    requireAdmin(req);
    const q = req.query as { limit?: string; offset?: string; action?: string };
    return { logs: listAudit(Number(q.limit) || 100, Number(q.offset) || 0, q.action) };
  });

  app.get("/admin/health", async (req) => {
    requireAdmin(req);
    return { ok: true, db: "connected", time: new Date().toISOString() };
  });

  app.get("/admin/db/tables", async (req) => {
    requireAdmin(req);
    return { tables: listTables() };
  });

  app.get("/admin/db/:table", async (req) => {
    requireAdmin(req);
    const q = req.query as { limit?: string; offset?: string };
    const table = (req.params as { table: string }).table;
    return { table, rows: tableRows(table, Number(q.limit) || 50, Number(q.offset) || 0) };
  });
}
