import { Eye, FileText, Pencil, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileFacets, FileKind, FileRecord } from "@shared/types.ts";
import { FILE_SOURCE_LABELS } from "@shared/types.ts";
import { api, type FileHit } from "../api.ts";
import {
  Badge,
  Button,
  cn,
  Field,
  formatBytes,
  formatTime,
  ImageThumb,
  Input,
  Lightbox,
  Modal,
  PageBody,
  PageHeader,
  Row,
  Section,
  SectionBody,
  Spinner,
  Textarea,
  useAction,
  useToast,
} from "../ui.tsx";

const PAGE = 60;

const KIND_LABEL: Record<FileKind, string> = { all: "全部", docs: "文档", images: "图片" };

const STATUS: Record<string, { text: string; tone: "success" | "warning" | "danger" | "outline" }> = {
  ready: { text: "已索引", tone: "success" },
  pending: { text: "索引中", tone: "warning" },
  failed: { text: "失败", tone: "danger" },
  none: { text: "未索引", tone: "outline" },
};

const EMPTY_FACETS: FileFacets = { kinds: { all: 0, docs: 0, images: 0 }, sources: [] };

const sourceLabel = (id: string) => FILE_SOURCE_LABELS[id] ?? id;

/** Text documents are the only ones that can be opened in the built-in editor. */
const isEditable = (file: FileRecord) => file.mime.startsWith("text/") || file.mime === "application/json";

function Chip({ on, count, children, onClick }: { on: boolean; count?: number; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        on ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent",
      )}
      onClick={onClick}
    >
      {children}
      {count === undefined ? null : <span className="text-muted-foreground">{count}</span>}
    </button>
  );
}

