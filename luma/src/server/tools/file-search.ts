import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { FileSearchMode } from "@shared/types.ts";
import type { Retrieval, SearchHit } from "../rag/retrieval.ts";
import {
  FILE_SEARCH_DESCRIPTION,
  FILE_SEARCH_IDS_DESCRIPTION,
  FILE_SEARCH_QUERY_DESCRIPTION,
  INTENT_DESCRIPTION,
} from "./descriptions.ts";

/**
 * How relevant a hit is relative to the best one this query found.
 *
 * There used to be a floor here — chunks under 0.3 cosine similarity were
 * dropped — but it only ever applied to semantic hits, because a keyword hit
 * has no similarity and was scored 1.0 by default. So the two halves of a
 * hybrid search were held to opposite standards, and a query whose best answer
 * happened to sit at 0.28 was told the library contained nothing.
 *
 * Ranking is the server's job; deciding whether the top-ranked passage actually
 * answers the question is the model's, and it is better equipped for it, having
 * read both the question and the passage.
 */
const relevanceAgainst = (best: number) => (hit: SearchHit) => (best > 0 ? hit.retrievalScore / best : 0);

export function fileSearchTool(retrieval: Retrieval, mode: FileSearchMode): AgentTool {
  let turnCounter = 0;
  return {
    name: "file_search",
    label: "file_search",
    description: FILE_SEARCH_DESCRIPTION,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        intent: { type: "string", description: INTENT_DESCRIPTION },
        query: { type: "string", description: FILE_SEARCH_QUERY_DESCRIPTION },
        file_ids: {
          type: "array",
          items: { type: "string" },
          description: FILE_SEARCH_IDS_DESCRIPTION,
        },
      },
      required: ["intent", "query"],
    }),
    execute: async (_callId, params) => {
      const { query, file_ids: fileIds } = params as { query: string; file_ids?: unknown };
      const scope = Array.isArray(fileIds) ? fileIds.filter((id): id is string => typeof id === "string" && !!id) : [];
      const turn = turnCounter++;
      const result = await retrieval.searchFiles(query, mode, 10, scope);
      const matches = result.results.filter((hit) => hit.excerpt.trim());
      const relevanceOf = relevanceAgainst(matches[0]?.retrievalScore ?? 0);

      if (!matches.length) {
        const text =
          result.index.ready === 0
            ? "No files to search. Instruct the user to add files for the search."
            : scope.length
              ? "No matching content in the file(s) you named. Try different wording, or drop file_ids to search the whole library."
              : "No content found in the files. The files may not have been processed correctly or you may need to refine your query.";
        return {
          content: [{ type: "text", text }],
          details: { structuredContent: { file_search: { turn, sources: [], fileCitations: true } } },
        };
      }

      const text = matches
        .map(
          (hit, index) =>
            `File: ${hit.name}\nAnchor: \\ue202turn${turn}file${index} (${hit.name})\nRelevance: ${relevanceOf(hit).toFixed(4)}\nContent: ${hit.excerpt}\n`,
        )
        .join("\n---\n");

      const sources = matches.map((hit) => ({
        type: "file",
        fileId: hit.id,
        content: hit.excerpt,
        fileName: hit.name,
        relevance: relevanceOf(hit),
        pages: hit.page ? [hit.page] : [],
        pageRelevance: hit.page ? { [hit.page]: relevanceOf(hit) } : {},
      }));

      return {
        content: [{ type: "text", text }],
        details: { structuredContent: { file_search: { turn, sources, fileCitations: true } } },
      };
    },
  };
}
