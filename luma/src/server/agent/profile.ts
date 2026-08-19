/**
 * What a conversation runs under (`08-generation.md §Profiles`).
 *
 * A profile *selects* from the deployment's configuration; it never re-states it.
 * Turning a capability on where the deployment has not configured it does
 * nothing, which is the rule the global switches already followed.
 *
 * With no profiles at all this resolves to exactly the old behaviour, so the
 * feature is inert until someone uses it. Generation models still fall back to
 * the first enabled one: adding an image model and finding the agent unable to
 * draw with it would be a dead end, not a safeguard.
 */
import type { Capabilities, ModelSpec, Profile, PromptSettings } from "@shared/types.ts";
import type { Config } from "../config.ts";
import { isRunnable, supportsOp } from "../generation/index.ts";
import type { Store } from "../store/store.ts";

export interface ResolvedProfile {
  profile?: Profile;
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
  /** Undefined means "whatever the deployment enabled", the old behaviour. */
  mcpServers?: Set<string>;
}

const enabledGeneration = (store: Store, kind: "image" | "video") =>
  store.listModels().filter((spec) => spec.enabled && spec.kind === kind && isRunnable(spec));

function pick(store: Store, id: string, kind: "image" | "video") {
  const spec = id ? store.getModel(id) : undefined;
  if (spec && spec.enabled && isRunnable(spec) && spec.kind === kind) return spec;
  return undefined;
}

export function resolveProfile(
  store: Store,
  config: Config,
  conversation: { profileId?: string },
): ResolvedProfile {
  const capabilities = config.capabilities();
  const prompts = config.prompts();
  const id = conversation.profileId || config.defaultProfileId();
  const profile = id ? store.getProfile(id) : undefined;

  const images = enabledGeneration(store, "image");
  const videos = enabledGeneration(store, "video");
  const image = pick(store, profile?.imageModelId ?? "", "image") ?? images[0];
  const edit =
    pick(store, profile?.editModelId ?? "", "image") ??
    (image && supportsOp(image, "image_to_image") ? image : images.find((spec) => supportsOp(spec, "image_to_image")));
  const video = pick(store, profile?.videoModelId ?? "", "video") ?? videos[0];
  // Sorted by id rather than by the catalogue's order, so adding an unrelated
  // model cannot reshuffle the tools and cost the provider's prompt cache.
  const extras = [...images, ...videos].filter((spec) => spec.agentTool).sort((a, b) => a.id.localeCompare(b.id));

  if (!profile) return { capabilities, prompts, image, edit, video, extraGeneration: extras };

  const gate = profile.capabilities;
  return {
    profile,
    capabilities: {
      ...capabilities,
      memory: { ...capabilities.memory, enabled: capabilities.memory.enabled && gate.memory },
      files: { ...capabilities.files, enabled: capabilities.files.enabled && gate.files },
      web: { ...capabilities.web, enabled: capabilities.web.enabled && gate.web },
      coding: gate.coding ? capabilities.coding : { ...capabilities.coding, read: false, write: false, shell: false },
    },
    prompts: {
      ...prompts,
      globalPrompt: profile.globalPrompt || prompts.globalPrompt,
      toolPrompt: profile.toolPrompt || prompts.toolPrompt,
    },
    image: gate.generation ? image : undefined,
    edit: gate.generation ? edit : undefined,
    video: gate.generation ? video : undefined,
    extraGeneration: gate.generation ? extras : [],
    mcpServers: profile.mcpServers.length ? new Set(profile.mcpServers) : undefined,
  };
}

/** Skills have no deployment switch, so the profile is the only gate. */
export const skillsAllowed = (resolved: ResolvedProfile) =>
  !resolved.profile || resolved.profile.capabilities.skills;
