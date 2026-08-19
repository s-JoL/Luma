/**
 * Everything the owner needs to keep a publicly reachable Luma theirs alone:
 * rotating the access code, enrolling a second factor, and seeing which devices
 * still hold a session.
 *
 * Every write here outlives the session that made it, so every write here is
 * behind a step-up confirmation (`auth.ts`). A session cookie alone can read
 * this screen; it cannot change what a lost session would have to be recovered
 * with.
 */
import { Hono } from "hono";
import type { SecuritySettings } from "@shared/types.ts";
import { SECRET } from "../../config.ts";
import type { Services } from "../../services.ts";
import { acceptTotp, checkTotp, currentSessionId, liveSessions, overTls, requireStepUp } from "../auth.ts";
import { newTotpSecret, otpauthUri } from "../../crypto/totp.ts";
import { readJson } from "../body.ts";
import { fail } from "../errors.ts";

export function securityRoutes(services: Services) {
  const app = new Hono();
  const { store, vault } = services;

  const snapshot = (currentId: string): SecuritySettings => ({
    totpEnabled: vault.has(SECRET.totp),
    overTls: false,
    trustProxy: process.env.LUMA_TRUST_PROXY === "1",
    sessions: liveSessions(services),
    currentSessionId: currentId,
  });

  app.get("/security", (context) =>
    context.json({ ...snapshot(currentSessionId(context)), overTls: overTls(context) }),
  );

  app.put("/security/access-code", async (context) => {
    const body = await readJson<{ value: string }>(context);
    const denied = await requireStepUp(services, context);
    if (denied) return denied;
    const value = (body.value ?? "").trim();
    // Eight was the old floor, and this is the factor the whole internet gets to
    // guess at when Access is off. NIST SP 800-63B-4 §3.1.1.1 puts the floor for
    // a chosen secret at 8 and says a verifier should ask for 15; twelve is the
    // point where the pause curve in `auth.ts` makes guessing hopeless.
    if (value.length < 12) return fail(context, 400, "invalid", "Use at least 12 characters");
    vault.set(SECRET.accessCode, value);
    // Other devices signed in with the old code; make them prove the new one.
    store.deleteAllSessions(currentSessionId(context));
    return context.json(snapshot(currentSessionId(context)));
  });

  /**
   * Enrolment is two steps on purpose: the secret is only adopted once a code
   * generated from it comes back, which proves the authenticator really has it
   * and rules out locking yourself out of your own server.
   */
  app.post("/security/totp", async (context) => {
    const denied = await requireStepUp(services, context);
    if (denied) return denied;
    const secret = newTotpSecret();
    vault.set(SECRET.totpPending, secret);
    return context.json({ secret, uri: otpauthUri(secret, "owner") });
  });

  app.post("/security/totp/confirm", async (context) => {
    const body = await readJson<{ code: string }>(context);
    const pending = vault.get(SECRET.totpPending);
    if (!pending) return fail(context, 400, "invalid", "Start the enrolment first");
    const totp = checkTotp(services, pending, body.code ?? "");
    if (!totp.ok) return fail(context, 400, "bad_totp", "That code is not valid");
    acceptTotp(services, totp.step);
    vault.set(SECRET.totp, pending);
    vault.delete(SECRET.totpPending);
    return context.json(snapshot(currentSessionId(context)));
  });

  app.delete("/security/totp", async (context) => {
    // Turning the second factor off is itself a privileged act, so it needs the
    // access code and a current code rather than just a live session.
    const body = await readJson<{ code: string }>(context);
    const denied = await requireStepUp(services, context, body.code ?? "");
    if (denied) return denied;
    vault.delete(SECRET.totp);
    vault.delete(SECRET.totpPending);
    return context.json(snapshot(currentSessionId(context)));
  });

  // Revoking is how someone else would push the owner off their own server, so
  // it is confirmed like the credentials are.
  app.delete("/security/sessions/:id", async (context) => {
    const denied = await requireStepUp(services, context);
    if (denied) return denied;
    store.deleteSession(context.req.param("id"));
    return context.json(snapshot(currentSessionId(context)));
  });

  app.post("/security/sessions/revoke-others", async (context) => {
    const denied = await requireStepUp(services, context);
    if (denied) return denied;
    const current = currentSessionId(context);
    store.deleteAllSessions(current);
    return context.json(snapshot(current));
  });

  return app;
}
