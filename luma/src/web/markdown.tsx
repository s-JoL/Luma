import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CITATION_MARKUP_PATTERN, CITATION_PATTERN, citationKey, type Citation } from "./messages.ts";

const CITE_SCHEME = "luma-cite:";

/** A source chip: small, quiet, and never breaking the line it sits in. */
const CITE =
  "mx-0.5 inline-flex max-w-50 items-center truncate rounded-full border bg-secondary px-1.5 " +
  "align-baseline text-xs text-muted-foreground no-underline hover:text-foreground";

/**
 * KaTeX and its stylesheet are the single heaviest thing the web app can load,
 * and most conversations never contain a formula. Both are pulled in the first
 * time a message looks like it has math; that message renders its source text
 * for one frame and then re-renders typeset.
 */
type RehypePlugins = NonNullable<Options["rehypePlugins"]>;

let katexPlugins: RehypePlugins | null = null;
let katexLoading: Promise<void> | null = null;

function loadKatex() {
  katexLoading ??= Promise.all([import("rehype-katex"), import("katex/dist/katex.min.css")]).then(
    ([rehypeKatex]) => {
      katexPlugins = [[rehypeKatex.default, { throwOnError: false, output: "html" }]];
    },
  );
  return katexLoading;
}

/**
 * Warms the KaTeX chunk while the reader is idle. Without this the first
 * formula of a session renders as its own source for a frame and then reflows
 * once typesetting lands, which is very visible mid-stream.
 */
export function prefetchKatex() {
  const idle = globalThis.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1500));
  idle(() => void loadKatex());
}

/** Fenced blocks and inline code, captured so `split` keeps them as odd entries. */
const CODE_SPANS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

/** The same, but an inline span must hold something — see `maskIncompleteTail`. */
const STREAM_CODE_SPANS = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

/** Applies a rewrite to prose only, leaving fenced blocks and code spans intact. */
function outsideCode(text: string, rewrite: (chunk: string) => string) {
  return text
    .split(CODE_SPANS)
    .map((chunk, index) => (index % 2 ? chunk : rewrite(chunk)))
    .join("");
}

/**
 * Most models write display math as `\[…\]` and inline math as `\(…\)`, but
 * remark-math only reads dollar delimiters — and Markdown treats a backslash
 * before a bracket as an escape, so an untouched formula renders as bare
 * parentheses. Rewriting to dollars before parsing is what makes those
 * formulas typeset at all. Code spans keep their backslashes.
 */
