import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Capabilities } from "@shared/types.ts";
import { SEARCH_PROVIDERS } from "@shared/types.ts";
import { api } from "../../api.ts";
import {
  Badge,
  Button,
  cn,
  Empty,
  Field,
  Input,
  Section,
  SectionBody,
  Select,
  Spinner,
  Switch,
  useAction,
  useToast,
} from "../../ui.tsx";

interface ReindexProgress {
  done: number;
  total: number;
  failed: number;
}

export function CapabilitiesSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const toast = useToast();
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [tavilyKey, setTavilyKey] = useState("");
  const [embeddingKey, setEmbeddingKey] = useState("");
  const [reindexing, setReindexing] = useState(false);
  const [progress, setProgress] = useState<ReindexProgress | null>(null);

  useEffect(() => {
    api.capabilities()
      .then((caps) => {
        setCapabilities(caps);
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

  /**
   * Re-slices and re-embeds every document with the parameters that are saved
   * now. One file at a time: the count is the only progress the reader gets,
   * and firing the whole library at the embedding provider at once would trade
   * it for rate limits. A file that fails is counted, not fatal — the rest have
   * no reason to stay on stale chunks.
   */
  const reindexAll = async () => {
    setReindexing(true);
    setProgress({ done: 0, total: 0, failed: 0 });
    const ok = await act(async () => {
      const { items } = await api.files({ limit: 500 });
      const docs = items.filter((file) => !file.mime.startsWith("image/") && !file.mime.startsWith("video/"));
      setProgress({ done: 0, total: docs.length, failed: 0 });
      let failed = 0;
      for (const [index, file] of docs.entries()) {
        try {
          await api.reindexFile(file.id);
        } catch {
          failed += 1;
        }
        setProgress({ done: index + 1, total: docs.length, failed });
      }
    });
    if (!ok) setProgress(null);
    setReindexing(false);
  };

  return (
    <>
      <Section
        title="联网搜索"
        actions={
          <Badge
            tone={
              capabilities.web.provider === "searxng"
                ? capabilities.web.baseUrl
                  ? "success"
                  : "warning"
                : capabilities.web.hasTavilyKey
                  ? "success"
                  : "warning"
            }
          >
            {capabilities.web.provider === "searxng"
              ? capabilities.web.baseUrl
                ? "已配置实例"
                : "缺少实例地址"
              : capabilities.web.hasTavilyKey
                ? "已配置"
                : "缺少密钥"}
          </Badge>
        }
      >
        <SectionBody>
          <Switch
            label="启用 web_search 工具"
            checked={capabilities.web.enabled}
            onChange={(value) => void patch({ web: { enabled: value } })}
          />
          <Field label="后端">
            <Select
              value={capabilities.web.provider}
              options={SEARCH_PROVIDERS.map((item) => ({ value: item.id, label: item.label }))}
              onChange={(value) => void patch({ web: { provider: value } })}
            />
          </Field>
          {capabilities.web.provider === "searxng" ? (
            <Field label="SearXNG 地址" hint="自托管实例的根地址，不需要密钥。">
              <Input
                defaultValue={capabilities.web.baseUrl}
                placeholder="http://127.0.0.1:8080"
                onBlur={(event) => void patch({ web: { baseUrl: event.target.value } })}
              />
            </Field>
          ) : (
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
          )}
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
                { value: "hybrid", label: "混合", hint: "语义加关键词" },
                { value: "semantic", label: "仅语义" },
                { value: "keyword", label: "仅关键词" },
              ]}
              onChange={(value) => void patch({ files: { mode: value as Capabilities["files"]["mode"] } })}
            />
          </Field>
        </SectionBody>
      </Section>

      <Section
        title="嵌入模型"
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
            <Field label="切片大小" hint="按字符计，一般 1000–1500。">
              <Input
                type="number"
                defaultValue={capabilities.embedding.chunkSize}
                onBlur={(event) => void patch({ embedding: { chunkSize: Number(event.target.value) } })}
              />
            </Field>
            <Field label="切片重叠" hint="大约切片大小的一成到两成。">
              <Input
                type="number"
                defaultValue={capabilities.embedding.chunkOverlap}
                onBlur={(event) => void patch({ embedding: { chunkOverlap: Number(event.target.value) } })}
              />
            </Field>
          </div>
          <Field
            label="重建索引"
            hint="改切片只影响新文件。已经索引过的，要点下面重建。"
          >
            <div className="flex items-center gap-3">
              <Button variant="outline" disabled={reindexing} onClick={() => void reindexAll()}>
                {reindexing ? <Spinner /> : <RefreshCw />}
                重建全部文档
              </Button>
              {progress ? (
                reindexing ? (
                  <span className="text-xs text-muted-foreground">
                    重建中 {progress.done}/{progress.total}
                  </span>
                ) : (
                  <span className={cn("text-xs", progress.failed ? "text-destructive" : "text-muted-foreground")}>
                    已重建 {progress.done - progress.failed} 个，失败 {progress.failed} 个
                  </span>
                )
              ) : null}
            </div>
          </Field>
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
            <Field label="单条字符上限">
              <Input
                type="number"
                defaultValue={capabilities.memory.charLimit}
                onBlur={(event) => void patch({ memory: { charLimit: Number(event.target.value) } })}
              />
            </Field>
          </div>
          <Field label="建议键（逗号分隔）" hint="给模型的起点，它仍可以自己起名。">
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

      <Section title="创作台">
        <SectionBody>
          <Switch
            label="启用创作台页面"
            checked={capabilities.studio.enabled}
            onChange={(value) => void patch({ studio: { enabled: value } })}
          />
        </SectionBody>
      </Section>

      <Section
        title="代码工具"
        hint="模型可以在这个目录里读文件、改文件、跑命令。只在你清楚风险时打开。"
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
