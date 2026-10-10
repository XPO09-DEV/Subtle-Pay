import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser, requireAuth } from "../../middleware/auth.js";
import { runIdempotent } from "../../middleware/idempotency.js";
import { assertPayableAsset } from "../assets/assets.service.js";
import { listPayments, sendPayment } from "./payments.service.js";
import { verifyMpin } from "../auth/auth.service.js";
import { verifyBiometricAssertion } from "../auth/webauthn.service.js";
import { badRequest } from "../../lib/errors.js";

const sendBody = z.object({
  to: z.string().min(2).max(64),
  amount: z.union([z.string(), z.number()]),
  amountCurrency: z.string().length(3),
  note: z.string().max(140).optional(),
  asset: z.string().max(8).optional(),
  mpin: z.string().min(4).max(6).optional(),
  biometric: z
    .object({
      credentialId: z.string(),
      challenge: z.string(),
      signature: z.string(),
    })
    .optional(),
});

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/payments/send", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) => {
    const body = sendBody.parse(req.body);
    assertPayableAsset(body.asset);
    const user = currentUser(req);

    // Must provide either MPIN or a valid biometric assertion
    if (body.mpin) {
      await verifyMpin(user.id, body.mpin);
    } else if (body.biometric) {
      const ok = verifyBiometricAssertion(
        user.id,
        body.biometric.credentialId,
        body.biometric.challenge,
        body.biometric.signature
      );
      if (!ok) throw badRequest("Biometric verification failed");
    } else {
      throw badRequest("Provide MPIN or biometric to authorize payment");
    }

    const key = req.headers["idempotency-key"];
    return runIdempotent(user.id, Array.isArray(key) ? key[0] : key, body, reply, () =>
      sendPayment(user.id, body, req.ip)
    );
  });

  app.get("/payments", { preHandler: requireAuth }, async (req) => listPayments(currentUser(req).id));
}
