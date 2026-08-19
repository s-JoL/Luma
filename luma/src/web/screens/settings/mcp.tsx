import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { McpServer, McpStatus } from "@shared/types.ts";
import { api } from "../../api.ts";
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  type Option,
  Row,
  Section,
  SectionBody,
  Select,
  Switch,
  Textarea,
  useAction,
  useToast,
} from "../../ui.tsx";

type Transport = "stdio" | "remote";

const TRANSPORT_OPTIONS: Array<Option<Transport>> = [
  { value: "stdio", label: "本地子进程", hint: "按命令与参数启动，通过 stdio 通信" },
  { value: "remote", label: "远程 HTTP", hint: "连接已发布的服务器，Streamable HTTP" },
];

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim());

const kvText = (record: Record<string, string>) =>
  Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

const parseKv = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );

export function McpSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const toast = useToast();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [status, setStatus] = useState<McpStatus[]>([]);
  const [editing, setEditing] = useState<McpServer | null>(null);

  const refresh = useCallback(async () => {
    const data = await api.mcpServers();
    setServers(data.items);
    setStatus(data.status);
    await reload();
  }, [reload]);

  useEffect(() => {
    void refresh().catch((error: unknown) => toast(String(error), true));
  }, [refresh, toast]);

  return (
    <>
      <Section
        title="MCP 服务器"
        hint="本地子进程或远程 HTTP 服务器，它声明的工具会直接进入对话模型的工具列表。"
        actions={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void act(() => api.reconnectMcp(), "已重连").then(refresh)}>
              <RefreshCw />
              重连
            </Button>
            <Button
              size="sm"
              onClick={() =>
                setEditing({
                  id: "",
                  title: "",
                  enabled: true,
                  command: "",
                  args: [],
                  env: {},
                  sortOrder: servers.length,
                })
              }
            >
              添加
            </Button>
          </div>
        }
      >
        {servers.length === 0 ? (
          <SectionBody>
            <p className="text-sm text-muted-foreground">
              还没有 MCP 服务器。生成不需要它：图片与视频后端就在这一页的上面。
            </p>
          </SectionBody>
        ) : null}
        {servers.map((server) => {
          const state = status.find((item) => item.id === server.id);
          return (
            <Row key={server.id}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="text-sm">{server.title}</strong>
                  {server.url ? <Badge tone="outline">远程</Badge> : null}
                  {server.enabled ? (
                    <Badge tone={state?.connected ? "success" : "danger"}>
                      {state?.connected ? `${state.tools.length} 个工具` : "未连接"}
                    </Badge>
                  ) : (
                    <Badge tone="outline">
                      {state?.studioOnly && state.connected ? "仅创作台" : "已停用"}
                    </Badge>
                  )}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {server.url ?? `${server.command} ${server.args.join(" ")}`}
                </div>
                {state?.error ? <div className="truncate text-xs text-destructive">{state.error}</div> : null}
              </div>
              <Switch
                checked={server.enabled}
                onChange={(value) => void act(() => api.updateMcpServer(server.id, { enabled: value })).then(refresh)}
              />
              <Button variant="ghost" size="icon-sm" aria-label="编辑" onClick={() => setEditing(server)}>
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="删除"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void act(() => api.deleteMcpServer(server.id)).then(refresh)}
              >
                <Trash2 />
              </Button>
            </Row>
          );
        })}
      </Section>

      {editing ? (
        <McpEditor
          server={editing}
          onCancel={() => setEditing(null)}
          onSave={async (next, isNew) => {
            const ok = await act(
              () => (isNew ? api.createMcpServer(next) : api.updateMcpServer(next.id, next)),
              "已保存",
            );
            if (ok) {
              setEditing(null);
              await refresh();
            }
          }}
        />
      ) : null}
    </>
  );
}

function McpEditor({
  server,
  onCancel,
  onSave,
}: {
  server: McpServer;
  onCancel: () => void;
  onSave: (server: McpServer, isNew: boolean) => Promise<void>;
}) {
  // A record written before `url` and `headers` existed puts the endpoint in
  // `command` and reads `env` as the headers, which is how the transport still
  // reaches it; showing it that way keeps such a row editable as what it is.
  const legacyRemote = !server.url && isHttpUrl(server.command);
  const [draft, setDraft] = useState(server);
  const [transport, setTransport] = useState<Transport>(server.url || legacyRemote ? "remote" : "stdio");
  const [url, setUrl] = useState(server.url ?? (legacyRemote ? server.command : ""));
  const [argsText, setArgsText] = useState(server.args.join("\n"));
  const [envText, setEnvText] = useState(kvText(legacyRemote ? {} : server.env));
  const [headersText, setHeadersText] = useState(kvText(server.headers ?? (legacyRemote ? server.env : {})));
  const isNew = !server.id;
  const remote = transport === "remote";

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onCancel()}
      title={isNew ? "新建 MCP 服务器" : `编辑 ${server.title}`}
      className="w-[min(40rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button
            variant="primary"
            disabled={!draft.title.trim() || (remote ? !isHttpUrl(url) : !draft.command.trim())}
            onClick={() =>
              void onSave(
                {
                  ...draft,
                  // `command` is NOT NULL in the schema, so a remote server stores
                  // an empty one; the URL is what selects the HTTP transport.
                  command: remote ? "" : draft.command.trim(),
                  url: remote ? url.trim() : "",
                  args: remote
                    ? []
                    : argsText
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                  env: remote ? {} : parseKv(envText),
                  headers: remote ? parseKv(headersText) : {},
                },
                isNew,
              )
            }
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="名称">
            <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </Field>
          <Field label="标识">
            <Input
              value={draft.id}
              disabled={!isNew}
              placeholder="local-image-generation"
              onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            />
          </Field>
        </div>
        <Field label="接入方式">
          <Select value={transport} options={TRANSPORT_OPTIONS} onChange={setTransport} />
        </Field>
        {remote ? (
          <>
            <Field label="URL" hint="先按 Streamable HTTP 连接，失败再回退到已废弃的 HTTP+SSE。">
              <Input
                className="font-mono text-xs"
                placeholder="https://mcp.example.com/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
            <Field
              label="请求头（KEY=VALUE，每行一个）"
              hint={`值里可以写 ${"${变量}"}，例如 ${"${OPENROUTER_API_KEY}"} 引用同名提供方已存的密钥，令牌就不必明文留在这里。`}
            >
              <Textarea
                className="font-mono text-xs"
                rows={4}
                placeholder="Authorization=Bearer ${OPENROUTER_API_KEY}"
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="命令">
              <Input
                className="font-mono text-xs"
                value={draft.command}
                placeholder="python"
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              />
            </Field>
            <Field label="参数（每行一个）">
              <Textarea
                className="font-mono text-xs"
                rows={4}
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
              />
            </Field>
            <Field
              label="环境变量（KEY=VALUE，每行一个）"
              hint={`可引用 ${"${AIGC_ROOT}"}、${"${PROJECT_ROOT}"}、${"${NODE_EXE}"} 与每个提供方的 ${"${<提供方>_API_KEY}"}。`}
            >
              <Textarea
                className="font-mono text-xs"
                rows={4}
                value={envText}
                onChange={(event) => setEnvText(event.target.value)}
              />
            </Field>
          </>
        )}
        <Switch label="启用" checked={draft.enabled} onChange={(value) => setDraft({ ...draft, enabled: value })} />
      </div>
    </Modal>
  );
}
