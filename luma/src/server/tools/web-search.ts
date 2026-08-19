import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { COUNTRY_DESCRIPTION, INTENT_DESCRIPTION, QUERY_DESCRIPTION, WEB_SEARCH_DESCRIPTION } from "./descriptions.ts";

export interface WebRow {
  title: string;
  url: string;
  content: string;
  published_date?: string;
  source: string;
}

/** One call to a search backend: the tool's arguments, already validated. */
export interface WebSearchQuery {
  query: string;
  topic: "general" | "news";
  /** Ask for image results alongside the text ones. */
  images: boolean;
  maxResults: number;
  /** Date range as the schema spells it: `h`, `d`, `w`, `m` or `y`. */
  date?: string;
  country?: string;
}

export interface WebSearchContext {
  apiKey: string;
  signal?: AbortSignal;
}

export interface WebSearchResult {
  rows: WebRow[];
  /** Whatever the backend calls an image result, passed through untouched. */
  images: unknown[];
}

/**
 * One interface for everything that answers a query, mirroring the generation
 * adapters (`src/server/generation/`). A second backend — Brave, SearXNG, Exa,
 * an OpenAI-compatible search relay — is one object registered in `ADAPTERS`,
 * because everything above this line is the tool's schema and output format,
 * which `03-tools.md §1` fixes regardless of who answers.
 */
export interface WebSearchAdapter {
  /** Matches `capabilities.web.provider`, so the configuration names its adapter. */
  readonly id: string;
  /** False for a self-hosted backend that authenticates by being reachable. */
  readonly requiresKey: boolean;
  search(query: WebSearchQuery, ctx: WebSearchContext): Promise<WebSearchResult>;
}

const hostname = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const toRow = (item: Record<string, unknown>): WebRow => ({
  title: String(item.title ?? ""),
  url: String(item.url ?? ""),
  content: String(item.content ?? ""),
  published_date: item.published_date as string | undefined,
  source: hostname(String(item.url ?? "")),
});

const TAVILY_URL = process.env.TAVILY_SEARCH_URL || "https://api.tavily.com/search";

function normalizeDateRange(value?: string) {
  if (value == null) return undefined;
  return ({ h: "day", d: "day", w: "week", m: "month", y: "year" } as Record<string, string>)[value];
}

/**
 * Tavily wants a country's English name where the schema asks for a code, so a
 * code is expanded through Intl and anything else is passed along as written.
 *
 * There used to be a patch table underneath this — `uk`, `cz`, `tr` and five
 * more spelled the way Tavily happened to spell them. It was eight countries
 * out of two hundred, which is not a mapping so much as a record of which ones
 * someone had tried. The model already knows what a country is called; if it
 * writes the name, that name is what gets sent.
 */
function normalizeTavilyCountry(value?: string) {
  const country = value?.trim().toLowerCase();
  if (!country) return undefined;
  if (!/^[a-z]{2}$/.test(country)) return country;
  return new Intl.DisplayNames(["en"], { type: "region" }).of(country.toUpperCase())?.toLowerCase() ?? country;
}

const tavilyAdapter: WebSearchAdapter = {
  id: "tavily",
  requiresKey: true,
  async search(query, ctx) {
    const payload: Record<string, unknown> = {
      query: query.query,
      search_depth: "basic",
      topic: query.topic,
      max_results: query.maxResults,
    };
    const timeRange = normalizeDateRange(query.date);
    if (timeRange) payload.time_range = timeRange;
    const country = query.topic === "general" ? normalizeTavilyCountry(query.country) : undefined;
    if (country) payload.country = country;
    if (query.images) payload.include_images = true;

    const ask = async () =>
      fetch(TAVILY_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ctx.apiKey}` },
        body: JSON.stringify(payload),
        signal: ctx.signal,
      });

    let response = await ask();
    // Tavily validates `country` against its own spelling of the world, and
    // an exact table of its spellings is the thing this tool deliberately
    // does not keep. So a rejected request is retried without the filter:
    // results for the wrong country beat no results and an opaque 4xx.
    if (!response.ok && response.status < 500 && payload.country) {
      delete payload.country;
      response = await ask();
    }
    if (!response.ok) throw new Error(`Web search failed (${response.status})`);
    const data = (await response.json()) as { results?: Array<Record<string, unknown>>; images?: unknown[] };
    return { rows: (data.results ?? []).map(toRow), images: data.images ?? [] };
  },
};

const ADAPTERS = new Map<string, WebSearchAdapter>([tavilyAdapter].map((adapter) => [adapter.id, adapter]));

/** The adapter a deployment gets when its configuration names none, or names one that is gone. */
const DEFAULT_PROVIDER = "tavily";

function formatWebResults(turn: number, rows: WebRow[], sourceType: "search" | "news") {
  if (!rows.length) return "";
  const title = sourceType === "search" ? `Web Results, Turn ${turn}` : "News Results";
  const formatted = rows.map((row, index) => {
    const lines = [
      `# ${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)} ${index}: ${row.title ? `"${row.title}"` : "(no title)"}`,
      `\nAnchor: \\ue202turn${turn}${sourceType}${index}`,
      `URL: ${row.url}`,
    ];
    if (row.content != null) lines.push(`Summary: ${row.content}`);
    if (row.published_date != null) lines.push(`Date: ${row.published_date}`);
    if (row.source != null) lines.push(`Source: ${row.source}`);
    return `${lines.join("\n")}\n`;
  });
  return `\n=== ${title} ===\n\n${formatted.join("\n")}`;
}

