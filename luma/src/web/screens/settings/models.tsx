import { Pencil, Star, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
  StudioTool,
  ThinkingLevel,
} from "@shared/types.ts";
import { API_MODES, isChatKind, isGenerationKind, needsApiKey } from "@shared/types.ts";
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

const THINKING_OPTIONS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const AUTH_OPTIONS: Array<Option<ProviderAuthStyle>> = [
  { value: "bearer", label: "Bearer 令牌", hint: "大多数兼容接口" },
  { value: "header", label: "自定义请求头", hint: "x-api-key、api-key 这类" },
  { value: "none", label: "不带凭证", hint: "本机 Ollama、ComfyUI、llama.cpp" },
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
          <Field label="前缀（可选）" hint="写在密钥前面，例如 Bearer 加空格。留空就只发密钥。">
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

/**
 * Providers and models: read together because every page here needs a
 * provider's name to say anything useful about a model, and one of these
 * pages mounts at a time.
 */
function useCatalogue(reload: () => Promise<void>) {
  const toast = useToast();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [defaults, setDefaults] = useState({
    defaultModelId: "",
    defaultImageModelId: "",
    defaultEditModelId: "",
    defaultVideoModelId: "",
  });
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    const [providerList, modelList] = await Promise.all([api.providers(), api.models()]);
    setProviders(providerList);
    setModels(modelList.items);
    setDefaults({
      defaultModelId: modelList.defaultModelId,
      defaultImageModelId: modelList.defaultImageModelId,
      defaultEditModelId: modelList.defaultEditModelId,
      defaultVideoModelId: modelList.defaultVideoModelId,
    });
    setReady(true);
    await reload();
  }, [reload]);

  useEffect(() => {
    void refresh().catch((error: unknown) => toast(String(error), true));
  }, [refresh, toast]);

  return { providers, models, defaults, refresh, ready };
}

/**
 * Endpoints and credentials, which belong to neither audience alone: an OpenAI
 * key and a ComfyUI address are the same kind of row, and a gateway that answers
 * for both a chat model and an image model is one provider either way.
 */
