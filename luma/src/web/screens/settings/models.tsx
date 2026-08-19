import { Pencil, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  ApiMode,
  DiscoveredModel,
  GenerationOp,
  ModelKind,
  ModelSpec,
  Provider,
  ProviderAuthConfig,
  ProviderAuthStyle,
  ProviderInput,
  ThinkingLevel,
} from "@shared/types.ts";
import { API_MODES, isChatKind, isGenerationKind, needsApiKey, OP_LABELS } from "@shared/types.ts";
import { api } from "../../api.ts";
import {
  Badge,
  Button,
  cn,
  Field,
  Input,
  Modal,
  type Option,
  Row,
  Section,
  SectionBody,
  Select,
  Spinner,
  Switch,
  Textarea,
  Tooltip,
  useAction,
  useToast,
} from "../../ui.tsx";

const KIND_LABEL: Partial<Record<ModelKind, string>> = {
  chat: "对话",
  image: "图片",
  video: "视频",
  embedding: "向量",
  rerank: "重排",
};

const THINKING_OPTIONS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const AUTH_OPTIONS: Array<Option<ProviderAuthStyle>> = [
  { value: "bearer", label: "Bearer 令牌", hint: "Authorization: Bearer <密钥>，绝大多数兼容端点" },
  { value: "header", label: "自定义请求头", hint: "中转站与 Azure 形态网关，如 x-api-key、api-key" },
  { value: "none", label: "不带凭证", hint: "自建 Ollama / llama.cpp / vLLM，靠可达性鉴权" },
];

const apiModeLabel = (mode: ApiMode) => API_MODES.find((item) => item.id === mode)?.label ?? mode;

interface AuthDraft {
  style: ProviderAuthStyle;
  header: string;
  prefix: string;
}

/** A stored style read back into the form; anything unrecognised is bearer, as the server also reads it. */
function authDraft(auth?: ProviderAuthConfig | null): AuthDraft {
  const style = auth?.style;
  return {
    style: style === "header" || style === "none" ? style : "bearer",
    header: auth?.header ?? "",
    prefix: auth?.prefix ?? "",
  };
}

/** `null` is how bearer travels: it clears the column back to what a row that declares nothing means. */
function authInput(draft: AuthDraft): ProviderAuthConfig | null {
  if (draft.style === "none") return { style: "none" };
  if (draft.style === "header") return { style: "header", header: draft.header.trim(), prefix: draft.prefix };
  return null;
}

// A header style naming no header reads as bearer on the server, which would send
// the key somewhere the gateway does not look.
const authReady = (draft: AuthDraft) => draft.style !== "header" || Boolean(draft.header.trim());

/** The auth style plus the fields only one style needs, so bearer stays a single click. */
function AuthFields({ draft, onChange }: { draft: AuthDraft; onChange: (next: AuthDraft) => void }) {
  return (
    <>
      <Field label="鉴权方式">
        <Select value={draft.style} options={AUTH_OPTIONS} onChange={(style) => onChange({ ...draft, style })} />
      </Field>
      {draft.style === "header" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="头名称">
            <Input
              className="font-mono text-xs"
              placeholder="x-api-key"
              value={draft.header}
              onChange={(event) => onChange({ ...draft, header: event.target.value })}
            />
          </Field>
          <Field label="前缀（可选）" hint="写在密钥前面，例如 “Bearer ” 连一个空格；留空直接发送密钥。">
            <Input
              className="font-mono text-xs"
              value={draft.prefix}
              onChange={(event) => onChange({ ...draft, prefix: event.target.value })}
            />
          </Field>
        </div>
      ) : null}
    </>
  );
}

