/**
 * Which transport a stored server gets, decided by the shape of its record: a
 * command is a child process over stdio, a URL is a remote server over HTTP.
 *
 * The MCP spec has two mainstream transports and hosted servers are published
 * on the second one, so a stdio-only client can talk to whatever it can spawn
 * and to nothing else. Streamable HTTP is tried first and the deprecated
 * HTTP+SSE transport is the fallback, because a server written before that
 * rewrite answers the initial POST with a 4xx and serves a GET stream instead.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@shared/types.ts";

const CLIENT = { name: "luma", version: "1.0.0" };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `command` is still consulted for a URL: records written before `mcp_servers`
 * had a `url` column had nowhere else to put one, and they keep working.
 */
function remoteUrl(server: McpServer, expand: (value: string) => string) {
  const declared: unknown = server.url;
  const raw = expand(typeof declared === "string" && declared ? declared : server.command).trim();
  if (!/^https?:\/\//i.test(raw)) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function remoteHeaders(server: McpServer, expand: (value: string) => string) {
  const declared: unknown = server.headers;
  const source = declared && typeof declared === "object" ? (declared as Record<string, unknown>) : server.env;
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, expand(String(value))]));
}

async function attempt(connect: (client: Client) => Promise<void>) {
  const client = new Client(CLIENT);
  try {
    await connect(client);
    return { client };
  } catch (error) {
    await client.close().catch(() => undefined);
    return { error: message(error) };
  }
}

/** Connects one stored server, or throws with what the transport reported. */
export async function connectServer(server: McpServer, expand: (value: string) => string): Promise<Client> {
  const url = remoteUrl(server, expand);
  if (!url) {
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(server.env).map(([key, value]) => [key, expand(value)]),
    );
    const stdio = await attempt((client) =>
      client.connect(
        new StdioClientTransport({
          command: expand(server.command),
          args: server.args.map((arg) => expand(arg)),
          env: { ...(process.env as Record<string, string>), ...env },
          stderr: "pipe",
        }),
      ),
    );
    if (stdio.client) return stdio.client;
    throw new Error(stdio.error);
  }

  const requestInit = { headers: remoteHeaders(server, expand) };
  const streamable = await attempt((client) =>
    client.connect(new StreamableHTTPClientTransport(url, { requestInit })),
  );
  if (streamable.client) return streamable.client;
  const legacy = await attempt((client) => client.connect(new SSEClientTransport(url, { requestInit })));
  if (legacy.client) return legacy.client;
  throw new Error(`${streamable.error} (HTTP+SSE fallback: ${legacy.error})`);
}
