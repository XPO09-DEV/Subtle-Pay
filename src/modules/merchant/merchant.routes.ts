import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db.js";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { audit } from "../../lib/audit.js";
import { config } from "../../config.js";

export async function merchantRoutes(app: FastifyInstance): Promise<void> {
  // Business requests verification so customers can set autopay for them
  app.post("/merchant/verify-request", { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const body = z
      .object({
        businessName: z.string().min(2).max(80),
        contact: z.string().max(80).optional(),
      })
      .parse(req.body);

    const existing = db.prepare("SELECT status FROM merchant_verifications WHERE user_id = ?").get(user.id) as
      | { status: string }
      | undefined;
    if (existing?.status === "verified") throw badRequest("Already verified");
    if (existing?.status === "pending") throw badRequest("Verification already pending");

    const now = Date.now();
    db.prepare(
      `INSERT INTO merchant_verifications (user_id, business_name, contact, status, requested_at)
       VALUES (?, ?, ?, 'pending', ?)
       ON CONFLICT(user_id) DO UPDATE SET
         business_name = excluded.business_name,
         contact = excluded.contact,
         status = 'pending',
         requested_at = excluded.requested_at,
         reviewed_at = NULL`
    ).run(user.id, body.businessName, body.contact ?? null, now);

    audit(user.id, "merchant.verify_requested", { businessName: body.businessName }, req.ip);
    return { status: "pending" };
  });

  app.get("/merchant/status", { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const row = db
      .prepare("SELECT status, business_name, note FROM merchant_verifications WHERE user_id = ?")
      .get(user.id) as { status: string; business_name: string; note: string | null } | undefined;
    return { status: row?.status ?? "none", businessName: row?.business_name ?? null, note: row?.note ?? null };
  });

  // Our side approves or rejects. Requires MERCHANT_VERIFY_KEY in env.
  app.post("/admin/verify-merchant", async (req) => {
    const key = req.headers["x-verify-key"];
    if (!config.MERCHANT_VERIFY_KEY || key !== config.MERCHANT_VERIFY_KEY) {
      throw unauthorized("Invalid verify key");
    }
    const body = z
      .object({
        accountId: z.string().min(10).max(40),
        approve: z.boolean(),
        note: z.string().max(200).optional(),
      })
      .parse(req.body);

    const row = db.prepare("SELECT user_id FROM merchant_verifications WHERE user_id = ?").get(body.accountId);
    if (!row) throw badRequest("No verification request for this account");

    const status = body.approve ? "verified" : "rejected";
    db.prepare(
      "UPDATE merchant_verifications SET status = ?, note = ?, reviewed_at = ? WHERE user_id = ?"
    ).run(status, body.note ?? null, Date.now(), body.accountId);

    audit("operator", "merchant.verified", { target: body.accountId, status });
    return { ok: true, accountId: body.accountId, status };
  });
}

export function isVerifiedMerchant(userId: string): boolean {
  const row = db.prepare("SELECT status FROM merchant_verifications WHERE user_id = ?").get(userId) as
    | { status: string }
    | undefined;
  return row?.status === "verified";
}
