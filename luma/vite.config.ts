import { fileURLToPath } from "node:url";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Overridable so the dev server can be pointed at an isolated instance for
// testing instead of the one holding the user's real conversations.
const API = process.env.LUMA_API_URL ?? "http://127.0.0.1:8090";

export default defineConfig({
  plugins: [react(), tailwind()],
  root: "src/web",
  publicDir: false,
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3100,
    strictPort: true,
    // The API rejects an authenticated write whose Origin is not its own host,
    // which is every write from the dev server unless the proxy presents itself
    // as the API. changeOrigin only rewrites Host, so Origin is set explicitly.
    proxy: {
      "/v1": {
        target: API,
        changeOrigin: true,
        headers: { origin: API },
      },
    },
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    /**
     * One KaTeX font is small enough that Vite would inline it as a `data:`
     * URL, and the app's Content-Security-Policy has no `font-src`, so
     * `default-src 'self'` blocks it — in the built app only, which is why the
     * dev server never shows it. Emitting every font as a real file keeps the
     * policy strict instead of widening it to accept `data:` fonts.
     */
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
    rolldownOptions: {
      output: {
        /**
         * React and the Markdown pipeline are loaded on every visit, so they
         * cannot be deferred, but together they are most of the entry chunk —
         * large enough to trip Vite's chunk size warning and to be re-fetched
         * whenever app code changes. Splitting them out keeps every chunk well
         * under the warning and lets the browser cache them across releases.
         *
         * The groups match only these dependencies rather than all of
         * `node_modules`: a blanket rule would pull KaTeX and `rehype-katex`
         * in as well, and those are deliberately loaded on demand by
         * `markdown.tsx`.
         */
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            {
              name: "markdown",
              test: /node_modules[\\/](react-markdown|remark-[^\\/]+|micromark[^\\/]*|mdast-[^\\/]+|hast-[^\\/]+|unist-[^\\/]+|unified|vfile[^\\/]*|bail|trough|devlop|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|decode-named-character-reference|character-entities[^\\/]*|zwitch|longest-streak|ccount|escape-string-regexp|markdown-table|estree-util-[^\\/]+|style-to-js|style-to-object|inline-style-parser)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