export function Files({ onOpenRail }: { onOpenRail: () => void }) {
  const toast = useToast();
  const act = useAction();
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [facets, setFacets] = useState<FileFacets>(EMPTY_FACETS);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState<FileKind>("all");
  const [source, setSource] = useState("all");
  const [needle, setNeedle] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FileHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; text: string } | null>(null);
  const [zoom, setZoom] = useState("");

  const filter = useMemo(() => ({ kind, source, q: needle.trim() }), [kind, source, needle]);

  const refresh = useCallback(
    async (limit = shown) => {
      const library = await api.files({ ...filter, limit, offset: 0 });
      setFiles(library.items);
      setFacets(library.facets);
      setTotal(library.total);
    },
    [filter, shown],
  );

  // A changed filter always restarts at the first page.
  useEffect(() => {
    setShown(PAGE);
    void api
      .files({ ...filter, limit: PAGE, offset: 0 })
      .then((library) => {
        setFiles(library.items);
        setFacets(library.facets);
        setTotal(library.total);
      })
      .catch((error: unknown) => toast(String(error), true));
  }, [filter, toast]);

  // Indexing runs in the background, so poll while anything is pending.
  useEffect(() => {
    if (!files.some((file) => file.embeddingStatus === "pending")) return;
    const timer = setInterval(() => void refresh().catch(() => undefined), 1500);
    return () => clearInterval(timer);
  }, [files, refresh]);

  const upload = async (list: FileList | File[]) => {
    setBusy(true);
    for (const file of Array.from(list)) await act(() => api.upload(file));
    setBusy(false);
    await refresh();
  };

  const search = async () => {
    const text = query.trim();
    if (!text) {
      setHits(null);
      return;
    }
    setBusy(true);
    try {
      setHits((await api.searchFiles(text)).results);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="文件库" onOpenRail={onOpenRail}>
        {busy ? <Spinner className="text-muted-foreground" /> : null}
        <Button size="sm" onClick={() => setEditing({ id: "", name: "", text: "" })}>
          新建文档
        </Button>
        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
          <Upload className="size-3.5" />
          上传
          <input
            type="file"
            multiple
            className="sr-only"
            aria-label="上传文件"
            onChange={(event) => {
              if (event.target.files?.length) void upload(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
      </PageHeader>

      <div
        className="flex min-h-0 flex-1 flex-col"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
        }}
      >
        <PageBody>
          <Section title="检索测试" hint="用一个真实问题验证 file_search 会取回哪些片段">
            <SectionBody>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    value={query}
                    placeholder="输入问题，看看会检索到什么"
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void search();
                    }}
                  />
                </div>
                <Button onClick={() => void search()}>检索</Button>
              </div>
              {hits?.length === 0 ? (
                <p className="text-sm text-muted-foreground">没有命中任何片段。</p>
              ) : null}
              {hits?.map((hit) => (
                <div key={hit.chunkId} className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone="outline">{hit.matchType}</Badge>
                    <strong className="text-sm">{hit.name}</strong>
                    <span className="text-muted-foreground">
                      片段 {hit.chunk}
                      {hit.page ? ` · 第 ${hit.page} 页` : ""}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                    {hit.excerpt.slice(0, 320)}
                    {hit.excerpt.length > 320 ? "…" : ""}
                  </p>
                </div>
              ))}
            </SectionBody>
          </Section>

          <Section
            title={`文件（${total}）`}
            actions={
              <Input
                className="h-8 max-w-50 text-sm"
                placeholder="按文件名筛选"
                value={needle}
                onChange={(event) => setNeedle(event.target.value)}
              />
            }
          >
            <div className="flex flex-col gap-2 border-b px-4 py-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-muted-foreground">类型</span>
                {(["all", "docs", "images"] as FileKind[]).map((option) => (
                  <Chip
                    key={option}
                    on={kind === option}
                    count={facets.kinds[option]}
                    onClick={() => setKind(option)}
                  >
                    {KIND_LABEL[option]}
                  </Chip>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-muted-foreground">来源</span>
                <Chip on={source === "all"} onClick={() => setSource("all")}>
                  全部
                </Chip>
                {facets.sources.map((entry) => (
                  <Chip
                    key={entry.id}
                    on={source === entry.id}
                    count={entry.count}
                    onClick={() => setSource(entry.id)}
                  >
                    {sourceLabel(entry.id)}
                  </Chip>
                ))}
              </div>
            </div>

            {files.length === 0 ? (
              <SectionBody>
                <p className="text-sm text-muted-foreground">
                  没有符合条件的文件。拖拽到此页面可以上传，生成的图片也会自动进入这里。
                </p>
              </SectionBody>
            ) : (
              files.map((file) => {
                const status = STATUS[file.embeddingStatus] ?? STATUS.none!;
                const isImage = file.mime.startsWith("image/");
                return (
                  // The row's default first-child width is meant for a label,
                  // and it stretched the thumbnail into a strip.
                  <Row key={file.id} className="[&>*:first-child]:min-w-0">
                    {isImage ? (
                      // A row thumbnail must never pull the full-size original.
                      <ImageThumb
                        className="size-12 cursor-zoom-in"
                        imageId={file.id}
                        label={`查看 ${file.name}`}
                        onOpen={() => setZoom(`/v1/images/${file.id}`)}
                      />
                    ) : (
                      <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
                        <FileText className="size-4" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{file.name}</div>
                      <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                        <Badge tone="outline">{sourceLabel(file.source)}</Badge>
                        {formatBytes(file.bytes)} · {formatTime(file.createdAt)}
                        {file.chunkCount ? ` · ${file.chunkCount} 片段` : ""}
                        {file.embeddingError ? ` · ${file.embeddingError}` : ""}
                      </div>
                    </div>
                    {isImage ? null : <Badge tone={status.tone}>{status.text}</Badge>}
                    {isImage ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`查看大图 ${file.name}`}
                        onClick={() => setZoom(`/v1/images/${file.id}`)}
                      >
                        <Eye />
                      </Button>
                    ) : null}
                    {isEditable(file) ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`编辑 ${file.name}`}
                        onClick={async () => {
                          try {
                            setEditing(await api.fileText(file.id));
                          } catch (error) {
                            toast(error instanceof Error ? error.message : String(error), true);
                          }
                        }}
                      >
                        <Pencil />
                      </Button>
                    ) : null}
                    {isImage ? null : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`重建索引 ${file.name}`}
                        onClick={() =>
                          void act(() => api.reindexFile(file.id), "已重新索引").then(() => refresh())
                        }
                      >
                        <RefreshCw />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`删除 ${file.name}`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void act(() => api.deleteFile(file.id)).then(() => refresh())}
                    >
                      <Trash2 />
                    </Button>
                  </Row>
                );
              })
            )}
            {total > files.length ? (
              <SectionBody>
                <Button
                  onClick={() => {
                    const next = shown + PAGE;
                    setShown(next);
                    void refresh(next).catch((error: unknown) => toast(String(error), true));
                  }}
                >
                  加载更多（{files.length}/{total}）
                </Button>
              </SectionBody>
            ) : null}
          </Section>
        </PageBody>
      </div>

      {editing ? (
        <NoteEditor
          note={editing}
          onCancel={() => setEditing(null)}
          onSave={async (name, text) => {
            const ok = await act(
              () => (editing.id ? api.saveFileText(editing.id, name, text) : api.createNote(name, text)),
              "已保存",
            );
            if (ok) {
              setEditing(null);
              await refresh();
            }
          }}
        />
      ) : null}

      {zoom ? <Lightbox src={zoom} onClose={() => setZoom("")} /> : null}
    </>
  );
}

function NoteEditor({
  note,
  onCancel,
  onSave,
}: {
  note: { id: string; name: string; text: string };
  onCancel: () => void;
  onSave: (name: string, text: string) => Promise<void>;
}) {
  const [name, setName] = useState(note.name);
  const [text, setText] = useState(note.text);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => area.current?.focus(), []);

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onCancel()}
      title={note.id ? "编辑文档" : "新建文档"}
      description="保存后会立即切片并进入检索"
      className="w-[min(44rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={() => void onSave(name, text)}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="文件名">
          <Input value={name} placeholder="例如 项目笔记.md" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="内容（Markdown）">
          <Textarea ref={area} rows={14} value={text} onChange={(event) => setText(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
