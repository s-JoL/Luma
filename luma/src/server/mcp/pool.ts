import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { McpStatus } from "@shared/types.ts";
import { SECRET } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import { paths } from "../env.ts";
import type { Store } from "../store/store.ts";
import { portableSchema } from "./schema.ts";
import { connectServer } from "./transport.ts";

const CALL_TIMEOUT_MS = 600_000;

function expand(value: string, vars: Record<string, string>) {
  return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => vars[key] ?? process.env[key] ?? "");
}

/**
 * Owns the connected MCP servers — child processes and remote endpoints alike
 * (`transport.ts`). Reconnecting is a full teardown so a settings change can
 * never leave a half-configured server attached.
 *
 * MCP is for the agent. Generation goes through adapters and the job queue;
 * connecting a server "for the studio only" was a second image path and is gone.
 */
export class McpPool {
  private clients: Array<{ id: string; client: Client }> = [];
  private statuses: McpStatus[] = [];
  private tools: AgentTool[] = [];

  constructor(
    private readonly store: Store,
    private readonly vault: SecretVault,
  ) {}

  status(): McpStatus[] {
    return this.statuses;
  }

  currentTools() {
    return this.tools;
  }

  private variables(): Record<string, string> {
    const vars: Record<string, string> = {
      AIGC_ROOT: path.resolve(paths.root, "..").replaceAll("\\", "/"),
      PROJECT_ROOT: paths.root.replaceAll("\\", "/"),
      NODE_EXE: process.execPath,
    };
    for (const provider of this.store.listProviders()) {
      const key = this.vault.get(SECRET.provider(provider.id));
      if (key) vars[`${provider.id.toUpperCase().replaceAll("-", "_")}_API_KEY`] = key;
    }
    return vars;
  }

  async connect(): Promise<AgentTool[]> {
    await this.close();
    const vars = this.variables();
    const output: AgentTool[] = [];
    this.statuses = [];

    for (const server of this.store.listMcpServers()) {
      if (!server.enabled) {
        this.statuses.push({ id: server.id, title: server.title, enabled: false, connected: false, tools: [] });
        continue;
      }
      let client: Client | undefined;
      try {
        const connected = await connectServer(server, (value) => expand(value, vars));
        client = connected;
        this.clients.push({ id: server.id, client: connected });
        const listed = await connected.listTools();
        this.statuses.push({
          id: server.id,
          title: server.title,
          enabled: true,
          connected: true,
          tools: listed.tools.map((tool) => tool.name),
        });
        for (const tool of listed.tools) {
          const toolName = `${tool.name}_mcp_${server.id.replaceAll(":", "__")}`;
          output.push({
            name: toolName,
            label: toolName,
            description: tool.description ?? "",
            parameters: Type.Unsafe(portableSchema(tool.inputSchema) as never),
            executionMode: "sequential",
            execute: async (_callId, args, signal) => {
              const response = await connected.callTool(
                { name: tool.name, arguments: args as Record<string, unknown> },
                undefined,
                { signal, timeout: CALL_TIMEOUT_MS },
              );
              const parts = (response.content ?? []) as Array<Record<string, unknown>>;
              const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
              for (const part of parts) {
                if (part.type === "text") content.push({ type: "text", text: String(part.text ?? "") });
                if (part.type === "image") {
                  content.push({
                    type: "image",
                    data: String(part.data ?? ""),
                    mimeType: String(part.mimeType ?? "image/png"),
                  });
                }
              }
              return {
                content,
                details: {
                  server: server.id,
                  structuredContent: response.structuredContent,
                  resources: parts.filter((part) => part.type === "resource"),
                },
              };
            },
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.statuses.push({
          id: server.id,
          title: server.title,
          enabled: true,
          connected: false,
          tools: [],
          error: message,
        });
        console.error(`[mcp] ${server.id} unavailable: ${message}`);
        await client?.close().catch(() => undefined);
      }
    }
    this.tools = output;
    return output;
  }

  /**
   * Whether an agent tool name belongs to one of the given servers. The server
   * id is encoded in the tool name because pi tool names have to be flat, so
   * profile scoping reads it back out of the suffix rather than keeping a second
   * index that could drift.
   */
  serverOf(toolName: string, allowed: Set<string>) {
    for (const id of allowed) {
      if (toolName.endsWith(`_mcp_${id.replaceAll(":", "__")}`)) return true;
    }
    return false;
  }

  async close() {
    await Promise.allSettled(this.clients.map(({ client }) => client.close()));
    this.clients = [];
    this.tools = [];
  }
}
