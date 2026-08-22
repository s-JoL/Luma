/**
 * Which generation backends a conversation actually calls.
 *
 * Chat, capabilities, MCP and prompts are deployment settings. This file only
 * answers the three generation slots the agent tools and the studio need.
 *
 * An unbound slot still fills from the catalogue — adding an image model and
 * finding the agent unable to draw would be a dead end — preferring a keyed
 * hosted backend over local Comfy.
 */
import type { Capabilities, ModelSpec, PromptSettings } from "@shared/types.ts";
import type { Config } from "../config.ts";
import { isRunnable, supportsOp } from "../generation/index.ts";
import type { Store } from "../store/store.ts";

export interface ResolvedGeneration {
  capabilities: Capabilities;
  prompts: PromptSettings;
  image?: ModelSpec;
  edit?: ModelSpec;
  video?: ModelSpec;
  /**
   * Generation models flagged to reach the agent under their own names, beside
   * the three above. Empty unless someone asked for it, so the tool list — and
   * with it the cached prefix of every request — is unchanged by default.
   */
  extraGeneration: ModelSpec[];
}

const enabledGeneration = (store: Store, kind: "image" | "video") =>
  store
    .listModels()
    .filter((spec) => spec.enabled && spec.configured !== false && spec.kind === kind && isRunnable(spec));

/** Comfy is always configured. Prefer a hosted backend that actually has a key. */
function preferReady(specs: ModelSpec[]) {
  return (
    specs.find((spec) => spec.apiMode !== "comfy-workflow" && spec.configured !== false) ??
    specs.find((spec) => spec.apiMode === "comfy-workflow") ??
    specs[0]
  );
}

function pick(store: Store, id: string, kind: "image" | "video") {
  const spec = id ? store.getModel(id) : undefined;
  if (!spec || !spec.enabled || !isRunnable(spec) || spec.kind !== kind) return undefined;
  // A hosted row with no key is not a choice, it is a broken binding.
  if (spec.apiMode !== "comfy-workflow" && spec.configured === false) return undefined;
  return spec;
}

export function resolveGeneration(store: Store, config: Config): ResolvedGeneration {
  const capabilities = config.capabilities();
  const prompts = config.prompts();
  const defaults = config.generationDefaults();

  const images = enabledGeneration(store, "image");
  const videos = enabledGeneration(store, "video");
  const image = pick(store, defaults.imageModelId, "image") ?? preferReady(images);
  const edit =
    pick(store, defaults.editModelId, "image") ??
    (image && supportsOp(image, "image_to_image") ? image : images.find((spec) => supportsOp(spec, "image_to_image")));
  const video = pick(store, defaults.videoModelId, "video") ?? preferReady(videos);
  // Sorted by id rather than by the catalogue's order, so adding an unrelated
  // model cannot reshuffle the tools and cost the provider's prompt cache.
  const extras = [...images, ...videos].filter((spec) => spec.agentTool).sort((a, b) => a.id.localeCompare(b.id));

  return { capabilities, prompts, image, edit, video, extraGeneration: extras };
}