export function webSearchTool(getApiKey: () => string | undefined, provider = DEFAULT_PROVIDER): AgentTool {
  let turnCounter = 0;
  return {
    name: "web_search",
    label: "web_search",
    description: WEB_SEARCH_DESCRIPTION,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        intent: { type: "string", description: INTENT_DESCRIPTION },
        query: { type: "string", description: QUERY_DESCRIPTION },
        date: { type: "string", enum: ["h", "d", "w", "m", "y"], description: "Date range for search results." },
        country: { type: "string", description: COUNTRY_DESCRIPTION },
        images: { type: "boolean", description: "Whether to also run an image search." },
        news: { type: "boolean", description: "Whether to also run a news search." },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "How many results to read. Defaults to 5; raise it for a survey, lower it for a single fact.",
        },
      },
      required: ["intent", "query"],
    }),
    execute: async (_callId, params, signal) => {
      const args = params as {
        query: string;
        date?: string;
        country?: string;
        images?: boolean;
        news?: boolean;
        max_results?: number;
      };
      const turn = turnCounter++;
      const adapter = ADAPTERS.get(provider) ?? ADAPTERS.get(DEFAULT_PROVIDER)!;
      const apiKey = getApiKey();
      if (adapter.requiresKey && !apiKey) {
        throw new Error(`Web search is selected but the ${adapter.id} API key is not configured`);
      }

      const maxResults = Math.max(1, Math.min(20, Math.round(args.max_results ?? 5)));
      const ctx: WebSearchContext = { apiKey: apiKey ?? "", signal };
      const asked = { query: args.query, maxResults, date: args.date, country: args.country };

      // LibreChat always runs the general search, then adds independent
      // image/news searches when those booleans are requested. Its `videos`
      // flag is not offered here: no backend in the registry has a video
      // sub-search, and a parameter that returns nothing without saying so is
      // worse than absent.
      const tasks = [adapter.search({ ...asked, topic: "general", images: false }, ctx)];
      if (args.images === true) tasks.push(adapter.search({ ...asked, topic: "general", images: true }, ctx));
      if (args.news === true) tasks.push(adapter.search({ ...asked, topic: "news", images: false }, ctx));
      const [main, ...supplemental] = await Promise.all(tasks);
      const rows = main?.rows ?? [];
      const imageData = args.images === true ? supplemental.shift() : undefined;
      const newsData = args.news === true ? supplemental.shift() : undefined;
      const seenNews = new Set<string>();
      const newsRows = (newsData?.rows ?? [])
        .filter((row) => row.url && !seenNews.has(row.url) && seenNews.add(row.url))
        .slice(0, maxResults);

      const output = `${formatWebResults(turn, rows, "search")}${formatWebResults(turn, newsRows, "news")}`;
      const references = [
        ...rows.map((row) => ({ type: "search", link: row.url, title: row.title })),
        ...newsRows.map((row) => ({ type: "news", link: row.url, title: row.title })),
      ];
      return {
        content: [{ type: "text", text: output || `No results found for query: ${args.query}` }],
        details: {
          structuredContent: {
            web_search: {
              turn,
              organic: rows.map((row) => ({
                title: row.title,
                link: row.url,
                snippet: row.content,
                date: row.published_date,
              })),
              topStories: newsRows.map((row) => ({
                title: row.title,
                link: row.url,
                snippet: row.content,
                date: row.published_date,
                source: row.source,
              })),
              images: (imageData?.images ?? []).slice(0, 6),
              videos: [],
              references,
            },
          },
        },
      };
    },
  };
}
