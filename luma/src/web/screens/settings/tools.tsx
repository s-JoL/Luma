/**
 * Everything that does work on the model's behalf, on one page: the generation
 * backends this server drives itself, and the MCP servers it connects to.
 *
 * They were on different pages because they are implemented differently — one is
 * an adapter and a job queue, the other is a subprocess speaking a protocol — but
 * that is our distinction, not the reader's. From here both answer the same three
 * questions: is it reachable, what does it take, and is the agent allowed to use
 * it or is it for the studio only.
 */
import { GenerationSection } from "./models.tsx";
import { McpSection } from "./mcp.tsx";

export function ToolsSection({ reload }: { reload: () => Promise<void> }) {
  return (
    <>
      <GenerationSection reload={reload} />
      <McpSection reload={reload} />
    </>
  );
}
