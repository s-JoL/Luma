import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { isMemoryKey } from "@shared/types.ts";
import { api, type MemorySnapshot } from "../api.ts";
import {
  Badge,
  Button,
  Empty,
  Field,
  formatTime,
  Input,
  Modal,
  PageBody,
  PageHeader,
  Section,
  SectionBody,
  Textarea,
  useAction,
  useToast,
} from "../ui.tsx";

export function Memory({ onOpenRail }: { onOpenRail: () => void }) {
  const toast = useToast();
  const act = useAction();
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Keys the reader coined here; they become real once a value is saved. */
  const [added, setAdded] = useState<string[]>([]);
  const [naming, setNaming] = useState(false);
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    api
      .memory()
      .then(setSnapshot)
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), true));
  }, [toast]);

  if (!snapshot) return <Empty>正在加载…</Empty>;

  const stored = new Map(snapshot.items.map((item) => [item.key, item]));
  const existingKeys = new Set([...stored.keys(), ...added, ...snapshot.suggestedKeys]);
  // Stored keys first, then anything just added here, so a subject the model or
  // the reader coined is never hidden behind the suggestions neither of them used.
  const keys = [...existingKeys];
  const usage = snapshot.limit ? Math.min(100, (snapshot.tokens / snapshot.limit) * 100) : 0;

  /** Drops the draft so the field falls back to what the server now holds. */
  const forget = (key: string) =>
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)));

  const save = async (key: string) => {
    const value = (drafts[key] ?? stored.get(key)?.value ?? "").trim();
    if (!value) return;
    const ok = await act(async () => setSnapshot(await api.setMemory(key, value)), "已保存");
    if (ok) forget(key);
  };

  return (
    <>
      <PageHeader title="记忆" onOpenRail={onOpenRail}>
        <span className="text-xs text-muted-foreground">
          {snapshot.tokens} / {snapshot.limit} tokens
        </span>
        <Button size="sm" onClick={() => setNaming(true)}>
          <Plus />
          新建条目
        </Button>
      </PageHeader>

      <PageBody>
        <div className="flex flex-col gap-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={usage > 90 ? "h-full rounded-full bg-warning" : "h-full rounded-full bg-primary"}
              style={{ width: `${usage}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            对话会带上这些条目。空槽是建议，模型也可以自己起名。单条最多 {snapshot.charLimit} 字。
          </p>
        </div>

        {keys.length === 0 ? (
          <Section>
            <SectionBody>
              <p className="text-sm text-muted-foreground">
                还没有任何条目。点右上角「新建条目」起一个键名，模型也会在对话里自己记下值得记的事。
              </p>
            </SectionBody>
          </Section>
        ) : null}

        {keys.map((key) => {
          const item = stored.get(key);
          const value = drafts[key] ?? item?.value ?? "";
          const dirty = value !== (item?.value ?? "");
          return (
            <Section
              key={key}
              title={<span className="font-mono text-xs">{key}</span>}
              actions={
                item ? (
                  <span className="text-xs text-muted-foreground">
                    {item.tokens} tokens · {formatTime(item.updatedAt)}
                  </span>
                ) : (
                  <Badge tone="outline">空</Badge>
                )
              }
            >
              <SectionBody className="gap-3">
                <Textarea
                  rows={Math.min(10, Math.max(3, value.split("\n").length + 1))}
                  value={value}
                  placeholder="尚未记录"
                  onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                />
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" disabled={!dirty || !value.trim()} onClick={() => void save(key)}>
                    保存
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    disabled={!item}
                    onClick={() =>
                      void act(async () => {
                        setSnapshot(await api.deleteMemory(key));
                        forget(key);
                      }, "已删除")
                    }
                  >
                    删除
                  </Button>
                  <span
                    className={
                      value.length > snapshot.charLimit
                        ? "ml-auto text-xs text-destructive"
                        : "ml-auto text-xs text-muted-foreground"
                    }
                  >
                    {value.length} / {snapshot.charLimit}
                  </span>
                </div>
              </SectionBody>
            </Section>
          );
        })}
      </PageBody>

      <Modal
        open={naming}
        onOpenChange={(open) => {
          setNaming(open);
          if (!open) setNewKey("");
        }}
        title="新建记忆条目"
        description="先起个键名，保存内容后才会真正写入"
        footer={
          <Button
            variant="primary"
            disabled={Boolean(keyError(newKey, existingKeys))}
            onClick={() => {
              setAdded((current) => [...current, newKey.trim()]);
              setNaming(false);
              setNewKey("");
            }}
          >
            创建
          </Button>
        }
      >
        <Field
          label="键名"
          hint="字母、数字、下划线或连字符，最多 64 个字符"
          error={newKey.trim() ? keyError(newKey, existingKeys) : undefined}
        >
          <Input
            value={newKey}
            autoFocus
            placeholder="例如 coffee_order"
            onChange={(event) => setNewKey(event.target.value)}
          />
        </Field>
      </Modal>
    </>
  );
}

/** The server's own rule, so a key the API would refuse is never offered. */
function keyError(key: string, taken: Set<string>) {
  const name = key.trim();
  if (!name) return "请输入键名";
  if (!isMemoryKey(name)) return "只能使用字母、数字、下划线和连字符，长度 1–64";
  if (taken.has(name)) return "这个键名已经存在";
  return "";
}
