/**
 * Profiles: the named bundle a conversation runs under — which models, which
 * tools, which MCP servers, which prompts (`03-generation.md §Profiles`).
 *
 * A deployment with no profiles behaves exactly as it did before they existed,
 * so this page is additive: nothing here has to be filled in.
 */
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { McpServer, ModelSpec, Profile, ProfileCapabilities } from "@shared/types.ts";
import { isChatKind } from "@shared/types.ts";
import { api } from "../../api.ts";
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Row,
  Section,
  SectionBody,
  Select,
  Switch,
  Textarea,
  useAction,
  useToast,
} from "../../ui.tsx";

const CAPABILITIES: Array<{ key: keyof ProfileCapabilities; label: string; hint: string }> = [
  { key: "generation", label: "图像与视频生成", hint: "对话里可以自己画图、做视频" },
  { key: "web", label: "联网搜索", hint: "先在「能力」里配好搜索" },
  { key: "files", label: "文件检索", hint: "搜你上传的文档" },
  { key: "memory", label: "记忆", hint: "跨对话记住少量事实" },
  { key: "skills", label: "技能", hint: "从 data/skills 加载" },
  { key: "coding", label: "代码工具", hint: "在工作目录里读写、跑命令" },
];

const BLANK: Profile = {
  id: "",
  name: "",
  chatModelId: "",
  imageModelId: "",
  editModelId: "",
  videoModelId: "",
  capabilities: { memory: true, files: true, web: true, coding: false, skills: true, generation: true },
  mcpServers: [],
  globalPrompt: "",
  toolPrompt: "",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

export function ProfilesSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const toast = useToast();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState("");
  const [models, setModels] = useState<ModelSpec[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [editing, setEditing] = useState<Profile | null>(null);

  const refresh = useCallback(async () => {
    const [list, modelList, mcp] = await Promise.all([api.profiles(), api.models(), api.mcpServers()]);
    setProfiles(list.items);
    setDefaultProfileId(list.defaultProfileId);
    setModels(modelList.items);
    setServers(mcp.items);
    await reload();
  }, [reload]);

  useEffect(() => {
    void refresh().catch((error: unknown) => toast(String(error), true));
  }, [refresh, toast]);

  const nameOf = (id: string) => models.find((model) => model.id === id)?.name ?? "";

  return (
    <>
      <Section
        title="对话预设"
        hint="一次换模型、能力和工具。空着的项跟全局走。"
        actions={
          <Button size="sm" onClick={() => setEditing({ ...BLANK, sortOrder: profiles.length })}>
            <Plus />
            新建
          </Button>
        }
      >
        {profiles.length === 0 ? (
          <SectionBody>
            <p className="text-sm text-muted-foreground">
              还没有预设。可以按用途各建一个，例如「写作」只留联网与文件，「画图」打开生成并指定本地
              ComfyUI，「写代码」打开代码工具。
            </p>
          </SectionBody>
        ) : (
          profiles.map((profile) => (
            <Row key={profile.id}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="text-sm">{profile.name}</strong>
                  {profile.id === defaultProfileId ? <Badge tone="success">默认</Badge> : null}
                  {Object.entries(profile.capabilities)
                    .filter(([, on]) => on)
                    .map(([key]) => (
                      <Badge key={key} tone="outline">
                        {CAPABILITIES.find((item) => item.key === key)?.label ?? key}
                      </Badge>
                    ))}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {[
                    nameOf(profile.chatModelId) && `对话 ${nameOf(profile.chatModelId)}`,
                    nameOf(profile.imageModelId) && `图片 ${nameOf(profile.imageModelId)}`,
                    nameOf(profile.editModelId) && `编辑 ${nameOf(profile.editModelId)}`,
                    nameOf(profile.videoModelId) && `视频 ${nameOf(profile.videoModelId)}`,
                    profile.mcpServers.length ? `${profile.mcpServers.length} 个 MCP` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ") || "全部跟随全局设置"}
                </div>
              </div>
              <Button
                size="sm"
                disabled={profile.id === defaultProfileId}
                onClick={() => void act(() => api.setDefaultProfile(profile.id), "已设为默认").then(refresh)}
              >
                设为默认
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="编辑" onClick={() => setEditing(profile)}>
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="删除"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void act(() => api.deleteProfile(profile.id)).then(refresh)}
              >
                <Trash2 />
              </Button>
            </Row>
          ))
        )}
      </Section>

      {/* Shown as soon as a preset exists, including before one has been made the
          default: without a choice here new conversations follow the global
          settings, and that has to be visible rather than inferred. */}
      {profiles.length ? (
        <Section title="默认预设">
          <SectionBody>
            <Field label="新对话使用">
              <Select
                value={defaultProfileId}
                options={[
                  { value: "", label: "不使用预设", hint: "跟随全局模型与能力" },
                  ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
                ]}
                onChange={(value) => void act(() => api.setDefaultProfile(value), "已保存").then(refresh)}
              />
            </Field>
          </SectionBody>
        </Section>
      ) : null}

      {editing ? (
        <ProfileEditor
          profile={editing}
          models={models}
          servers={servers}
          onCancel={() => setEditing(null)}
          onSave={async (next, isNew) => {
            const ok = await act(
              () => (isNew ? api.createProfile(next) : api.updateProfile(next.id, next)),
              "已保存预设",
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

function ProfileEditor({
  profile,
  models,
  servers,
  onCancel,
  onSave,
}: {
  profile: Profile;
  models: ModelSpec[];
  servers: McpServer[];
  onCancel: () => void;
  onSave: (profile: Profile, isNew: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState(profile);
  const isNew = !profile.id;
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  /** Only models that can actually serve this slot, plus a "follow global" row. */
  const pick = (kind: ModelSpec["kind"], op?: string) => [
    { value: "", label: "跟随全局", hint: "使用全局默认模型" },
    ...models
      .filter(
        (model) =>
          model.kind === kind && model.enabled && (!op || model.ops.includes(op as never)),
      )
      .map((model) => ({ value: model.id, label: model.name, hint: model.providerId })),
  ];

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onCancel()}
      title={isNew ? "新建预设" : `编辑 ${profile.name}`}
      description="只填这个预设要改的部分，其余跟全局走。"
      className="w-[min(44rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button variant="primary" disabled={!draft.name.trim()} onClick={() => void onSave(draft, isNew)}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="名称">
            <Input
              value={draft.name}
              placeholder="例如 画图"
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field label="标识（留空自动生成）">
            <Input
              value={draft.id}
              disabled={!isNew}
              placeholder="drawing"
              onChange={(event) => set("id", event.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="对话模型">
            <Select
              value={draft.chatModelId}
              options={[
                { value: "", label: "跟随全局", hint: "使用全局默认模型" },
                ...models
                  .filter((model) => isChatKind(model.kind) && model.enabled)
                  .map((model) => ({ value: model.id, label: model.name, hint: model.providerId })),
              ]}
              onChange={(value) => set("chatModelId", value)}
            />
          </Field>
          <Field label="图片模型">
            <Select
              value={draft.imageModelId}
              options={pick("image", "text_to_image")}
              onChange={(value) => set("imageModelId", value)}
            />
          </Field>
          <Field label="图像编辑模型" hint="留空则用上面那个，如果它本身能改图。">
            <Select
              value={draft.editModelId}
              options={pick("image", "image_to_image")}
              onChange={(value) => set("editModelId", value)}
            />
          </Field>
          <Field label="视频模型">
            <Select
              value={draft.videoModelId}
              options={pick("video")}
              onChange={(value) => set("videoModelId", value)}
            />
          </Field>
        </div>

        <Field label="能力">
          <div className="grid gap-3 sm:grid-cols-2">
            {CAPABILITIES.map(({ key, label, hint }) => (
              <Switch
                key={key}
                label={label}
                hint={hint}
                checked={draft.capabilities[key]}
                onChange={(value) => set("capabilities", { ...draft.capabilities, [key]: value })}
              />
            ))}
          </div>
        </Field>

        <Field label="MCP 服务器" hint="不选就用全局已启用的那些">
          {servers.length === 0 ? (
            <p className="text-xs text-muted-foreground">还没有配置 MCP 服务器。</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {servers.map((server) => (
                <Switch
                  key={server.id}
                  label={server.title}
                  checked={draft.mcpServers.includes(server.id)}
                  onChange={(value) =>
                    set(
                      "mcpServers",
                      value
                        ? [...draft.mcpServers, server.id]
                        : draft.mcpServers.filter((id) => id !== server.id),
                    )
                  }
                />
              ))}
            </div>
          )}
        </Field>

        <Field label="全局提示覆盖（留空使用全局）">
          <Textarea
            rows={4}
            value={draft.globalPrompt}
            onChange={(event) => set("globalPrompt", event.target.value)}
          />
        </Field>
        <Field label="工具提示覆盖（留空使用全局）">
          <Textarea rows={4} value={draft.toolPrompt} onChange={(event) => set("toolPrompt", event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
