/**
 * Renders the Markdown component to HTML in Node so the assistant-text
 * pipeline can be asserted without a browser. Output is ASCII-escaped because
 * the Windows console mangles the private-use characters under test.
 *
 *   node --import tsx scripts/audit-markdown.tsx
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/web/markdown.tsx";
import { collectCitations, type Citation } from "../src/web/messages.ts";

const GROUP_START = "\ue200";
const GROUP_END = "\ue201";
const ANCHOR = "\ue202";
const HL_START = "\ue203";
const HL_END = "\ue204";

/** Keeps private-use characters legible in a console that cannot print them. */
const ascii = (value: string) =>
  value.replace(/[^\x20-\x7e]/g, (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`);

const CITED = new Map<string, Citation>([
  ["\\ue202turn0search0", { label: "sqlite.org", url: "https://sqlite.org", detail: "SQLite Release Notes" }],
  ["\\ue202turn0news1", { label: "example.com", url: "https://example.com", detail: "Example" }],
]);

const cases: Array<[string, string, Map<string, Citation>]> = [
  [
    "reported repro (real PUA group block around two links)",
    `**\u4e94\u56fe\u5361\u70b9\uff1a**\u5f00\u95e8\u5165\u51ac \u2192 \u6e05\u70b9\u5b58\u8d27 \u2192 \u84b8\u6c7d\u91cc\u542c\u89c1\u811a\u6b65 \u95f4\u8eba\u5e73\u3001\u57fa\u5efa\u79cd\u7530\u3002${GROUP_START}[youtube.com](https://www.youtube.com/watch?v=vdhFs--IObE)[bilibili.com](https://www.bilibili.com/video/BV1kPAazDEkC)${GROUP_END}`,
    new Map(),
  ],
  ["escaped-form anchors, known citations", `Fact one.\\ue202turn0search0 Group.\\ue200\\ue202turn0search0\\ue202turn0news1\\ue201`, CITED],
  ["codepoint-form anchors, known citations", `Fact one.${ANCHOR}turn0search0 Group.${GROUP_START}${ANCHOR}turn0search0${ANCHOR}turn0news1${GROUP_END}`, CITED],
  ["unknown anchors must not leak", `No source.${ANCHOR}turn9search9 and \\ue202turn9file9`, new Map()],
  ["highlight markers", `${HL_START}Quoted sentence.${HL_END}${ANCHOR}turn0search0`, CITED],
  ["CJK bold with fullwidth colon", "**\u4e94\u56fe\u5361\u70b9\uff1a**\u5f00\u95e8\u5165\u51ac", new Map()],
  ["CJK bold, no spaces", "**\u5173\u952e**\u5185\u5bb9", new Map()],
  ["GFM table", "| A | B |\n| --- | --- |\n| 1 | 2 |", new Map()],
  ["GFM strikethrough + tasks", "~~gone~~\n\n- [x] done\n- [ ] todo", new Map()],
  ["backslash math", "inline \\(E=mc^2\\) and block:\n\n\\[\n\\int_0^1 x^2 dx\n\\]", new Map()],
  ["dollar math", "inline $a^2+b^2=c^2$", new Map()],
  ["prices must not become math", "It costs $5 to $10 today.", new Map()],
  ["streaming: unterminated bold", "writing **bold in progress", new Map()],
  ["streaming: unterminated fence", "code:\n\n```ts\nconst a = 1;", new Map()],
  ["streaming: unterminated inline code", "value is `foo", new Map()],
  ["streaming: unterminated link", "see [the docs", new Map()],
  ["image ref", "![out](image://img_0123456789abcdef0123456789abcdef)", new Map()],
  ["consecutive links", "[a.com](https://a.com)[b.com](https://b.com)", new Map()],
];

const render = (text: string, citations: Map<string, Citation>, streaming: boolean) => {
  try {
    return renderToStaticMarkup(createElement(Markdown, { text, citations, streaming }));
  } catch (error) {
    return `RENDER THREW: ${error instanceof Error ? error.message : String(error)}`;
  }
};

let failures = 0;
for (const [name, text, citations] of cases) {
  const html = render(text, citations, false);
  const puaLeak = [...html].some((char) => char >= "\ue000" && char <= "\uf8ff");
  const escapedLeak = /\\ue2[0-9a-f]{2}/i.test(html);
  if (puaLeak || escapedLeak) failures += 1;
  console.log(`\n### ${name}`);
  console.log(`in  : ${ascii(text)}`);
  console.log(`out : ${ascii(html)}`);
  if (puaLeak || escapedLeak) console.log(`LEAK: pua=${puaLeak} escaped=${escapedLeak}`);
  if (name.startsWith("streaming:")) console.log(`live: ${ascii(render(text, citations, true))}`);
}

// A delta-by-delta replay: the settled render must never lose characters and
// the live render must never show a delimiter that has not closed yet.
console.log("\n### incremental replay (streaming=true)");
const stream = "写代码 **重点：**看这里 `npm run build` 和 [链接](https://a.com) 结束。";
for (let cut = 1; cut <= stream.length; cut += 1) {
  const partial = stream.slice(0, cut);
  const html = render(partial, new Map(), true);
  const bare = html.replace(/<[^>]*>/g, "");
  if (/\*\*|~~|`|(?<!\])\[(?![^\]]*\]\()/.test(bare)) {
    failures += 1;
    console.log(`  raw delimiter visible at ${cut}: ${ascii(bare)}`);
  }
}
console.log(`  replayed ${stream.length} prefixes`);

const toolOutput = [
  '# Search 0: "SQLite Release Notes"',
  "",
  "Anchor: \\ue202turn0search0",
  "URL: https://sqlite.org/changes.html",
  "Summary: latest release",
].join("\n");
console.log("\n### collectCitations over a real web_search block");
console.log(
  ascii(
    JSON.stringify([
      ...collectCitations([
        {
          id: "t",
          seq: 0,
          role: "assistant",
          parts: [{ kind: "tool", callId: "c", name: "web_search", args: {}, result: toolOutput, isError: false, running: false }],
        },
      ]),
    ]),
  ),
);

console.log(`\n${failures} case(s) leaked citation markers.`);
if (failures) process.exit(1);
