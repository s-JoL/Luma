import { useEffect, useState } from "react";
import type { Capabilities, McpServer } from "@shared/types.ts";
import { api } from "../../api.ts";
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  Section,
  SectionBody,
  Select,
  Switch,
  useAction,
  useToast,
} from "../../ui.tsx";

export function CapabilitiesSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const toast = useToast();
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [tavilyKey, setTavilyKey] = useState("");
  const [embeddingKey, setEmbeddingKey] = useState("");

  useEffect(() => {
    Promise.all([api.capabilities(), api.mcpServers()])
      .then(([caps, mcp]) => {
        setCapabilities(caps);
        setMcpServers(mcp.items);
      })
      .catch((error: unknown) => toast(String(error), true));
  }, [toast]);

  if (!capabilities) return <Empty>正在加载…</Empty>;

  const patch = async (input: Parameters<typeof api.updateCapabilities>[0]) => {
    await act(async () => {
      setCapabilities(await api.updateCapabilities(input));
      await reload();
    });
  };

  return (
    <>
      <Section
        title="联网搜索"
        actions={
          <Badge tone={capabilities.web.hasTavilyKey ? "success" : "warning"}>
            {capabilities.web.hasTavilyKey ? "已配置" : "缺少密钥"}
          </Badge>
        }
      >
        <SectionBody>
          <Switch
            label="启用 web_search 工具"
            checked={capabilities.web.enabled}
            onChange={(value) => void patch({ web: { enabled: value } })}
          />
          <Field label="Tavily API Key">
            <div className="flex gap-2">
              <Input
                className="flex-1"
                type="password"
                placeholder={capabilities.web.hasTavilyKey ? "替换密钥" : "tvly-…"}
                value={tavilyKey}
                onChange={(event) => setTavilyKey(event.target.value)}
              />
              <Button
                disabled={!tavilyKey.trim()}
                onClick={async () => {
                  const ok = await act(
                    async () => setCapabilities(await api.setSecret("tavily", tavilyKey.trim())),
                    "已保存",
                  );
                  if (ok) setTavilyKey("");
                }}
              >
                保存
              </Button>
              <Button
                variant="ghost"
                className="text-destructive"
                disabled={!capabilities.web.hasTavilyKey}
                onClick={() => void act(async () => setCapabilities(await api.clearSecret("tavily")), "已清除")}
              >
                清除
              </Button>
            </div>
          </Field>
        </SectionBody>
      </Section>

      <Section title="文件检索">
        <SectionBody>
          <Switch
            label="允许上传文件"
            checked={capabilities.files.enabled}
            onChange={(value) => void patch({ files: { enabled: value } })}
          />
          <Switch
            label="启用 file_search 工具"
            checked={capabilities.files.searchEnabled}
            onChange={(value) => void patch({ files: { searchEnabled: value } })}
          />
          <Field label="检索方式">
            <Select
              value={capabilities.files.mode}
              options={[
                { value: "hybrid", label: "混合", hint: "向量 + 关键词，RRF 融合" },
                { value: "semantic", label: "仅向量" },
                { value: "keyword", label: "仅关键词" },
              ]}
              onChange={(value) => void patch({ files: { mode: value as Capabilities["files"]["mode"] } })}
            />
          </Field>
        </SectionBody>
      </Section>

      <Section
        title="嵌入模型"
        hint="改动切片参数后，需要在文件库里重建索引才会生效。"
        actions={
          <Badge tone={capabilities.embedding.hasKey ? "success" : "warning"}>
            {capabilities.embedding.hasKey ? "已配置" : "缺少密钥"}
          </Badge>
        }
      >
        <SectionBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Base URL">
              <Input
                defaultValue={capabilities.embedding.baseUrl}
                onBlur={(event) => void patch({ embedding: { baseUrl: event.target.value } })}
              />
            </Field>
            <Field label="模型">
              <Input
                defaultValue={capabilities.embedding.model}
                onBlur={(event) => void patch({ embedding: { model: event.target.value } })}
              />
            </Field>
            <Field label="切片大小" hint="按字符计。参考实现（LibreChat rag_api、Open WebUI）都在 1000–1500 之间。">
              <Input
                type="number"
                defaultValue={capabilities.embedding.chunkSize}
                onBlur={(event) => void patch({ embedding: { chunkSize: Number(event.target.value) } })}
              />
            </Field>
            <Field label="切片重叠" hint="取切片大小的 10%–20%，避免答案正好落在边界上。">
              <Input
                type="number"
                defaultValue={capabilities.embedding.chunkOverlap}
                onBlur={(event) => void patch({ embedding: { chunkOverlap: Number(event.target.value) } })}
              />
            </Field>
          </div>
          <Field label="API Key">
            <div className="flex gap-2">
              <Input
                className="flex-1"
                type="password"
                placeholder={capabilities.embedding.hasKey ? "替换密钥" : "sk-…"}
                value={embeddingKey}
                onChange={(event) => setEmbeddingKey(event.target.value)}
              />
              <Button
                disabled={!embeddingKey.trim()}
                onClick={async () => {
                  const ok = await act(
                    async () => setCapabilities(await api.setSecret("embedding", embeddingKey.trim())),
                    "已保存",
                  );
                  if (ok) setEmbeddingKey("");
                }}
              >
                保存
              </Button>
            </div>
          </Field>
        </SectionBody>
      </Section>

      <Section
        title="记忆"
        actions={<span className="text-xs text-muted-foreground">{capabilities.memory.suggestedKeys.length} 个建议键</span>}
      >
        <SectionBody>
          <Switch
            label="在系统提示中注入记忆"
            checked={capabilities.memory.enabled}
            onChange={(value) => void patch({ memory: { enabled: value } })}
          />
          <Switch
            label="允许模型写入记忆"
            checked={capabilities.memory.writeEnabled}
            onChange={(value) => void patch({ memory: { writeEnabled: value } })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Token 上限">
              <Input
                type="number"
                defaultValue={capabilities.memory.tokenLimit}
                onBlur={(event) => void patch({ memory: { tokenLimit: Number(event.target.value) } })}
              />
            </Field>
            <Field label="单条字符上限" hint="只在写入时校验；已超出的旧条目仍可读，但要先删减才能再编辑。">
              <Input
                type="number"
                defaultValue={capabilities.memory.charLimit}
                onBlur={(event) => void patch({ memory: { charLimit: Number(event.target.value) } })}
              />
            </Field>
          </div>
          <Field label="建议键（逗号分隔）" hint="只是给模型的复用提示，它仍可按内容自建新键。">
            <Input
              defaultValue={capabilities.memory.suggestedKeys.join(", ")}
              onBlur={(event) =>
                void patch({
                  memory: {
                    suggestedKeys: event.target.value
                      .split(",")
                      .map((key) => key.trim())
                      .filter(Boolean),
                  },
                } as Parameters<typeof api.updateCapabilities>[0])
              }
            />
          </Field>
        </SectionBody>
      </Section>

      <Section title="创作台" hint="图像与视频的手动控制台。生成模型会自动出现在这里。">
        <SectionBody>
          <Switch
            label="启用创作台页面"
            checked={capabilities.studio.enabled}
            onChange={(value) => void patch({ studio: { enabled: value } })}
          />
          <Field
            label="额外接入的 MCP 服务器"
            hint="选中的服务器会单独为创作台连接，即使它对对话是停用的。留空表示跟随对话里启用的服务器。"
          >
            {mcpServers.length === 0 ? (
              <p className="text-xs text-muted-foreground">还没有 MCP 服务器。</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {mcpServers.map((server) => {
                  const selected = capabilities.studio.servers;
                  const on = selected.length === 0 ? server.enabled : selected.includes(server.id);
                  return (
                    <Switch
                      key={server.id}
                      label={server.title}
                      checked={on}
                      onChange={(value) => {
                        const base = selected.length
                          ? selected
                          : mcpServers.filter((item) => item.enabled).map((item) => item.id);
                        const next = value
                          ? [...new Set([...base, server.id])]
                          : base.filter((id) => id !== server.id);
                        void patch({
                          studio: { servers: next as never },
                        } as Parameters<typeof api.updateCapabilities>[0]);
                      }}
                    />
                  );
                })}
              </div>
            )}
          </Field>
        </SectionBody>
      </Section>

      <Section
        title="代码工具"
        hint="开启后，模型可以在下面的工作目录内读写文件甚至执行命令。仅在你清楚风险时开启。"
        actions={<Badge tone="warning">高权限</Badge>}
      >
        <SectionBody>
          <div className="flex flex-wrap gap-5">
            <Switch
              label="读取"
              checked={capabilities.coding.read}
              onChange={(value) => void patch({ coding: { read: value } })}
            />
            <Switch
              label="写入"
              checked={capabilities.coding.write}
              onChange={(value) => void patch({ coding: { write: value } })}
            />
            <Switch
              label="执行命令"
              checked={capabilities.coding.shell}
              onChange={(value) => void patch({ coding: { shell: value } })}
            />
          </div>
          <Field label="工作目录">
            <Input
              className="font-mono text-xs"
              defaultValue={capabilities.coding.workspace}
              onBlur={(event) => void patch({ coding: { workspace: event.target.value } })}
            />
          </Field>
        </SectionBody>
      </Section>
    </>
  );
}