export function ProvidersSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const { providers, models, refresh, ready } = useCatalogue(reload);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);

  return (
    <>
      <Section
        title="提供方"
        hint="地址和密钥。一个网关可以同时挂对话、生图和视频。"
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
        {!ready ? (
          <SectionBody>
            <Spinner className="text-muted-foreground" />
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
    </>
  );
}

/**
 * The models a conversation runs on. Split from the generation backends because
 * almost nothing is shared: a context window and a thinking level mean nothing to
 * an image model, and an aspect ratio means nothing here. The two used to be one
 * list where every row showed the union of both, and neither read well.
 */
export function ModelsSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const { providers, models, defaults, refresh, ready } = useCatalogue(reload);
  const [editing, setEditing] = useState<ModelSpec | null>(null);
  const chat = models
    .filter((model) => isChatKind(model.kind))
    .slice()
    .sort((a, b) => Number(Boolean(b.configured)) - Number(Boolean(a.configured)));

  return (
    <>
      <Section
        title="对话模型"
        hint="星标出现在对话右上角。默认模型是新对话的起点。"
        actions={
          <Button
            size="sm"
            disabled={!providers.length}
            onClick={() => setEditing(blankModel(providers[0]?.id ?? "", models.length, "chat"))}
          >
            添加
          </Button>
        }
      >
        {!ready ? (
          <SectionBody>
            <Spinner className="text-muted-foreground" />
          </SectionBody>
        ) : providers.length === 0 ? (
          <SectionBody>
            <p className="text-sm text-muted-foreground">先在「提供方」里加一个端点，模型才有地方可去。</p>
          </SectionBody>
        ) : null}
        {chat.map((model) => (
          <Row key={model.id}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <strong className="text-sm">{model.name}</strong>
                {model.id === defaults.defaultModelId ? <Badge tone="success">默认</Badge> : null}
                {model.configured ? null : <Badge tone="danger">提供方缺少密钥</Badge>}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {model.providerId} · {model.model} · {apiModeLabel(model.apiMode)} ·{" "}
                {(model.contextWindow / 1000).toFixed(0)}k 上下文
                {model.reasoning ? ` · 思考 ${model.thinkingLevel}` : ""}
              </div>
            </div>
            <Switch
              checked={model.enabled}
              onChange={(value) => void act(() => api.updateModel(model.id, { enabled: value })).then(refresh)}
            />
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
            <Button
              size="sm"
              disabled={model.id === defaults.defaultModelId || !model.enabled}
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
 * The backends that make pictures and video, and what each one is allowed to do.
 *
 * The defaults at the top are what the agent and a fresh studio form use. The
 * wrench additionally hands a row to the conversation as a tool of its own.
 * A model with neither is still usable by hand in the studio.
 */
export function GenerationSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const toast = useToast();
  const { providers, models, defaults, refresh, ready } = useCatalogue(reload);
  const [editing, setEditing] = useState<ModelSpec | null>(null);
  /** Live schemas, so a row can say which parameters it actually offers. */
  const [tools, setTools] = useState<StudioTool[]>([]);
  const generation = models.filter((model) => isGenerationKind(model.kind));

  useEffect(() => {
    void api
      .studioTools()
      .then((catalogue) => setTools(catalogue.items))
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), true));
  }, [toast]);

  /** A blank generation row wants a mode that can generate, not the chat default. */
  const imageMode = API_MODES.find((mode) => mode.kinds?.includes("image"))?.id ?? "openai-images";
  const images = generation.filter((model) => model.kind === "image" && model.enabled);
  const videos = generation.filter((model) => model.kind === "video" && model.enabled);
  const pickDefaults = (kind: "image" | "video", op?: GenerationOp) => [
    { value: "", label: "按可用后端选" },
    ...generation
      .filter(
        (model) =>
          model.kind === kind &&
          model.enabled &&
          (!op || model.ops.includes(op) || model.ops.length === 0),
      )
      .map((model) => ({ value: model.id, label: model.name, hint: model.providerId })),
  ];
  const setDefault = (slot: "imageModelId" | "editModelId" | "videoModelId", value: string) =>
    void act(() => api.setGenerationDefaults({ [slot]: value }), "已保存").then(refresh);

  return (
    <>
      {images.length || videos.length ? (
        <Section title="默认后端" hint="对话里的生图、改图、做视频走这里。创作台打开时也先选中它们。">
          <SectionBody>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="生图">
                <Select
                  value={defaults.defaultImageModelId}
                  options={pickDefaults("image", "text_to_image")}
                  onChange={(value) => setDefault("imageModelId", value)}
                />
              </Field>
              <Field label="改图">
                <Select
                  value={defaults.defaultEditModelId}
                  options={pickDefaults("image", "image_to_image")}
                  onChange={(value) => setDefault("editModelId", value)}
                />
              </Field>
              <Field label="视频">
                <Select
                  value={defaults.defaultVideoModelId}
                  options={pickDefaults("video")}
                  onChange={(value) => setDefault("videoModelId", value)}
                />
              </Field>
            </div>
          </SectionBody>
        </Section>
      ) : null}

      <Section
        title="生成后端"
        hint="关掉就用不了。扳手是额外给对话一个能点名的工具，创作台不需要。"
        actions={
          <Button
            size="sm"
            disabled={!providers.length}
            onClick={() => setEditing({ ...blankModel(providers[0]?.id ?? "", models.length, "image"), apiMode: imageMode })}
          >
            添加
          </Button>
        }
      >
        {!ready ? (
          <SectionBody>
            <Spinner className="text-muted-foreground" />
          </SectionBody>
        ) : generation.length === 0 ? (
          <SectionBody>
            <p className="text-sm text-muted-foreground">
              还没有生成后端。
            </p>
          </SectionBody>
        ) : null}
        {generation.map((model) => {
          const roles = [
            defaults.defaultImageModelId === model.id ? "默认生图" : "",
            defaults.defaultEditModelId === model.id ? "默认改图" : "",
            defaults.defaultVideoModelId === model.id ? "默认视频" : "",
          ].filter(Boolean);
          const parameters = tools
            .filter((tool) => tool.modelId === model.id)
            .map((tool) => `${tool.op}（${Object.keys(tool.schema.properties ?? {}).length} 项参数）`);
          return (
            <Row key={model.id}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="text-sm">{model.name}</strong>
                  <Badge tone="accent">
                    {model.kind}
                    {model.ops.length ? ` · ${model.ops.join(" / ")}` : ""}
                  </Badge>
                  {model.agentTool ? <Badge tone="success">对话可点名</Badge> : null}
                  {roles.map((role) => (
                    <Badge key={role} tone="outline">
                      {role}
                    </Badge>
                  ))}
                  {!model.agentTool && !roles.length ? <Badge tone="outline">仅创作台</Badge> : null}
                  {model.configured ? null : <Badge tone="danger">提供方缺少密钥</Badge>}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {model.providerId} · {model.model} · {apiModeLabel(model.apiMode)}
                </div>
                {parameters.length ? (
                  <div className="truncate text-xs text-muted-foreground">{parameters.join(" · ")}</div>
                ) : null}
              </div>
              <Switch
                checked={model.enabled}
                onChange={(value) => void act(() => api.updateModel(model.id, { enabled: value })).then(refresh)}
              />
              <Tooltip label={model.agentTool ? "收回这个独立工具" : "作为独立工具提供给对话模型"}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="作为独立工具提供给对话模型"
                  className={model.agentTool ? "text-accent" : "text-muted-foreground"}
                  onClick={() => void act(() => api.updateModel(model.id, { agentTool: !model.agentTool })).then(refresh)}
                >
                  <Wrench />
                </Button>
              </Tooltip>
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
          );
        })}
      </Section>

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

/** A new row, with the fields the other kind will ignore left at their defaults. */
const blankModel = (providerId: string, sortOrder: number, kind: ModelKind): ModelSpec => ({
  id: "",
  name: "",
  providerId,
  model: "",
  kind,
  ops: [],
  enabled: true,
  pinned: kind === "chat",
  agentTool: false,
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 8192,
  thinkingLevel: "off",
  apiMode: "openai-chat",
  librechatCompat: false,
  sortOrder,
});

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
  const pulledFor = useRef("");
  const visible = (items ?? []).filter(
    (item) =>
      item.model.toLowerCase().includes(needle.trim().toLowerCase()) &&
      (kind === "all" || item.suggestion.kind === kind),
  );

  const pull = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    try {
      setItems((await api.remoteModels(active)).items);
      setPicked(new Set());
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setLoading(false);
    }
  }, [active, toast]);

  useEffect(() => {
    if (!active) return;
    const provider = providers.find((item) => item.id === active);
    if (!provider) return;
    const canList = provider.auth?.style === "none" || provider.hasKey;
    if (!canList) {
      if (pulledFor.current === active) pulledFor.current = "";
      return;
    }
    if (pulledFor.current === active) return;
    pulledFor.current = active;
    void pull();
  }, [active, providers, pull]);

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
      hint="有密钥就会自动拉列表。勾上要的，点添加。类型和上下文会先猜一遍，保存前可以改。"
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
            {items ? "重新拉取" : "拉取列表"}
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
                          contextWindow: item.suggestion.contextWindow,
                          maxTokens: item.suggestion.maxTokens,
                          thinkingLevel: item.suggestion.reasoning ? "high" : "off",
                        })),
                      ),
                    `已添加 ${picked.size} 个模型`,
                  );
                  if (ok) {
                    setPicked(new Set());
                    setItems(null);
                    pulledFor.current = "";
                    await onAdded();
                    await pull();
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
                    {option === "all" ? "全部" : option}
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
                  {item.suggestion.kind} · {apiModeLabel(item.suggestion.apiMode)}
                  {item.suggestion.ops.length ? ` · ${item.suggestion.ops.join(" / ")}` : ""}
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
      description="密钥在列表里单独填，这里只改地址和怎么带凭证。"
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
  const [remote, setRemote] = useState<DiscoveredModel[]>([]);
  const applied = useRef("");
  // Edited as text so a half-typed object is not thrown away on every keystroke.
  const [paramsText, setParamsText] = useState(model.params ? JSON.stringify(model.params, null, 2) : "");
  const [paramsError, setParamsError] = useState("");
  const isNew = !model.id;
  const generates = isGenerationKind(draft.kind);
  const set = <K extends keyof ModelSpec>(key: K, value: ModelSpec[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const provider = providers.find((item) => item.id === draft.providerId);
  const mode = API_MODES.find((item) => item.id === draft.apiMode);

  useEffect(() => {
    if (!draft.providerId) return;
    const host = providers.find((item) => item.id === draft.providerId);
    if (host && host.auth?.style !== "none" && !host.hasKey) return;
    let cancelled = false;
    void api
      .remoteModels(draft.providerId)
      .then((data) => {
        if (!cancelled) setRemote(data.items);
      })
      .catch(() => {
        if (!cancelled) setRemote([]);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.providerId, providers]);

  useEffect(() => {
    if (!draft.model) return;
    if (!isNew && draft.model === model.model) return;
    const hit = remote.find((item) => item.model === draft.model);
    if (!hit) return;
    const key = `${draft.providerId}:${draft.model}`;
    if (applied.current === key) return;
    applied.current = key;
    const suggestion = hit.suggestion;
    setDraft((current) => ({
      ...current,
      id: current.id || suggestion.id,
      name: current.name.trim() && current.name !== current.model ? current.name : suggestion.name,
      kind: suggestion.kind,
      ops: suggestion.ops,
      apiMode: suggestion.apiMode,
      reasoning: suggestion.reasoning,
      input: suggestion.input,
      contextWindow: suggestion.contextWindow,
      maxTokens: suggestion.maxTokens,
      thinkingLevel: suggestion.reasoning ? (current.thinkingLevel === "off" ? "high" : current.thinkingLevel) : "off",
    }));
  }, [draft.model, draft.providerId, isNew, model.model, remote]);

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
                    const data = await api.remoteModels(draft.providerId);
                    setRemote(data.items);
                    toast("已更新模型列表");
                  } catch (error) {
                    toast(error instanceof Error ? error.message : String(error), true);
                  }
                }}
              >
                拉取
              </Button>
            </div>
            <datalist id="remote-models">
              {remote.map((item) => (
                <option key={item.model} value={item.model} />
              ))}
            </datalist>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="接口模式">
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
                label: kind,
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
                    label={op}
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
              hint="ComfyUI 写 workflow 和 bind；其他接口写 sizes、durations。留空用默认。"
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
            <Switch
              label="作为独立工具提供给对话模型"
              hint="打开后，对话里可以点名用这个模型。默认走上面选中的那个。"
              checked={draft.agentTool}
              onChange={(value) => set("agentTool", value)}
            />
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
              <Field label="最大输出">
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
                label="精简请求体"
                hint="部分网关不接受完整字段，打开后只发它们认的那些。"
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
