import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Bootstrap } from "@shared/types.ts";
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, paths } from "../env.ts";
import type { Services } from "../services.ts";
import {
  checkLogin,
  ensureAccessCode,
  issueToken,
  loginLocked,
  overTls,
  requireAuth,
  revokeCurrent,
  totpEnabled,
  type LoginAttempt,
} from "./auth.ts";
import { readJson } from "./body.ts";
import { fail, failFromError } from "./errors.ts";
import { conversationRoutes } from "./routes/conversations.ts";
import { fileRoutes } from "./routes/files.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { memoryRoutes } from "./routes/memory.ts";
import { profileRoutes } from "./routes/profiles.ts";
import { securityRoutes } from "./routes/security.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { studioRoutes } from "./routes/studio.ts";

export const VERSION = "1.0.0";

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export function createApp(services: Services) {
  const app = new Hono();
  const api = new Hono();

  /**
   * Baseline headers for a deployment that is reachable from the internet. The
   * app serves its own bundle and talks only to itself, so the connect/img/
   * script sources can all be locked to this origin.
   */
  app.use("*", async (context, next) => {
    await next();
    const headers = context.res.headers;
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "same-origin");
    headers.set("x-frame-options", "DENY");
    headers.set(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (overTls(context)) {
      headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
  });

  api.get("/health", (context) => context.json({ ok: true, version: VERSION }));

  /** Lets the sign-in screen ask for the second factor before it is needed. */
  api.get("/auth/challenge", (context) =>
    context.json({ totpRequired: totpEnabled(services), lockedFor: loginLocked(context) }),
  );

  api.post("/auth/token", async (context) => {
    const body = await readJson<LoginAttempt>(context);
    const result = await checkLogin(services, context, body);
    if (!result.ok) {
      if (result.code === "locked") {
        return fail(
          context,
          429,
          "too_many_attempts",
          `Too many failed sign-ins. Try again in ${Math.ceil((result.retryAfter ?? 0) / 60)} minutes.`,
        );
      }
      if (result.code === "totp_required") {
        return fail(context, 401, "totp_required", "Enter the code from your authenticator");
      }
      // One message for both factors: which half was wrong is exactly what an
      // attacker wants to know and the owner can see which fields they filled.
      return fail(context, 401, result.code, "That access code or authenticator code is not correct");
    }
    return context.json(issueToken(services, context, body.deviceName ?? "web"));
  });

  api.post("/auth/logout", (context) => {
    revokeCurrent(services, context);
    return context.body(null, 204);
  });

  const guarded = new Hono();
  guarded.use("*", requireAuth(services));

  guarded.get("/bootstrap", (context) => {
    const capabilities = services.config.capabilities();
    const bootstrap: Bootstrap = {
      version: VERSION,
      models: services.store.listModels(),
      providers: services.store.listProviders(),
      defaultModelId: services.config.defaultModelId(),
      profiles: services.store.listProfiles(),
      defaultProfileId: services.config.defaultProfileId(),
      capabilities,
      mcp: services.mcp.status(),
      prompts: services.config.prompts(),
      memoryKeys: capabilities.memory.suggestedKeys,
      limits: { maxUploadBytes: MAX_UPLOAD_BYTES, maxAttachmentsPerMessage: MAX_ATTACHMENTS },
    };
    return context.json(bootstrap);
  });

  guarded.route("/", securityRoutes(services));
  guarded.route("/", conversationRoutes(services));
  guarded.route("/", settingsRoutes(services));
  guarded.route("/", fileRoutes(services));
  guarded.route("/", memoryRoutes(services));
  guarded.route("/", studioRoutes(services));
  guarded.route("/", jobRoutes(services));
  guarded.route("/", profileRoutes(services));

  api.route("/", guarded);
  app.route("/v1", api);

  app.onError((error, context) => failFromError(context, error));

  app.get("*", (context) => {
    const pathname = decodeURIComponent(new URL(context.req.url).pathname);
    if (pathname.startsWith("/v1/")) return fail(context, 404, "not_found", "Unknown endpoint");
    const candidate = path.resolve(paths.webDist, `.${pathname}`);
    const file =
      candidate.startsWith(paths.webDist) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        ? candidate
        : path.join(paths.webDist, "index.html");
    if (!fs.existsSync(file)) return context.text("Web build not found. Run npm run build.", 503);
    return new Response(new Uint8Array(fs.readFileSync(file)), {
      headers: {
        "content-type": STATIC_MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  });

  ensureAccessCode(services);
  return app;
}
