/**
 * Search adapters against a fake SearXNG, so adding a backend cannot silently
 * leave the tool talking only to Tavily.
 *
 *   node --import tsx scripts/audit-search.ts
 */
import http from "node:http";
import { SEARCH_PROVIDERS } from "../src/shared/types.ts";
import { webSearchTool } from "../src/server/tools/web-search.ts";

let failures = 0;

async function check(name: string, run: () => Promise<string | void> | string | void) {
  try {
    const note = await run();
    console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const listen = (server: http.Server) =>
  new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

const searx = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://searx");
  const hits = [
    { title: "One", url: "https://example.com/one", content: "first hit", publishedDate: "2026-01-01" },
    { title: "Two", url: "https://example.com/two", content: "second hit" },
  ];
  const images = [{ title: "Pic", url: "https://example.com/pic", img_src: "https://cdn.example/a.png", thumbnail_src: "https://cdn.example/a-t.png" }];
  const category = url.searchParams.get("categories");
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ results: category === "images" ? images : hits }));
});

const baseUrl = await listen(searx);

await check("the registry names every adapter the settings page offers", () => {
  assert(SEARCH_PROVIDERS.some((item) => item.id === "tavily" && item.requiresKey), "tavily missing");
  assert(SEARCH_PROVIDERS.some((item) => item.id === "searxng" && !item.requiresKey), "searxng missing");
  return SEARCH_PROVIDERS.map((item) => item.id).join(", ");
});

await check("searxng answers without a key", async () => {
  const tool = webSearchTool({ getApiKey: () => undefined, provider: "searxng", baseUrl });
  const result = (await tool.execute!("c1", { intent: "look up", query: "luma" }, undefined as never)) as {
    content: Array<{ text: string }>;
  };
  const text = result.content[0]?.text ?? "";
  assert(text.includes("example.com/one"), `no hit in:\n${text}`);
  assert(text.includes("first hit"), "snippet missing");
  return "two organic results, no API key";
});

await check("an unknown provider fails visibly instead of changing providers", async () => {
  const tool = webSearchTool({ getApiKey: () => undefined, provider: "not-a-backend" });
  await tool
    .execute!("c2", { intent: "look up", query: "x" }, undefined as never)
    .then(() => {
      throw new Error("missing key was not reported");
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert(/unknown web search provider: not-a-backend/i.test(message), `unexpected error: ${message}`);
    });
  return "unknown id rejected";
});

searx.close();
console.log(failures ? `\n${failures} search check(s) failed` : "\nall search checks passed");
process.exit(failures ? 1 : 0);