function normalizeMath(text: string) {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  return outsideCode(text, (chunk) =>
    chunk
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `$$${body}$$`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$${body}$`),
  );
}

/** A backslash command, superscript, subscript, brace or relation. */
const MATH_SIGNAL = /[\\^_{}=]/;

/**
 * remark-math treats every `$…$` pair as inline math, which silently eats the
 * prose in "costs $5 to $10". Only spans that carry a math signal — or that are
 * a short unbroken symbol run like `$x$` — are left for it; the rest have their
 * dollars escaped back into literal currency.
 */
function guardCurrency(text: string) {
  if (!text.includes("$")) return text;
  return outsideCode(text, (chunk) =>
    chunk.replace(/(?<![\\$])\$([^$\n]{1,200})\$(?!\$)/g, (whole, inner: string) =>
      MATH_SIGNAL.test(inner) || (!/\s/.test(inner) && inner.length <= 40) ? whole : `\\$${inner}\\$`,
    ),
  );
}

/** remark-math only reacts to dollar delimiters, so nothing else can need KaTeX. */
function looksLikeMath(text: string) {
  return text.includes("$");
}

/**
 * CommonMark refuses to close a `**` run when the character before it is
 * punctuation and the character after it is a letter, so the extremely common
 * Chinese heading form `**五图卡点：**开门` parses as literal asterisks. Any
 * `**…**` still sitting in a text node after parsing is exactly that case, so
 * it is promoted to `strong` here rather than shown raw.
 */
const LITERAL_STRONG = /\*\*(?![\s*])((?:[^*\n]|\*(?!\*))+?)(?<![\s*])\*\*/g;

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

function splitLiteralStrong(value: string): MdastNode[] | null {
  LITERAL_STRONG.lastIndex = 0;
  let match = LITERAL_STRONG.exec(value);
  if (!match) return null;

  const parts: MdastNode[] = [];
  let cursor = 0;
  while (match) {
    if (match.index > cursor) parts.push({ type: "text", value: value.slice(cursor, match.index) });
    parts.push({ type: "strong", children: [{ type: "text", value: match[1]! }] });
    cursor = match.index + match[0].length;
    match = LITERAL_STRONG.exec(value);
  }
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
  return parts;
}

/**
 * Two prose repairs that both need a parsed tree: promoting the literal `**`
 * runs above, and separating sources a model wrote back to back. Grouped
 * citations arrive as `[youtube.com](…)[bilibili.com](…)` with nothing between
 * them, which renders as one run-on word.
 */
function remarkProseFixups() {
  const walk = (node: MdastNode) => {
    if (!node.children) return;
    const rebuilt: MdastNode[] = [];
    let changed = false;
    for (const child of node.children) {
      if (child.type === "text") {
        const split = splitLiteralStrong(child.value ?? "");
        if (split) changed = true;
        rebuilt.push(...(split ?? [child]));
        continue;
      }
      walk(child);
      if (rebuilt.at(-1)?.type === "link" && child.type === "link") {
        rebuilt.push({ type: "text", value: " " });
        changed = true;
      }
      rebuilt.push(child);
    }
    if (changed) node.children = rebuilt;
  };
  return walk;
}

const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkProseFixups];

/**
 * While a message is still streaming its last delimiter is routinely half
 * written, and Markdown shows that half as literal punctuation until the
 * closer lands. Hiding the dangling delimiter keeps `**加粗` from flashing its
 * asterisks a token before it turns bold.
 */
function maskIncompleteTail(text: string) {
  // An open fence already renders as a verbatim block, and every delimiter
  // inside it is content, so the whole message is left alone.
  if ((text.match(/^(?:```|~~~)/gm) ?? []).length % 2) return text;

  // Only the prose after every closed code span can hold a dangling delimiter.
  // The split here requires a non-empty code span, so a fence opener arriving
  // one backtick at a time stays in the prose tail where it can be hidden
  // instead of being mistaken for an empty inline span.
  const chunks = text.split(STREAM_CODE_SPANS);
  let masked = (chunks.at(-1) ?? "").replace(/`{1,2}$/, "");
  for (const delimiter of ["**", "~~", "`"]) {
    if ((masked.split(delimiter).length - 1) % 2) masked = replaceLast(masked, delimiter, "");
  }

  // A link is only readable once its destination arrives; until then show the
  // label alone, and nothing at all for an image whose alt text is not prose.
  const open = masked.lastIndexOf("[");
  const rest = open < 0 ? "" : masked.slice(open);
  if (rest && !/^\[[^\]\n]*\]\([^)\n]*\)/.test(rest)) {
    const partial = rest.match(/^\[([^\]\n]*)(?:\]\(?[^)\n]*)?$/);
    const image = open > 0 && masked[open - 1] === "!";
    if (partial) masked = masked.slice(0, image ? open - 1 : open) + (image ? "" : partial[1]);
  }

  chunks[chunks.length - 1] = masked;
  return chunks.join("");
}

function replaceLast(text: string, needle: string, replacement: string) {
  const at = text.lastIndexOf(needle);
  return at < 0 ? text : `${text.slice(0, at)}${replacement}${text.slice(at + needle.length)}`;
}

