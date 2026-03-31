import type { FastifyInstance } from "fastify";
import { RegistryStore } from "./registry.js";
import { sendMagicLink, sendInviteEmail, isEmailConfigured } from "./email.js";

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { font-family: sans-serif; max-width: 480px; margin: 4rem auto; text-align: center; color: #111; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { color: #555; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${body}
</body>
</html>`;
}

export async function registerRegistryRoutes(
  app: FastifyInstance,
  registry: RegistryStore,
  relayUrl: string
): Promise<void> {
  // POST /r/register
  app.post<{
    Body: { email?: string; handle?: string; pub?: string; device_id?: string };
  }>("/r/register", async (request, reply) => {
    const { email, handle, pub, device_id } = request.body ?? {};

    if (!email || typeof email !== "string") {
      return reply.status(400).send({ error: "Missing required field: email" });
    }
    if (!handle || typeof handle !== "string") {
      return reply.status(400).send({ error: "Missing required field: handle" });
    }
    if (!pub || typeof pub !== "string") {
      return reply.status(400).send({ error: "Missing required field: pub" });
    }
    if (!device_id || typeof device_id !== "string") {
      return reply.status(400).send({ error: "Missing required field: device_id" });
    }

    let token: string;
    try {
      token = await registry.createMagicLink({ email, handle, pub, device_id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Registration failed";
      if (message.includes("rate limit")) {
        return reply.status(429).send({ error: message });
      }
      return reply.status(400).send({ error: message });
    }

    const email_hash = registry.hashEmail(email);
    const verifyUrl = `${relayUrl}/r/verify?token=${token}`;

    await sendMagicLink(email, verifyUrl);

    // In test mode (email not configured), return token directly
    if (!isEmailConfigured()) {
      return reply.status(200).send({ email_hash, token });
    }

    return reply.status(200).send({ email_hash });
  });

  // GET /r/verify
  app.get<{
    Querystring: { token?: string };
  }>("/r/verify", async (request, reply) => {
    const { token } = request.query;

    if (!token || typeof token !== "string") {
      return reply
        .status(400)
        .header("content-type", "text/html; charset=utf-8")
        .send(htmlPage("Invalid Link", "<p>Missing verification token.</p>"));
    }

    const result = await registry.verifyMagicLink(token);

    if (!result) {
      return reply
        .status(400)
        .header("content-type", "text/html; charset=utf-8")
        .send(
          htmlPage(
            "Invalid or Expired Link",
            "<p>This verification link is invalid or has already been used.</p>"
          )
        );
    }

    return reply
      .status(200)
      .header("content-type", "text/html; charset=utf-8")
      .send(
        htmlPage(
          "Verified!",
          "<p>Your Peer67 identity has been verified. You can close this tab.</p>"
        )
      );
  });

  // GET /r/check-verification
  app.get<{
    Querystring: { email_hash?: string; device_id?: string };
  }>("/r/check-verification", async (request, reply) => {
    const { email_hash, device_id } = request.query;

    if (!email_hash || typeof email_hash !== "string") {
      return reply.status(400).send({ error: "Missing required query param: email_hash" });
    }
    if (!device_id || typeof device_id !== "string") {
      return reply.status(400).send({ error: "Missing required query param: device_id" });
    }

    const verified = await registry.checkVerification(email_hash, device_id);
    return reply.status(200).send({ verified });
  });

  // GET /r/lookup
  app.get<{
    Querystring: { email_hash?: string };
  }>("/r/lookup", async (request, reply) => {
    const { email_hash } = request.query;

    if (!email_hash || typeof email_hash !== "string") {
      return reply.status(400).send({ error: "Missing required query param: email_hash" });
    }

    const result = await registry.lookup(email_hash);

    if (!result) {
      return reply.status(200).send({ found: false });
    }

    return reply.status(200).send({ found: true, handle: result.handle, pub: result.pub });
  });

  // GET /r/directory
  app.get<{
    Querystring: { q?: string };
  }>("/r/directory", async (request, reply) => {
    const { q } = request.query;
    const users = await registry.directory(q);
    return reply.status(200).send({ users });
  });

  // POST /r/invite
  app.post<{
    Body: {
      target_email?: string;
      from_handle?: string;
      from_pub?: string;
      from_relay?: string;
    };
  }>("/r/invite", async (request, reply) => {
    const { target_email, from_handle, from_pub, from_relay } = request.body ?? {};

    if (!target_email || typeof target_email !== "string") {
      return reply.status(400).send({ error: "Missing required field: target_email" });
    }
    if (!from_handle || typeof from_handle !== "string") {
      return reply.status(400).send({ error: "Missing required field: from_handle" });
    }
    if (!from_pub || typeof from_pub !== "string") {
      return reply.status(400).send({ error: "Missing required field: from_pub" });
    }
    if (!from_relay || typeof from_relay !== "string") {
      return reply.status(400).send({ error: "Missing required field: from_relay" });
    }

    // Check if target is already registered
    const targetHash = registry.hashEmail(target_email);
    const existing = await registry.lookup(targetHash);
    if (existing) {
      return reply.status(409).send({
        error: "already_registered",
        handle: existing.handle,
        pub: existing.pub,
      });
    }

    const invite_id = await registry.createInvite({
      target_email,
      from_handle,
      from_pub,
      from_relay,
    });

    await sendInviteEmail(target_email, from_handle);

    return reply.status(200).send({ ok: true, invite_id });
  });

  // GET /r/invites
  app.get<{
    Querystring: { email_hash?: string };
  }>("/r/invites", async (request, reply) => {
    const { email_hash } = request.query;

    if (!email_hash || typeof email_hash !== "string") {
      return reply.status(400).send({ error: "Missing required query param: email_hash" });
    }

    const invites = await registry.getInvites(email_hash);
    return reply.status(200).send({ invites });
  });

  // DELETE /r/invites/:id
  app.delete<{
    Params: { id: string };
    Querystring: { email_hash?: string };
  }>("/r/invites/:id", async (request, reply) => {
    const { id } = request.params;
    const { email_hash } = request.query;

    if (!email_hash || typeof email_hash !== "string") {
      return reply.status(400).send({ error: "Missing required query param: email_hash" });
    }

    const ok = await registry.deleteInvite(email_hash, id);
    return reply.status(200).send({ ok });
  });
}