export function ModelsSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const toast = useToast();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [defaultModelId, setDefaultModelId] = useState("");
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<ModelSpec | null>(null);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);

  const refresh = useCallback(async () => {
    const [providerList, modelList] = await Promise.all([api.providers(), api.models()]);
    setProviders(providerList);
    setModels(modelList.items);
    setDefaultModelId(modelList.defaultModelId);
    await reload();
  }, [reload]);

  useEffect(() => {
    void refresh().catch((error: unknown) => toast(String(error), true));
  }, [refresh, toast]);

  return (
    <>
      <Section
        title="提供方"
        hint="一个 Base URL 加一把密钥，密钥也可以改走自定义请求头或干脆不带。同一个网关可以同时挂不同接口模式的模型。"
        actions={
          <Button size="sm" onClick={() => setAddingProvider((value) => !value)}>
            {addingProvider ? "取消" : "添加"}
          </Button>
        }
      >
        {addingProvider ? (
          <SectionBody>
            <ProviderForm
              onSubmit={async (input) => {
                const ok = await act(() => api.createProvider(input), "已添加提供方");
                if (ok) {
                  setAddingProvider(false);
                  await refresh();
                }
              }}
            />
          </SectionBody>
        ) : null}
        {providers.map((provider) => {
          // A provider hosting only local backends needs no key, and telling its
          // owner one is missing would be a warning about nothing. A declared
          // keyless style says the same thing outright, whatever it hosts.
          const rows = models.filter((model) => model.providerId === provider.id);
          const keyless = provider.auth?.style === "none";
          const wantsKey = !keyless && (rows.length === 0 || rows.some((model) => needsApiKey(model.apiMode)));
          const customHeader = provider.auth?.style === "header" ? provider.auth.header : "";
          return (
            <Row key={provider.id}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <strong className="truncate text-sm">{provider.name}</strong>
                  {keyless ? (
                    <Badge tone="outline">不带凭证</Badge>
                  ) : provider.hasKey ? (
                    <Badge tone="success">已配置密钥</Badge>
                  ) : wantsKey ? (
                    <Badge tone="warning">缺少密钥</Badge>
                  ) : (
                    <Badge tone="outline">本地 · 无需密钥</Badge>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {provider.baseUrl}
                  {customHeader ? ` · ${customHeader}` : ""}
                </div>
              </div>
              {!keyless && (wantsKey || provider.hasKey) ? (
                <>
                  <Input
                    className="h-8 w-40 text-sm"
                    type="password"
                    placeholder={provider.hasKey ? "替换密钥" : "填写 API Key"}
                    value={keyDrafts[provider.id] ?? ""}
                    onChange={(event) =>
                      setKeyDrafts((current) => ({
                        ...current,
                        [provider.id]: event.target.value,
                      }))
                    }
                  />
                  <Button
                    size="sm"
                    disabled={!keyDrafts[provider.id]?.trim()}
                    onClick={async () => {
                      const ok = await act(
                        () => api.setProviderKey(provider.id, keyDrafts[provider.id]!.trim()),
                        "密钥已保存",
                      );
                      if (ok) {
                        setKeyDrafts((current) => ({
                          ...current,
                          [provider.id]: "",
                        }));
                        await refresh();
                      }
                    }}
                  >
                    保存
                  </Button>
                </>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="编辑提供方"
                onClick={() => setEditingProvider(provider)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="删除提供方"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void act(() => api.deleteProvider(provider.id)).then(refresh)}
              >
                <Trash2 />
              </Button>
            </Row>
          );
        })}
      </Section>

      <Catalogue providers={providers} onAdded={refresh} />

      <Section
        title="模型"
        hint="启用决定能不能用，星标决定是否出现在对话右上角。图片与视频模型交给创作台和生成工具。"
        actions={
          <Button
            size="sm"
            onClick={() =>
              setEditing({
                id: "",
                name: "",
                providerId: providers[0]?.id ?? "",
                model: "",
                kind: "chat",
                ops: [],
                enabled: true,
                pinned: true,
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 8192,
                thinkingLevel: "off",
                apiMode: "openai-chat",
                librechatCompat: false,
                sortOrder: models.length,
              })
            }
          >
            添加
          </Button>
        }
      >
        {models.map((model) => (
          <Row key={model.id}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <strong className="text-sm">{model.name}</strong>
                {model.id === defaultModelId ? <Badge tone="success">默认</Badge> : null}
                {isChatKind(model.kind) ? null : (
                  <Badge tone="accent">
                    {KIND_LABEL[model.kind] ?? model.kind}
                    {model.ops.length ? ` · ${model.ops.map((op) => OP_LABELS[op]).join(" / ")}` : ""}
                  </Badge>
                )}
                {model.configured ? null : <Badge tone="danger">提供方缺少密钥</Badge>}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {model.providerId} · {model.model} · {apiModeLabel(model.apiMode)}
                {isChatKind(model.kind) ? ` · ${(model.contextWindow / 1000).toFixed(0)}k 上下文` : ""}
                {model.reasoning ? ` · 思考 ${model.thinkingLevel}` : ""}
              </div>
            </div>
            <Switch
              checked={model.enabled}
              onChange={(value) => void act(() => api.updateModel(model.id, { enabled: value })).then(refresh)}
            />
            {isChatKind(model.kind) ? (
              <Tooltip label={model.pinned ? "从对话切换器移除" : "固定到对话切换器"}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="固定"
                  className={model.pinned ? "text-warning" : "text-muted-foreground"}
                  onClick={() => void act(() => api.updateModel(model.id, { pinned: !model.pinned })).then(refresh)}
                >
                  <Star className={model.pinned ? "fill-current" : undefined} />
                </Button>
              </Tooltip>
            ) : null}
            <Button
              size="sm"
              disabled={model.id === defaultModelId || !model.enabled || !isChatKind(model.kind)}
              onClick={() => void act(() => api.setDefaultModel(model.id), "已设为默认").then(refresh)}
            >
              设为默认
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="编辑" onClick={() => setEditing(model)}>
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="删除"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => void act(() => api.deleteModel(model.id)).then(refresh)}
            >
              <Trash2 />
            </Button>
          </Row>
        ))}
      </Section>

      {editingProvider ? (
        <ProviderEditor
          provider={editingProvider}
          onCancel={() => setEditingProvider(null)}
          onSave={async (input) => {
            const ok = await act(() => api.updateProvider(editingProvider.id, input), "已保存提供方");
            if (ok) {
              setEditingProvider(null);
              await refresh();
            }
          }}
        />
      ) : null}

      {editing ? (
        <ModelEditor
          model={editing}
          providers={providers}
          onCancel={() => setEditing(null)}
          onSave={async (next, isNew) => {
            const ok = await act(() => (isNew ? api.createModel(next) : api.updateModel(next.id, next)), "已保存模型");
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

/**
 * The provider's live catalogue. Aggregators list hundreds of models, so this
 * is a search-and-tick list rather than a dropdown: filter, select the handful
 * you want, add them in one write, then adjust the details afterwards.
 */
function Catalogue({ providers, onAdded }: { providers: Provider[]; onAdded: () => Promise<void> }) {
  const act = useAction();
  const toast = useToast();
  const [providerId, setProviderId] = useState("");
  const [items, setItems] = useState<DiscoveredModel[] | null>(null);
  const [needle, setNeedle] = useState("");
  const [kind, setKind] = useState<"all" | ModelKind>("all");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const active = providerId || providers[0]?.id || "";
  const visible = (items ?? []).filter(
    (item) =>
      item.model.toLowerCase().includes(needle.trim().toLowerCase()) &&
      (kind === "all" || item.suggestion.kind === kind),
  );

  const pull = async () => {
    setLoading(true);
    try {
      setItems((await api.remoteModels(active)).items);
      setPicked(new Set());
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (model: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(model)) next.add(model);
      return next;
    });

  // Only the kinds actually on offer, so the filter never shows an empty option.
  const kinds = [...new Set((items ?? []).map((item) => item.suggestion.kind))];

  return (
    <Section
      title="从提供方添加"
      hint="拉取提供方的模型列表，勾选需要的批量加入，省去逐个手填。图片与视频模型会被识别出来。"
      actions={
        <div className="flex items-center gap-2">
          {loading ? <Spinner className="text-muted-foreground" /> : null}
          <Select
            value={active}
            className="h-8 max-w-40 text-sm"
            options={providers.map((provider) => ({
              value: provider.id,
              label: provider.name,
            }))}
            onChange={setProviderId}
          />
          <Button size="sm" disabled={!active} onClick={() => void pull()}>
            拉取列表
          </Button>
        </div>
      }
    >
      {items ? (
        <>
          <div className="flex flex-col gap-2 border-b px-4 py-3">
            <div className="flex gap-2">
              <Input
                className="flex-1"
                placeholder={`在 ${items.length} 个模型里筛选，例如 grok / seedream`}
                value={needle}
                onChange={(event) => setNeedle(event.target.value)}
              />
              <Button
                variant="primary"
                disabled={picked.size === 0}
                onClick={async () => {
                  const chosen = items.filter((item) => picked.has(item.model));
                  const ok = await act(
                    () =>
                      api.createModels(
                        active,
                        chosen.map((item) => ({
                          ...item.suggestion,
                          providerId: active,
                          model: item.model,
                          enabled: true,
                          // Adding in bulk should not rearrange the switcher;
                          // pin deliberately, one star at a time.
                          pinned: false,
                          contextWindow: 128000,
                          maxTokens: 16384,
                          thinkingLevel: item.suggestion.reasoning ? "high" : "off",
                        })),
                      ),
                    `已添加 ${picked.size} 个模型`,
                  );
                  if (ok) {
                    setPicked(new Set());
                    setItems(null);
                    await onAdded();
                  }
                }}
              >
                添加所选（{picked.size}）
              </Button>
            </div>
            {kinds.length > 1 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {(["all", ...kinds] as Array<"all" | ModelKind>).map((option) => (
                  <button
                    key={option}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs transition-colors",
                      kind === option ? "border-primary bg-primary/10" : "text-muted-foreground hover:bg-accent",
                    )}
                    onClick={() => setKind(option)}
                  >
                    {option === "all" ? "全部" : (KIND_LABEL[option] ?? option)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {visible.slice(0, 40).map((item) => (
            <label
              key={item.model}
              className={cn(
                "flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0",
                item.added ? "opacity-60" : "cursor-pointer hover:bg-accent/40",
              )}
            >
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-primary)]"
                disabled={item.added}
                checked={picked.has(item.model)}
                onChange={() => toggle(item.model)}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{item.model}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {KIND_LABEL[item.suggestion.kind] ?? item.suggestion.kind} · {apiModeLabel(item.suggestion.apiMode)}
                  {item.suggestion.ops.length ? ` · ${item.suggestion.ops.map((op) => OP_LABELS[op]).join(" / ")}` : ""}
                  {item.suggestion.reasoning ? " · 推理" : ""}
                  {item.suggestion.input.includes("image") ? " · 图片输入" : ""}
                </div>
              </div>
              {item.added ? <Badge tone="success">已添加</Badge> : null}
            </label>
          ))}
          {visible.length > 40 ? (
            <SectionBody>
              <p className="text-xs text-muted-foreground">
                还有 {visible.length - 40} 个未显示，继续输入关键词缩小范围。
              </p>
            </SectionBody>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function ProviderForm({ onSubmit }: { onSubmit: (input: ProviderInput) => Promise<void> }) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [auth, setAuth] = useState<AuthDraft>(authDraft(null));

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="名称">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Base URL">
          <Input
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </Field>
      </div>
      <AuthFields draft={auth} onChange={setAuth} />
      {auth.style === "none" ? null : (
        <Field label="API Key（可选，稍后也能填）">
          <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
        </Field>
      )}
      <div>
        <Button
          variant="primary"
          disabled={!name.trim() || !baseUrl.trim() || !authReady(auth)}
          onClick={() =>
            void onSubmit({
              name: name.trim(),
              baseUrl: baseUrl.trim(),
              apiKey: auth.style === "none" ? undefined : apiKey.trim() || undefined,
              auth: authInput(auth),
            })
          }
        >
          添加
        </Button>
      </div>
    </>
  );
}

function ProviderEditor({
  provider,
  onCancel,
  onSave,
}: {
  provider: Provider;
  onCancel: () => void;
  onSave: (input: ProviderInput) => Promise<void>;
}) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [auth, setAuth] = useState<AuthDraft>(authDraft(provider.auth));

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onCancel()}
      title={`编辑 ${provider.name}`}
      description="密钥在列表里单独填写，这里只改地址与凭证的呈现方式。"
      className="w-[min(36rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !baseUrl.trim() || !authReady(auth)}
            onClick={() =>
              void onSave({
                name: name.trim(),
                baseUrl: baseUrl.trim(),
                auth: authInput(auth),
              })
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
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Base URL">
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </Field>
        </div>
        <AuthFields draft={auth} onChange={setAuth} />
      </div>
    </Modal>
  );
}

function ModelEditor({
  model,
  providers,
  onCancel,
  onSave,
}: {
  model: ModelSpec;
  providers: Provider[];
  onCancel: () => void;
  onSave: (model: ModelSpec, isNew: boolean) => Promise<void>;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<ModelSpec>(model);
  const [catalogue, setCatalogue] = useState<string[]>([]);
  // Edited as text so a half-typed object is not thrown away on every keystroke.
  const [paramsText, setParamsText] = useState(model.params ? JSON.stringify(model.params, null, 2) : "");
  const [paramsError, setParamsError] = useState("");
  const isNew = !model.id;
  const generates = isGenerationKind(draft.kind);
  const set = <K extends keyof ModelSpec>(key: K, value: ModelSpec[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const provider = providers.find((item) => item.id === draft.providerId);
  const mode = API_MODES.find((item) => item.id === draft.apiMode);

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onCancel()}
      title={isNew ? "新建模型" : `编辑 ${model.name}`}
      description={`请求地址：${provider?.baseUrl ?? "…"}${mode?.path ?? ""}`}
      className="w-[min(44rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button
            variant="primary"
            disabled={!draft.id.trim() || !draft.model.trim() || !draft.providerId || Boolean(paramsError)}
            onClick={() => void onSave({ ...draft, name: draft.name.trim() || draft.model }, isNew)}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="显示名称">
            <Input value={draft.name} onChange={(event) => set("name", event.target.value)} />
          </Field>
          <Field label="标识（唯一，创建后不可改）">
            <Input
              value={draft.id}
              disabled={!isNew}
              placeholder="grok-4.6"
              onChange={(event) => set("id", event.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="提供方">
            <Select
              value={draft.providerId}
              options={providers.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
              onChange={(value) => set("providerId", value)}
            />
          </Field>
          <Field label="模型 ID">
            <div className="flex gap-2">
              <Input
                className="flex-1"
                list="remote-models"
                value={draft.model}
                onChange={(event) => set("model", event.target.value)}
              />
              <Button
                onClick={async () => {
                  try {
                    const remote = await api.remoteModels(draft.providerId);
                    setCatalogue(remote.items.map((item) => item.model));
                    toast("已拉取模型列表");
                  } catch (error) {
                    toast(error instanceof Error ? error.message : String(error), true);
                  }
                }}
              >
                拉取
              </Button>
            </div>
            <datalist id="remote-models">
              {catalogue.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="接口模式" hint="模式决定这个模型能做什么">
            <Select
              value={draft.apiMode}
              options={API_MODES.map((item) => ({
                value: item.id,
                label: item.label,
                hint: item.path,
              }))}
              onChange={(value) => {
                const apiMode = value as ApiMode;
                const kinds = API_MODES.find((item) => item.id === apiMode)?.kinds ?? ["chat"];
                setDraft((current) => ({
                  ...current,
                  apiMode,
                  // The mode decides what a model can be, so a switch that makes
                  // the current kind impossible moves it rather than leaving a
                  // row nothing can run.
                  kind: kinds.includes(current.kind) ? current.kind : (kinds[0] ?? "chat"),
                }));
              }}
            />
          </Field>
          <Field label="用途">
            <Select
              value={draft.kind}
              options={(mode?.kinds ?? ["chat"]).map((kind) => ({
                value: kind,
                label: KIND_LABEL[kind] ?? kind,
              }))}
              onChange={(value) => set("kind", value as ModelKind)}
            />
          </Field>
        </div>

        {generates ? (
          <>
            <Field label="支持的操作">
              <div className="flex flex-wrap gap-4">
                {(draft.kind === "video"
                  ? (["text_to_video", "image_to_video"] as GenerationOp[])
                  : (["text_to_image", "image_to_image"] as GenerationOp[])
                ).map((op) => (
                  <Switch
                    key={op}
                    label={OP_LABELS[op]}
                    checked={draft.ops.includes(op)}
                    onChange={(value) =>
                      set("ops", value ? [...draft.ops, op] : draft.ops.filter((item) => item !== op))
                    }
                  />
                ))}
              </div>
            </Field>
            <Field
              label="适配器参数（JSON）"
              error={paramsError}
              hint="ComfyUI 工作流写 workflow 与 bind；托管接口写 sizes、durations 等。留空使用适配器默认。"
            >
              <Textarea
                className="font-mono text-xs"
                rows={6}
                value={paramsText}
                onChange={(event) => setParamsText(event.target.value)}
                onBlur={() => {
                  try {
                    const parsed = paramsText.trim() ? (JSON.parse(paramsText) as Record<string, unknown>) : null;
                    set("params", parsed);
                    setParamsError("");
                  } catch (error) {
                    setParamsError(error instanceof Error ? error.message : "JSON 无效");
                  }
                }}
              />
            </Field>
            <Switch label="启用" checked={draft.enabled} onChange={(value) => set("enabled", value)} />
          </>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="上下文窗口">
                <Input
                  type="number"
                  value={draft.contextWindow}
                  onChange={(event) => set("contextWindow", Number(event.target.value))}
                />
              </Field>
              <Field
                label="最大输出"
                hint={
                  draft.librechatCompat
                    ? "已开启「LibreChat 精简请求体」，token 上限字段不会发给网关；这里的值只用于本地预留上下文空间。"
                    : undefined
                }
              >
                <Input
                  type="number"
                  value={draft.maxTokens}
                  onChange={(event) => set("maxTokens", Number(event.target.value))}
                />
              </Field>
              <Field label="思考等级">
                <Select
                  value={draft.thinkingLevel}
                  options={THINKING_OPTIONS.map((option) => ({
                    value: option,
                    label: option,
                  }))}
                  onChange={(value) => set("thinkingLevel", value as ThinkingLevel)}
                />
              </Field>
            </div>

            <Field label="温度（留空跟随服务端默认）">
              <Input
                type="number"
                step="0.1"
                value={draft.temperature ?? ""}
                onChange={(event) => set("temperature", event.target.value === "" ? null : Number(event.target.value))}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Switch label="启用" checked={draft.enabled} onChange={(value) => set("enabled", value)} />
              <Switch label="固定到对话切换器" checked={draft.pinned} onChange={(value) => set("pinned", value)} />
              <Switch label="推理模型" checked={draft.reasoning} onChange={(value) => set("reasoning", value)} />
              <Switch
                label="支持图片输入"
                checked={draft.input.includes("image")}
                onChange={(value) => set("input", value ? ["text", "image"] : ["text"])}
              />
              <Switch
                label="LibreChat 精简请求体"
                hint="去掉 stream_options、store、token 上限与缓存字段，并把纯文本压成字符串；部分网关只接受这种形式。"
                checked={draft.librechatCompat}
                onChange={(value) => set("librechatCompat", value)}
              />
            </div>

            <Field label="模型专属系统提示（留空使用全局）">
              <Textarea
                rows={3}
                value={draft.systemPrompt ?? ""}
                onChange={(event) => set("systemPrompt", event.target.value || null)}
              />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
