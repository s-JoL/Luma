/**
 * Profiles: the named bundle a conversation runs under — models, capabilities,
 * MCP servers, prompts (`08-generation.md §Profiles`).
 *
 * Deleting the last profile is allowed. A deployment with none behaves exactly
 * as it did before profiles existed, which is what makes the whole feature inert
 * until someone uses it.
 */
import { Hono } from "hono";
import type { Profile, ProfileInput } from "@shared/types.ts";
import type { Services } from "../../services.ts";
import { readJson } from "../body.ts";
import { fail } from "../errors.ts";

const slug = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `profile-${Date.now()}`;

export function profileRoutes(services: Services) {
  const app = new Hono();
  const { store, config } = services;

  app.get("/profiles", (context) =>
    context.json({ items: store.listProfiles(), defaultProfileId: config.defaultProfileId() }),
  );

  app.post("/profiles", async (context) => {
    const body = await readJson<ProfileInput>(context);
    if (!body.name?.trim()) return fail(context, 400, "invalid", "name is required");
    const id = body.id ? slug(body.id) : slug(body.name);
    if (store.getProfile(id)) return fail(context, 409, "conflict", `Profile ${id} already exists`);
    const profile = store.upsertProfile({ ...body, id, name: body.name.trim() });
    return context.json(profile, 201);
  });

  app.patch("/profiles/:id", async (context) => {
    const id = context.req.param("id");
    const existing = store.getProfile(id);
    if (!existing) return fail(context, 404, "not_found", "Profile not found");
    const body = await readJson<ProfileInput>(context);
    return context.json(store.upsertProfile({ ...body, id, name: body.name?.trim() || existing.name }));
  });

  app.delete("/profiles/:id", (context) => {
    const id = context.req.param("id");
    if (!store.getProfile(id)) return fail(context, 404, "not_found", "Profile not found");
    store.deleteProfile(id);
    if (config.defaultProfileId() === id) config.setDefaultProfileId("");
    return context.body(null, 204);
  });

  app.put("/profiles/default", async (context) => {
    const body = await readJson<{ profileId: string }>(context);
    const id = body.profileId ?? "";
    if (id && !store.getProfile(id)) return fail(context, 404, "not_found", "Profile not found");
    config.setDefaultProfileId(id);
    return context.json({ defaultProfileId: config.defaultProfileId() });
  });

  return app;
}

export type { Profile };
