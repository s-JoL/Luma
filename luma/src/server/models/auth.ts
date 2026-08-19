/**
 * How a provider presents its credential.
 *
 * `Authorization: Bearer <key>` is what almost every OpenAI-compatible endpoint
 * wants and stays the default, so an existing provider row behaves exactly as
 * it did. It is not universal: relay stations and Azure-shaped gateways read a
 * custom header (`x-api-key`, `api-key`), and a self-hosted Ollama, llama.cpp
 * or vLLM wants no credential at all. The style is therefore data on the
 * provider record, not a branch keyed on a vendor name or a hostname.
 *
 * The style rides on the provider row as JSON, so it is whatever was written
 * into `providers.auth` rather than something this code can trust: it is read
 * defensively and anything unrecognised resolves to `bearer`.
 */
import type { ModelAuth } from "@earendil-works/pi-ai";
import type { Provider, ProviderAuthConfig } from "@shared/types.ts";

const BEARER: ProviderAuthConfig = { style: "bearer" };

/**
 * pi-ai refuses to build a client with neither an API key nor an authorization
 * header, so a keyless endpoint is handed a placeholder and the headers it
 * would have gone into are suppressed. `null` deletes a header rather than
 * sending the word, so the request leaves with no credential on it at all.
 */
const KEYLESS = "unused";
const SUPPRESSED: Record<string, string | null> = { authorization: null, "x-api-key": null };

/** The style declared on a provider record, or `bearer` when it declares none. */
export function providerAuth(provider: Provider): ProviderAuthConfig {
  const declared: unknown = provider.auth;
  if (!declared || typeof declared !== "object") return BEARER;
  const record = declared as Record<string, unknown>;
  if (record.style === "none") return { style: "none" };
  if (record.style === "header") {
    const header = typeof record.header === "string" ? record.header.trim() : "";
    // A header style that names no header is a half-finished edit, not an
    // instruction to send the key nowhere.
    if (!header) return BEARER;
    return { style: "header", header, prefix: typeof record.prefix === "string" ? record.prefix : "" };
  }
  return BEARER;
}

/** What pi-ai should put on the request, or nothing when the key is missing. */
export function providerCredential(
  config: ProviderAuthConfig,
  key: string | undefined,
): { auth: ModelAuth; source: string } | undefined {
  if (config.style === "none") return { auth: { apiKey: KEYLESS, headers: SUPPRESSED }, source: "no authentication" };
  if (!key) return undefined;
  if (config.style === "header" && config.header) {
    return {
      auth: { apiKey: key, headers: { ...SUPPRESSED, [config.header]: `${config.prefix ?? ""}${key}` } },
      source: "Luma settings",
    };
  }
  return { auth: { apiKey: key }, source: "Luma settings" };
}