function useKatex(source: string) {
  const wanted = useMemo(() => looksLikeMath(source), [source]);
  const [plugins, setPlugins] = useState(katexPlugins);

  useEffect(() => {
    if (!wanted || plugins) return;
    let live = true;
    void loadKatex().then(() => {
      if (live) setPlugins(katexPlugins);
    });
    return () => {
      live = false;
    };
  }, [wanted, plugins]);

  return plugins ?? [];
}

/**
 * `image://img_…` is how tools reference generated images. react-markdown
 * drops URLs whose protocol it does not recognise, so the rewrite has to run
 * in `urlTransform`, before the default sanitiser sees the value.
 */
function transformUrl(url: string) {
  const image = url.match(/^image:\/\/(img_[0-9a-f]{32})$/i);
  if (image) return `/v1/images/${image[1]!.toLowerCase()}`;
  if (url.startsWith(CITE_SCHEME)) return url;
  return /^(https?:|mailto:|tel:|#|\/|\.)/i.test(url) ? url : "";
}

/**
 * Rewrites inline citation anchors into links the renderer can turn into
 * chips. Anchors the tools never produced are dropped rather than shown raw,
 * and the surrounding group and highlight markers are removed with them —
 * a private-use codepoint that reaches the DOM draws as a tofu box.
 */
function withCitationLinks(text: string, citations: Map<string, Citation>) {
  return text
    .replace(CITATION_PATTERN, (anchor) => {
      const key = citationKey(anchor);
      const citation = citations.get(key);
      if (!citation) return "";
      return `[${citation.label}](${CITE_SCHEME}${encodeURIComponent(key)})`;
    })
    .replace(CITATION_MARKUP_PATTERN, "")
    .replace(/[\ue000-\uf8ff]/g, "");
}

/**
 * Parsing Markdown is the most expensive thing a turn does, and a streaming
 * conversation re-renders its whole transcript on every token. The memo is what
 * keeps that cost proportional to the one message that is actually changing.
 */
export const Markdown = memo(function Markdown({
  text,
  citations,
  streaming = false,
  onImageClick,
}: {
  text: string;
  citations: Map<string, Citation>;
  /** Hides half-written delimiters so the tail does not flash raw syntax. */
  streaming?: boolean;
  onImageClick?: (src: string) => void;
}) {
  const source = useMemo(() => {
    const prepared = withCitationLinks(guardCurrency(normalizeMath(text)), citations);
    return streaming ? maskIncompleteTail(prepared) : prepared;
  }, [text, citations, streaming]);
  const rehypePlugins = useKatex(source);

  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) => {
        if (href?.startsWith(CITE_SCHEME)) {
          const anchor = decodeURIComponent(href.slice(CITE_SCHEME.length));
          const citation = citations.get(anchor);
          const label = citation?.label ?? "source";
          return citation?.url ? (
            <a className={CITE} href={citation.url} target="_blank" rel="noreferrer" title={citation.detail ?? label}>
              {label}
            </a>
          ) : (
            <span className={CITE} title={citation?.detail ?? label}>
              {label}
            </span>
          );
        }
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
      img: ({ src, alt }) => {
        const resolved = typeof src === "string" ? src : "";
        // Inline images render at column width; the full-size file is only
        // fetched when the reader opens the lightbox.
        const preview = resolved.startsWith("/v1/images/") ? `${resolved}?w=1280` : resolved;
        return (
          <img
            className="max-h-150 w-fit max-w-full cursor-zoom-in rounded-lg border"
            src={preview}
            alt={alt ?? ""}
            loading="lazy"
            decoding="async"
            onClick={() => onImageClick?.(resolved)}
          />
        );
      },
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    }),
    [citations, onImageClick],
  );

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        urlTransform={transformUrl}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/code relative">
      <pre>{children}</pre>
      <button
        className="absolute top-2 right-2 rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
        onClick={(event) => {
          const block = event.currentTarget.parentElement?.querySelector("pre");
          void navigator.clipboard?.writeText(block?.innerText ?? "");
          setCopied(true);
          setTimeout(() => setCopied(false), 1_200);
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}
