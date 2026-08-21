/**
 * Everything that does work on the model's behalf, on one page: the generation
 * backends this server drives itself, and the MCP servers it connects to.
 *
 * Generation models appear in the studio and, if flagged, as agent tools.
 * MCP is only for the agent.
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
