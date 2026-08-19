import { createModels, createProvider, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { isChatKind, type ApiMode, type ModelSpec, type Provider } from "@shared/types.ts";
import { SECRET } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import type { Store } from "../store/store.ts";
import { providerAuth, providerCredential } from "./auth.ts";

function apiFor(mode: ApiMode) {
  if (mode === "openai-responses") return openAIResponsesApi();
  if (mode === "anthropic-messages") return anthropicMessagesApi();
  return openAICompletionsApi();
}

/**
 * Fills in Anthropic capabilities that depend on the model rather than the
 * gateway serving it.
 *
 * Claude's `thinking: { type: "enabled" }` is deprecated in favour of
 * `"adaptive"`, and pi-ai picks the format from `compat.forceAdaptiveThinking`.
 * Its own catalog sets that flag, but a model reached through a third-party
 * gateway is built from Luma's database row and so inherits none of it — which
 * is why Opus 4.6 kept sending the deprecated shape. Looking the flag up by the
 * upstream model id fixes every Claude model behind every gateway at once,
 * including ones added later, and an explicit value in the row still wins so a
 * gateway that lags upstream can opt out.
 */
function anthropicCompat(spec: ModelSpec): Record<string, unknown> | undefined {
  const configured = spec.compat ?? undefined;
  if (spec.apiMode !== "anthropic-messages") return configured;
  if (configured && "forceAdaptiveThinking" in configured) return configured;
  const builtin = getBuiltinModel("anthropic", spec.model as never) as { compat?: Record<string, unknown> } | undefined;
  const adaptive = builtin?.compat?.forceAdaptiveThinking;
  if (adaptive === undefined) return configured;
  return { ...configured, forceAdaptiveThinking: adaptive };
}

/**
 * pi-ai binds one wire protocol per provider, but a gateway usually serves
 * several from the same base URL, so each (provider, protocol) pair is
 * registered separately.
 */
const runtimeId = (providerId: string, mode: ApiMode) => `${providerId}::${mode}`;

export interface ResolvedModel {
  spec: ModelSpec;
  provider: Provider;
  model: Model<never>;
}

/**
 * Builds the pi-ai provider graph from the database. Rebuilt (cheaply) after
 * any settings write so a saved API key or new model takes effect without a
 * restart.
 */
export class ModelRegistry {
  private models: MutableModels = createModels();
  private specs = new Map<string, ModelSpec>();
  private providers = new Map<string, Provider>();

  constructor(
    private readonly store: Store,
    private readonly vault: SecretVault,
  ) {
    this.reload();
  }

  reload() {
    const models = createModels();
    const providers = this.store.listProviders();
    // Generation models live in the same table but go through a generation
    // adapter, not pi-ai, so they never enter the provider graph.
    const specs = this.store.listModels().filter((spec) => spec.enabled && isChatKind(spec.kind));
    this.specs = new Map(specs.map((spec) => [spec.id, spec]));
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    for (const provider of providers) {
      if (!provider.enabled) continue;
      const modes = new Set(
        specs.filter((spec) => spec.providerId === provider.id).map((spec) => spec.apiMode),
      );
      for (const mode of modes) this.register(models, provider, mode, specs);
    }
    this.models = models;
  }

  private register(models: MutableModels, provider: Provider, mode: ApiMode, specs: ModelSpec[]) {
    const owned = specs.filter((spec) => spec.providerId === provider.id && spec.apiMode === mode);
    if (!owned.length) return;
    // OpenAI-style gateways expect the version in the base URL, while the
    // Anthropic client appends `/v1/messages` itself. One gateway usually
    // serves both from the same host, so the stored URL is normalised here.
    const trimmed = provider.baseUrl.replace(/\/+$/, "");
    const baseUrl = mode === "anthropic-messages" ? trimmed.replace(/\/v1$/, "") : trimmed;
    const providerModels = owned.map((spec) => ({
      id: spec.model,
      name: spec.name,
      api: mode,
      provider: runtimeId(provider.id, mode),
      baseUrl,
      reasoning: spec.reasoning,
      thinkingLevelMap: spec.thinkingLevelMap ?? undefined,
      input: spec.input,
      cost: {
        input: spec.pricing?.input ?? 0,
        output: spec.pricing?.output ?? 0,
        cacheRead: spec.pricing?.cacheRead ?? 0,
        cacheWrite: spec.pricing?.cacheWrite ?? 0,
      },
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
      compat: anthropicCompat(spec),
    }));
    const vault = this.vault;
    const auth = providerAuth(provider);
    models.setProvider(
      createProvider({
        id: runtimeId(provider.id, mode),
        name: provider.name,
        baseUrl,
        auth: {
          apiKey: {
            name: `${provider.name} API key`,
            resolve: async () => providerCredential(auth, vault.get(SECRET.provider(provider.id))),
          },
        },
        models: providerModels as never,
        api: apiFor(mode) as never,
      }),
    );
  }

  get runtime() {
    return this.models;
  }

  /**
   * pi-ai retries nothing by default, so a single 502 from a gateway ends a run
   * that would have succeeded on the next attempt. Shared gateways return those
   * often enough that the retry budget belongs here, in front of every caller,
   * rather than at each call site. Only pi-ai's own retryable classification
   * qualifies, so a 400 or an auth failure still fails immediately.
   *
   * `maxRetryDelayMs` is deliberately left at pi-ai's 60s default. It does not
   * cap our backoff — it caps what a provider is allowed to ask for, and
   * `validateServerRetryDelayMs` throws past it, so lowering it turned a 429
   * whose `Retry-After` said ten seconds into a failed run.
   */
  streamSimple = ((model, context, options) =>
    this.models.streamSimple(model, context, {
      maxRetries: 3,
      ...options,
    })) as MutableModels["streamSimple"];

  list(): ModelSpec[] {
    return this.store.listModels();
  }

  resolve(id?: string): ResolvedModel {
    const specId = id && this.specs.has(id) ? id : "";
    const spec = specId ? this.specs.get(specId)! : undefined;
    if (!spec) throw new Error(`Unknown or disabled model: ${id ?? "(none)"}`);
    const provider = this.providers.get(spec.providerId);
    if (!provider) throw new Error(`Model ${spec.name} has no provider`);
    // A local server that authenticates nobody has no key to be missing, so the
    // check is on what the provider says it needs rather than on there being one.
    if (!provider.hasKey && providerAuth(provider).style !== "none") {
      throw new Error(`${provider.name} has no API key configured`);
    }
    const model = this.models.getModel(runtimeId(provider.id, spec.apiMode), spec.model);
    if (!model) throw new Error(`Model is unavailable: ${spec.name}`);
    return { spec, provider, model: model as Model<never> };
  }
}
