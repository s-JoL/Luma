/**
 * Manual control surface for generation. The form is generated from the JSON
 * Schema the server sends for each tool — the generation adapters' schemas, plus
 * whatever MCP servers advertise — so a newly configured image model or server
 * shows up with the right controls without any change here.
 *
 * Anything backed by a generation model goes through the job queue, so a video
 * that takes two minutes survives a reload and a phone locking its screen. MCP
 * tools have no job of their own and are still run inline.
 */
import { ChevronDown, Clock, Download, ImagePlus, Layers, Menu as MenuIcon, Pencil, Plus, Upload, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GeneratedAsset, JobRecord, JsonSchema, StudioImage, StudioTool } from "@shared/types.ts";
import { api, watchJob } from "../api.ts";
import { askToNotify, notifyFinished } from "../notify.ts";
import { assetIdOf, ProvenanceCard } from "../provenance.tsx";
import { onStudioDraft, takeStudioDraft, type StudioDraft } from "../studio-draft.ts";
import {
  ACTIVE_JOB_STATUSES,
  Button,
  cn,
  Field,
  formatDuration,
  Input,
  JobCard,
  Lightbox,
  Modal,
  Select,
  Spinner,
  Switch,
  Textarea,
  useToast,
  VideoView,
} from "../ui.tsx";

const PAGE = 60;
/** Fields the studio renders itself instead of as a generic input. */
const PROMPT_FIELDS = new Set(["prompt", "negative_prompt"]);
const SOURCE_FIELD = "source_image_id";
const EXTRA_SOURCES_FIELD = "additional_source_image_ids";
/** Bookkeeping the agent fills in for itself; meaningless when driving by hand. */
const HIDDEN_FIELDS = new Set(["placement_key", "intent"]);

/**
 * The operations, as tabs, in the order someone works in: draw something, change
 * it, then move it. `other` is here only because the type allows it; the server
 * does not send those to the studio.
 */
const KIND_ORDER: Array<StudioTool["kind"]> = ["generate", "edit", "video"];
const KIND_LABELS: Record<StudioTool["kind"], string> = {
  generate: "生成图片",
  edit: "编辑图片",
  video: "视频",
  other: "其他",
};
const KIND_ACTIONS: Record<StudioTool["kind"], string> = {
  generate: "开始生成",
  edit: "开始编辑",
  video: "开始生成视频",
  other: "运行",
};

const FIELD_LABELS: Record<string, string> = {
  aspect_ratio: "画面比例",
  width: "宽度",
  height: "高度",
  resolution: "分辨率",
  seed: "随机种子",
  steps: "步数",
  negative_prompt: "负面提示词",
};

/** Never the literal `null`: a picture the library has no name for is its id. */
const artworkName = (image: { name: string | null; id: string }) => image.name?.trim() || image.id;

/** Column width, row height and gap of the gallery grid, read from the CSS. */
interface GridMetrics {
  column: number;
  row: number;
  gap: number;
}

/**
 * How many grid rows a tile of this shape occupies. A tile spanning `k` rows is
 * `k * row + (k - 1) * gap` tall, so inverting that for the height the image
 * wants gives a tile that keeps the image's proportions.
 */
function rowSpan({ column, row, gap }: GridMetrics, ratio: number) {
  return Math.max(1, Math.round((column / ratio + gap) / (row + gap)));
}

export function Studio({ onOpenRail }: { onOpenRail: () => void }) {
  const toast = useToast();
  const [tools, setTools] = useState<StudioTool[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [toolKey, setToolKey] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [gallery, setGallery] = useState<StudioImage[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  /**
   * Finished work, kept only to answer "how long will this take". The queue above
   * is what is happening; this is what has happened, and the two are separate
   * because listing every finished job in the queue buried the gallery.
   */
  const [past, setPast] = useState<JobRecord[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [zoom, setZoom] = useState("");
  const [detail, setDetail] = useState<StudioImage | null>(null);
  const [picking, setPicking] = useState<"" | "source" | "extra">("");
  /** A video an MCP tool returned inline; jobs show theirs in the queue. */
  const [video, setVideo] = useState("");
  /** Files whose bytes are gone; hidden rather than shown as broken tiles. */
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const galleryRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<GridMetrics>({
    column: 0,
    row: 0,
    gap: 0,
  });
  /** Ratios recovered from the thumbnail, for images that never recorded any. */
  const [measured, setMeasured] = useState<Record<string, number>>({});

  const tool = tools.find((item) => `${item.serverId}/${item.name}` === toolKey);

  // Measured before the first paint so tiles never appear at the wrong height,
  // and again on resize, which is also when the responsive gap changes.
  useLayoutEffect(() => {
    const node = galleryRef.current;
    if (!node) return;
    const measure = () => {
      const style = getComputedStyle(node);
      setMetrics({
        column: Number.parseFloat(style.gridTemplateColumns) || 0,
        row: Number.parseFloat(style.gridAutoRows) || 0,
        gap: Number.parseFloat(style.rowGap) || 0,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  const loadGallery = useCallback(async (offset: number) => {
    const page = await api.gallery(offset, PAGE);
    setTotal(page.total);
    setGallery((current) => (offset ? [...current, ...page.items] : page.items));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        // Only unfinished work is picked up on load. A finished job's output is
        // already in the gallery below, or — for video, which the gallery does
        // not carry — in the file library, so listing it again would bury the
        // gallery under a history nobody asked for.
        const [catalogue, queued, running, done] = await Promise.all([
          api.studioTools(),
          api.jobs({ status: "queued", limit: 12 }),
          api.jobs({ status: "running", limit: 12 }),
          api.jobs({ status: "succeeded", limit: 60 }),
          loadGallery(0),
        ]);
        setTools(catalogue.items);
        setEnabled(catalogue.enabled);
        setJobs([...running.items, ...queued.items]);
        setPast(done.items);
        setToolKey(
          (current) =>
            current || (catalogue.items[0] ? `${catalogue.items[0].serverId}/${catalogue.items[0].name}` : ""),
        );
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), true);
      }
    })();
  }, [loadGallery, toast]);

  const upsertJob = useCallback((job: JobRecord) => {
    setJobs((current) => {
      const next = current.filter((item) => item.id !== job.id);
      return [job, ...next].slice(0, 24);
    });
  }, []);

  /** Everything the finished job produced, so a reload does not lose it. */
  const absorb = useCallback((job: JobRecord) => {
    const images = job.assets.filter((asset) => asset.kind === "image");
    if (!images.length) return;
    setGallery((current) => [
      ...images.map((asset) => galleryEntry(asset, job)),
      ...current.filter((image) => !images.some((asset) => asset.assetId === image.id)),
    ]);
    setTotal((current) => current + images.length);
  }, []);

  /**
   * A job that was still running when this screen mounted is picked up again, so
   * arriving from another device or after a reload shows live progress rather
   * than a stale row. The streams outlive this effect's own runs — each update
   * changes `jobs`, and tearing them down on that would cut the stream that
   * reported it — so they are kept in a ref and only closed on unmount.
   */
  const watchers = useRef(new Map<string, AbortController>());
  useEffect(() => {
    for (const job of jobs) {
      if (!ACTIVE_JOB_STATUSES.has(job.status) || watchers.current.has(job.id)) continue;
      const controller = new AbortController();
      watchers.current.set(job.id, controller);
      void watchJob(
        job.id,
        (update) => {
          upsertJob(update);
          if (update.status === "succeeded") {
            absorb(update);
            // The estimate for the next one should know about this one.
            setPast((current) => [update, ...current.filter((item) => item.id !== update.id)].slice(0, 60));
          }
          if (!ACTIVE_JOB_STATUSES.has(update.status)) {
            notifyFinished(
              update.status === "succeeded" ? "生成完成" : "生成未完成",
              update.error || `${update.modelName} · ${update.op}`,
            );
          }
        },
        controller.signal,
      ).finally(() => watchers.current.delete(job.id));
    }
  }, [absorb, jobs, upsertJob]);

  useEffect(
    () => () => {
      for (const controller of watchers.current.values()) controller.abort();
      watchers.current.clear();
    },
    [],
  );

  /**
   * Reset the form to the tool's own defaults when the tool changes. Switching
   * tools with a source image already chosen seeds the values itself, so the
   * key it seeded is recorded here to keep this from wiping it.
   */
  const seeded = useRef("");
  useEffect(() => {
    if (!tool || seeded.current === toolKey) return;
    seeded.current = toolKey;
    setValues(defaultsOf(tool.schema));
  }, [tool, toolKey]);

  /**
   * The operations there is anything to run, in a fixed order so the tabs do not
   * rearrange themselves when a model is enabled. A kind nobody can perform is
   * not shown at all: a tab that only ever says "no model for this" is furniture.
   */
  const kinds = useMemo(() => KIND_ORDER.filter((entry) => tools.some((item) => item.kind === entry)), [tools]);
  const kindTools = useMemo(() => tools.filter((item) => item.kind === tool?.kind), [tool?.kind, tools]);

  /**
   * Which model you last used for each operation. Switching to editing and back
   * should return you to the model you were drawing with, not to whichever one
   * happens to sort first.
   */
  const lastByKind = useRef<Record<string, string>>({});
  useEffect(() => {
    if (tool) lastByKind.current[tool.kind] = toolKey;
  }, [tool, toolKey]);

  const switchKind = (next: StudioTool["kind"]) => {
    const remembered = lastByKind.current[next];
    const fallback = tools.find((item) => item.kind === next);
    setToolKey(remembered ?? (fallback ? `${fallback.serverId}/${fallback.name}` : ""));
  };

  /**
   * How long this operation has taken on this model before, as the median of what
   * is on record. The median and not the mean: a cold start that pulled twelve
   * gigabytes of weights off disk is in there too, and one of those drags an
   * average past anything the reader is going to see.
   */
  const estimate = useMemo(() => {
    if (!tool?.modelId || !tool.op) return null;
    const runs = past
      .filter((job) => job.modelId === tool.modelId && job.op === tool.op && job.startedAt && job.finishedAt)
      .map((job) => job.finishedAt! - job.startedAt!)
      .sort((left, right) => left - right);
    if (!runs.length) return null;
    return { ms: runs[Math.floor(runs.length / 2)]!, samples: runs.length };
  }, [past, tool]);

  /**
   * A generation handed over from somewhere else — the provenance card in a
   * transcript, or a tile in this gallery. The parameters have already been chosen
   * once, so the form is filled from them instead of asking the reader to retype
   * the numbers they were just looking at.
   */
  const [draft, setDraft] = useState<StudioDraft | null>(() => takeStudioDraft() ?? null);
  useEffect(() => onStudioDraft(() => setDraft(takeStudioDraft() ?? null)), []);
  useEffect(() => {
    if (!draft || !tools.length) return;
    setDraft(null);
    const target = tools.find((item) => item.modelId === draft.modelId && item.op === draft.op);
    if (!target) {
      toast("生成它的模型已经不在了，参数没法照原样打开", true);
      return;
    }
    const key = `${target.serverId}/${target.name}`;
    // Claimed before the switch, or the reset-on-tool-change effect wipes this.
    seeded.current = key;
    setToolKey(key);
    const [first, ...rest] = draft.sources ?? [];
    setValues({
      ...defaultsOf(target.schema),
      ...draft.params,
      ...(first ? { [SOURCE_FIELD]: first } : {}),
      ...(rest.length ? { [EXTRA_SOURCES_FIELD]: rest } : {}),
    });
  }, [draft, toast, tools]);

  /**
   * The controls that are not rendered somewhere of their own, split the way the
   * schema declares them: a parameter the model also chooses stays in front of
   * you, and one that is the person's alone — the sampler its author tuned, exact
   * pixels, a seed worth pinning — folds away until it is wanted.
   */
  const controls = useMemo(
    () =>
      Object.entries(tool?.schema.properties ?? {}).filter(
        ([key]) =>
          !PROMPT_FIELDS.has(key) && !HIDDEN_FIELDS.has(key) && key !== SOURCE_FIELD && key !== EXTRA_SOURCES_FIELD,
      ),
    [tool],
  );
  const shared = controls.filter(([, schema]) => schema.audience !== "studio");
  const manual = controls.filter(([, schema]) => schema.audience === "studio");
  /** Either group renders an entry the same way; only where they sit differs. */
  const control = ([key, schema]: [string, JsonSchema]) => (
    <SchemaField
      key={key}
      name={key}
      schema={schema}
      value={values[key]}
      onChange={(value) => setValues((current) => ({ ...current, [key]: value }))}
    />
  );
  const required = new Set(tool?.schema.required ?? []);
  const promptValue = String(values.prompt ?? "");
  const negativeSchema = tool?.schema.properties?.negative_prompt;
  const negativeValue = String(values.negative_prompt ?? "");
  const canRun = Boolean(tool) && !busy && [...required].every((key) => filled(values[key]));

  const run = async () => {
    if (!tool) return;
    setBusy(true);
    // The click that starts a render is the gesture the permission prompt needs.
    askToNotify();
    try {
      // A generation model has a job; an MCP tool is just a call.
      if (tool.modelId) {
        const params = prune(values);
        const sources = [
          ...(values[SOURCE_FIELD] ? [String(values[SOURCE_FIELD])] : []),
          ...((values[EXTRA_SOURCES_FIELD] as string[] | undefined) ?? []),
        ];
        delete params[SOURCE_FIELD];
        delete params[EXTRA_SOURCES_FIELD];
        const job = await api.submitJob({
          modelId: tool.modelId,
          op: tool.op,
          params,
          sources,
        });
        upsertJob(job);
        // Opened once, so the work is visibly somewhere; closing it stays closed.
        setQueueOpen(true);
        return;
      }
      const result = await api.studioRun(tool.serverId, tool.name, prune(values));
      toast(`已生成 · ${formatDuration(result.elapsedMs)}`);
      // The gallery is the image library; a video from an MCP tool has no job
      // row to live in, so it plays next to the form instead.
      if (result.videoId) {
        setVideo(result.videoId);
        return;
      }
      if (!result.imageId) return;
      setGallery((current) => [
        {
          id: result.imageId!,
          mime: result.mime,
          width: result.width,
          height: result.height,
          provider: result.provider,
          model: result.model,
          name: null,
          parents: [],
          createdAt: Date.now(),
        },
        ...current,
      ]);
      setTotal((current) => current + 1);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  /**
   * A file dropped on a source slot. An upload gets an `img_` id and an asset row
   * of its own, so from here on it is indistinguishable from something generated —
   * which is what lets it be edited at all.
   */
  const uploadSource = async (file: File, slot: "source" | "extra") => {
    if (!file.type.startsWith("image/")) {
      toast("只有图片能当源图", true);
      return;
    }
    try {
      const record = await api.upload(file);
      setValues((current) =>
        slot === "extra"
          ? {
              ...current,
              [EXTRA_SOURCES_FIELD]: [...((current[EXTRA_SOURCES_FIELD] as string[] | undefined) ?? []), record.id],
            }
          : { ...current, [SOURCE_FIELD]: record.id },
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  const useAsSource = (imageId: string) => {
    const editTool =
      tool?.kind === "edit"
        ? tool
        : tools.find((item) => item.kind === "edit" && item.schema.properties?.[SOURCE_FIELD]);
    if (!editTool) {
      toast("没有可用的编辑工具", true);
      return;
    }
    const key = `${editTool.serverId}/${editTool.name}`;
    if (key !== toolKey) {
      seeded.current = key;
      setToolKey(key);
      setValues({ ...defaultsOf(editTool.schema), [SOURCE_FIELD]: imageId });
    } else {
      setValues((current) => ({ ...current, [SOURCE_FIELD]: imageId }));
    }
    setDetail(null);
  };

  const active = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));

  const header = (
    <header className="flex h-13 shrink-0 items-center gap-2 border-b px-2 md:px-3">
      <Button variant="ghost" size="icon" className="md:hidden" aria-label="菜单" onClick={onOpenRail}>
        <MenuIcon />
      </Button>
      <h1 className="flex-1 text-sm font-medium md:text-base">创作台</h1>
      {/* The queue used to take the top half of the canvas and keep it whether
          anything was running or not. It lives behind this instead, so the space
          belongs to the results. */}
      {jobs.length ? (
        <Button
          variant={queueOpen ? "secondary" : "ghost"}
          size="sm"
          aria-expanded={queueOpen}
          onClick={() => setQueueOpen((open) => !open)}
        >
          {active.length ? <Spinner className="size-3" /> : <Layers className="size-3.5" />}
          {active.length ? `${active.length} 个进行中` : `${jobs.length} 条记录`}
          <ChevronDown className={cn("size-3.5 transition-transform", queueOpen && "rotate-180")} />
        </Button>
      ) : null}
      <span className="text-xs text-muted-foreground">{total} 张作品</span>
    </header>
  );

  if (!enabled) {
    return (
      <>
        {header}
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          创作台已在设置中关闭。
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        {queueOpen && jobs.length ? (
          <div className="absolute inset-x-2 top-2 z-20 flex max-h-[70%] flex-col gap-2 overflow-y-auto rounded-xl border bg-card p-3 shadow-2xl md:inset-x-auto md:right-3 md:w-96">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Layers className="size-3.5" />
              <span className="flex-1">生成队列</span>
              <Button variant="ghost" size="icon-sm" aria-label="收起队列" onClick={() => setQueueOpen(false)}>
                <X />
              </Button>
            </div>
            {jobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onZoom={setZoom}
                onCancel={async () => {
                  const cancelled = await api.cancelJob(job.id).catch((error: unknown) => {
                    toast(error instanceof Error ? error.message : String(error), true);
                    return null;
                  });
                  if (cancelled) upsertJob(cancelled);
                }}
              />
            ))}
          </div>
        ) : null}

        <div className="flex shrink-0 flex-col gap-4 border-b p-4 md:w-84 md:overflow-y-auto md:border-r md:border-b-0">
          {/* What you are doing comes before what does it. The dropdown that used
              to sit here mixed the two, so choosing to edit meant reading a list
              of every model crossed with every operation. */}
          {kinds.length > 1 ? (
            <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="创作方式">
              {kinds.map((entry) => (
                <button
                  key={entry}
                  role="tab"
                  aria-selected={tool?.kind === entry}
                  className={cn(
                    "flex-1 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
                    tool?.kind === entry
                      ? "bg-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => switchKind(entry)}
                >
                  {KIND_LABELS[entry]}
                </button>
              ))}
            </div>
          ) : null}

          <Field label="模型" hint={tool ? summarize(tool) : undefined}>
            <Select
              value={toolKey}
              placeholder="没有可用模型"
              options={kindTools.map((item) => ({
                value: `${item.serverId}/${item.name}`,
                label: item.serverTitle,
                hint: summarize(item),
              }))}
              onChange={setToolKey}
            />
          </Field>

          {/* The source image comes before the prompt for an edit, because it is
              the subject: the prompt only says what to do to it. */}
          {tool?.schema.properties?.[SOURCE_FIELD] ? (
            <Field label="源图">
              <SourcePicker
                ids={[String(values[SOURCE_FIELD] ?? "")].filter(Boolean)}
                onPick={() => setPicking("source")}
                onClear={() => setValues((current) => ({ ...current, [SOURCE_FIELD]: "" }))}
                onDropped={(id) => setValues((current) => ({ ...current, [SOURCE_FIELD]: id }))}
                onUpload={(file) => uploadSource(file, "source")}
              />
            </Field>
          ) : null}

          {tool?.schema.properties?.[EXTRA_SOURCES_FIELD]?.items?.type === "string" ? (
            <Field label="参考图（可选，按顺序）">
              <SourcePicker
                ids={(values[EXTRA_SOURCES_FIELD] as string[] | undefined) ?? []}
                onPick={() => setPicking("extra")}
                onClear={() =>
                  setValues((current) => ({
                    ...current,
                    [EXTRA_SOURCES_FIELD]: [],
                  }))
                }
                onDropped={(id) =>
                  setValues((current) => ({
                    ...current,
                    [EXTRA_SOURCES_FIELD]: [...((current[EXTRA_SOURCES_FIELD] as string[] | undefined) ?? []), id],
                  }))
                }
                onUpload={(file) => uploadSource(file, "extra")}
              />
            </Field>
          ) : null}

          {tool?.schema.properties?.prompt ? (
            <Field label="提示词" hint={`${promptValue.length} 字 · Ctrl+Enter 开始`}>
              <Textarea
                rows={7}
                value={promptValue}
                placeholder="描述你想要的画面"
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    prompt: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canRun) void run();
                }}
              />
            </Field>
          ) : null}

          {negativeSchema ? (
            <Field label={FIELD_LABELS.negative_prompt} hint={describe(negativeSchema)}>
              <Textarea
                rows={3}
                value={negativeValue}
                placeholder="不希望出现的元素"
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    negative_prompt: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canRun) void run();
                }}
              />
            </Field>
          ) : null}

          {shared.length ? <div className="flex flex-col gap-3">{shared.map(control)}</div> : null}

          {manual.length ? (
            <details className="group/manual rounded-lg border bg-muted/30">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm select-none">
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/manual:rotate-180" />
                <span className="flex-1">高级</span>
                <span className="text-xs text-muted-foreground">{manual.length} 项 · 仅手动</span>
              </summary>
              <div className="flex flex-col gap-3 border-t px-3 py-3">{manual.map(control)}</div>
            </details>
          ) : null}

          <Button variant="primary" size="lg" disabled={!canRun} onClick={() => void run()}>
            {busy ? <Spinner /> : <ImagePlus />}
            {KIND_ACTIONS[tool?.kind ?? "generate"]}
          </Button>

          {/* What the wait was last time, from this queue's own record of it.
              Nothing here is a guess about a backend nobody has run yet. */}
          {estimate ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3.5 shrink-0" />
              过去 {estimate.samples} 次里，一半在 {formatDuration(estimate.ms)} 内完成
            </p>
          ) : null}

          {video ? <VideoView className="w-full" videoId={video} /> : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col md:overflow-y-auto">
          <div
            className="grid flex-1 auto-rows-[8px] grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] content-start gap-2 p-3"
            ref={galleryRef}
          >
            {metrics.column && metrics.row
              ? gallery
                  .filter((image) => !missing.has(image.id))
                  .map((image) => {
                    const stored = image.width && image.height ? image.width / image.height : 0;
                    const ratio = stored || measured[image.id] || 1;
                    return (
                      <div
                        key={image.id}
                        className="group relative overflow-hidden rounded-lg border bg-muted transition-[transform,box-shadow] hover:z-1 hover:shadow-lg"
                        style={{
                          gridRowEnd: `span ${rowSpan(metrics, ratio)}`,
                        }}
                        // Dragged onto the source slot, which is the shortest path
                        // from "that one" to editing it.
                        draggable
                        onDragStart={(event) => event.dataTransfer.setData("text/plain", image.id)}
                      >
                        <button
                          aria-label={`打开作品 ${artworkName(image)}`}
                          className="block size-full"
                          onClick={() => setDetail(image)}
                        >
                          <img
                            className="size-full object-cover"
                            src={`/v1/images/${image.id}?w=320`}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            onLoad={(event) => {
                              // Images migrated before dimensions were recorded
                              // fall back to a square, then correct themselves.
                              if (stored) return;
                              const { naturalWidth, naturalHeight } = event.currentTarget;
                              if (!naturalWidth || !naturalHeight) return;
                              setMeasured((current) =>
                                current[image.id]
                                  ? current
                                  : {
                                      ...current,
                                      [image.id]: naturalWidth / naturalHeight,
                                    },
                              );
                            }}
                            onError={() => setMissing((current) => new Set(current).add(image.id))}
                          />
                        </button>
                        {/* Editing was two clicks and a modal away from the thing
                            you wanted to edit. Always visible without a pointer,
                            because hover is not a gesture a phone has. */}
                        <button
                          className="absolute top-1 right-1 rounded-md bg-background/85 p-1.5 opacity-0 shadow transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
                          aria-label={`以 ${artworkName(image)} 为源编辑`}
                          onClick={() => useAsSource(image.id)}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      </div>
                    );
                  })
              : null}
          </div>

          {total === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">还没有作品。用左边的工具生成第一张吧。</p>
          ) : null}
          {gallery.length < total ? (
            <div className="p-3 pt-0">
              <Button className="w-full" onClick={() => void loadGallery(gallery.length)}>
                加载更多（{gallery.length}/{total}）
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <Modal
        open={Boolean(detail)}
        onOpenChange={(open) => !open && setDetail(null)}
        title="作品详情"
        className="w-[min(48rem,calc(100vw-2rem))]"
        footer={
          detail ? (
            <>
              <Button onClick={() => useAsSource(detail.id)}>
                <Pencil />
                以此为源编辑
              </Button>
              <a
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-secondary px-3.5 font-medium text-secondary-foreground transition-colors hover:bg-secondary/70"
                href={`/v1/images/${detail.id}`}
                download={`${detail.id}.png`}
              >
                <Download className="size-4" />
                下载原图
              </a>
            </>
          ) : null
        }
      >
        {/* The picture beside where it came from. This used to re-list the
            backend, the size and the parents by hand, which was a worse subset of
            what `/provenance` answers and had no prompt in it — the one thing you
            open a finished picture to read. */}
        {detail ? (
          <div className="flex flex-col gap-3 md:flex-row md:items-start">
            <img
              className="max-h-[60dvh] min-w-0 flex-1 cursor-zoom-in rounded-lg border object-contain"
              src={`/v1/images/${detail.id}?w=1280`}
              alt=""
              onClick={() => setZoom(`/v1/images/${detail.id}`)}
            />
            <ProvenanceCard assetId={detail.id} />
          </div>
        ) : null}
      </Modal>

      {picking ? (
        <ImagePicker
          images={gallery}
          multiple={picking === "extra"}
          onClose={() => setPicking("")}
          onSelect={(ids) => {
            setValues((current) =>
              picking === "extra"
                ? { ...current, [EXTRA_SOURCES_FIELD]: ids }
                : { ...current, [SOURCE_FIELD]: ids[0] ?? "" },
            );
            setPicking("");
          }}
        />
      ) : null}

      {zoom ? (
        <Lightbox
          src={zoom}
          onClose={() => setZoom("")}
          aside={assetIdOf(zoom) ? <ProvenanceCard assetId={assetIdOf(zoom)} /> : undefined}
        />
      ) : null}
    </>
  );
}

/**
 * Fields the server puts on a finished job's assets. They are optional here
 * because the payload is being extended: a client that demanded them would show
 * `null` as a filename for every build that has not caught up yet.
 */
interface AssetDescriptor {
  name?: string | null;
  provider?: string | null;
  model?: string | null;
  parentImageIds?: string[] | null;
  parents?: string[] | null;
  createdAt?: number | null;
}

/**
 * The gallery row a finished job contributes. The asset descriptor is the
 * answer wherever it has one; the job only fills what the descriptor left out,
 * which is what stops a fresh tile from being unnamed until a reload.
 */
function galleryEntry(asset: GeneratedAsset, job: JobRecord): StudioImage {
  const described = asset as GeneratedAsset & AssetDescriptor;
  return {
    id: asset.assetId,
    mime: asset.mime,
    width: asset.width,
    height: asset.height,
    provider: described.provider ?? null,
    model: described.model ?? job.modelName,
    name: described.name ?? null,
    parents: described.parentImageIds ?? described.parents ?? job.sources,
    createdAt: described.createdAt ?? job.finishedAt ?? Date.now(),
  };
}

/**
 * The picture being worked on. Empty, it is a drop target rather than a button
 * that opens a picker: what people have is a file on their desk or a tile in the
 * gallery beside them, and both of those are things you drag.
 */
function SourcePicker({
  ids,
  onPick,
  onClear,
  onDropped,
  onUpload,
}: {
  ids: string[];
  onPick: () => void;
  onClear: () => void;
  /** An image already in the library, dragged from the gallery. */
  onDropped: (imageId: string) => void;
  onUpload: (file: File) => void | Promise<void>;
}) {
  const [over, setOver] = useState(false);

  const accept = (event: React.DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file) {
      void onUpload(file);
      return;
    }
    // A gallery tile carries its own id, so no upload and no second copy.
    const dragged = event.dataTransfer.getData("text/plain").trim();
    if (/^img_[0-9a-f]{32}$/i.test(dragged)) onDropped(dragged.toLowerCase());
  };

  return (
    <div
      className="flex flex-col gap-2"
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={accept}
    >
      {ids.length ? (
        <div className="flex flex-wrap items-center gap-2">
          {ids.map((id) => (
            <img
              key={id}
              className="size-14 rounded-md border bg-muted object-contain"
              src={`/v1/images/${id}?w=160`}
              alt=""
              loading="lazy"
            />
          ))}
          <Button size="sm" onClick={onPick}>
            更换
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={onClear}>
            清除
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            "flex flex-col items-center gap-2 rounded-lg border border-dashed p-4 text-center transition-colors",
            over && "border-primary bg-accent/40",
          )}
        >
          <Upload className="size-4 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">把图片拖进来，或从右边画廊里拖一块过来</p>
          <Button size="sm" onClick={onPick}>
            从画廊选择
          </Button>
        </div>
      )}
    </div>
  );
}

function ImagePicker({
  images,
  multiple,
  onSelect,
  onClose,
}: {
  images: StudioImage[];
  multiple: boolean;
  onSelect: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={multiple ? "选择参考图" : "选择源图"}
      description="按点选顺序传给模型"
      className="w-[min(52rem,calc(100vw-2rem))]"
      footer={
        multiple ? (
          <Button variant="primary" onClick={() => onSelect(chosen)}>
            使用 {chosen.length} 张
          </Button>
        ) : null
      }
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-2">
        {images.map((image) => {
          const index = chosen.indexOf(image.id);
          return (
            <button
              key={image.id}
              aria-label={`${index >= 0 ? "取消选择" : "选择"} ${artworkName(image)}`}
              className={cn(
                "relative aspect-square overflow-hidden rounded-md border transition-colors",
                index >= 0 && "border-primary ring-2 ring-primary/40",
              )}
              onClick={() => {
                if (!multiple) {
                  onSelect([image.id]);
                  return;
                }
                setChosen((current) => (index >= 0 ? current.filter((id) => id !== image.id) : [...current, image.id]));
              }}
            >
              <img
                className="size-full object-cover"
                src={`/v1/images/${image.id}?w=320`}
                alt=""
                loading="lazy"
                decoding="async"
              />
              {index >= 0 ? (
                <span className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-primary text-xs text-primary-foreground">
                  {index + 1}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/**
 * One control per schema node, and every node reaches one. Array and object
 * parameters used to render as nothing, which made them invisible rather than
 * merely awkward — so the last branch here is a JSON editor with a visible
 * explanation, not a `null`.
 */
function SchemaField({
  name,
  schema,
  value,
  onChange,
  label: given,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  /** An empty string suppresses the label, which is what a list item wants. */
  label?: string;
}) {
  const label = given ?? FIELD_LABELS[name] ?? schema.title ?? name.replaceAll("_", " ");
  const hint = describe(schema);
  const options = enumOf(schema);

  if (options.length) {
    return (
      <Field label={label} hint={hint}>
        <Select
          value={String(value ?? "")}
          placeholder="默认"
          options={[
            { value: "", label: "默认" },
            ...options.map((option) => ({
              value: String(option),
              label: String(option),
            })),
          ]}
          // A numeric enum has to go back as a number, not as its label.
          onChange={(next) =>
            onChange(next === "" ? undefined : (options.find((option) => String(option) === next) ?? next))
          }
        />
      </Field>
    );
  }

  if (schema.type === "boolean") {
    return <Switch checked={Boolean(value)} label={label || name} hint={hint} onChange={onChange} />;
  }

  if (schema.type === "number" || schema.type === "integer") {
    return (
      <Field label={label} hint={hint}>
        <Input
          type="number"
          min={schema.minimum}
          max={schema.maximum}
          step={stepOf(schema)}
          value={value == null ? "" : String(value)}
          placeholder={schema.default == null ? undefined : String(schema.default)}
          onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
        />
      </Field>
    );
  }

  if (schema.type === "string") {
    return (
      <Field label={label} hint={hint}>
        {isMultiline(schema) ? (
          <Textarea
            rows={4}
            value={String(value ?? "")}
            placeholder={schema.description?.slice(0, 60)}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <Input
            value={String(value ?? "")}
            placeholder={schema.description?.slice(0, 60)}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </Field>
    );
  }

  if (schema.type === "array") {
    return <ArrayField label={label} hint={hint} schema={schema} value={value} onChange={onChange} />;
  }

  if (schema.type === "object") {
    return <ObjectField label={label} hint={hint} schema={schema} value={value} onChange={onChange} />;
  }

  // A nullable or optional parameter is a union with null, and the branch that
  // names a type is the control the reader actually wants.
  const branch = (schema.anyOf ?? []).find((item) => item.type && item.type !== "null");
  if (!schema.type && branch) {
    return (
      <SchemaField
        name={name}
        label={label}
        schema={{ description: schema.description, ...branch }}
        value={value}
        onChange={onChange}
      />
    );
  }

  return (
    <JsonField
      label={label}
      hint={[hint, `这个参数的类型（${schema.type ?? "未声明"}）没有对应的控件，请直接填 JSON`]
        .filter((part): part is string => Boolean(part))
        .join(" · ")}
      value={value}
      onChange={onChange}
    />
  );
}

/** A list, either of choices to toggle or of values to edit one by one. */
function ArrayField({
  label,
  hint,
  schema,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const item = schema.items ?? { type: "string" };
  const choices = enumOf(item);

  // A bounded set is a row of toggles; typing its members back in by hand is
  // only a way to misspell one.
  if (choices.length) {
    return (
      <Field label={label} hint={hint}>
        <div className="flex flex-wrap gap-1.5">
          {choices.map((choice) => {
            const on = items.some((entry) => String(entry) === String(choice));
            return (
              <Button
                key={String(choice)}
                size="sm"
                variant={on ? "primary" : "outline"}
                aria-pressed={on}
                onClick={() =>
                  onChange(on ? items.filter((entry) => String(entry) !== String(choice)) : [...items, choice])
                }
              >
                {String(choice)}
              </Button>
            );
          })}
        </div>
      </Field>
    );
  }

  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-col gap-2">
        {items.map((entry, index) => (
          <div key={index} className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <SchemaField
                name={`${label}.${index}`}
                label=""
                schema={item}
                value={entry}
                onChange={(next) => onChange(items.map((old, at) => (at === index ? next : old)))}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-destructive"
              aria-label={`删除第 ${index + 1} 项`}
              onClick={() => onChange(items.filter((_, at) => at !== index))}
            >
              <X />
            </Button>
          </div>
        ))}
        <Button size="sm" className="self-start" onClick={() => onChange([...items, blankOf(item)])}>
          <Plus />
          添加一项
        </Button>
      </div>
    </Field>
  );
}

/** A nested form when the object declares its shape, JSON when it does not. */
function ObjectField({
  label,
  hint,
  schema,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const properties = Object.entries(schema.properties ?? {});
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

  if (!properties.length) {
    return <JsonField label={label} hint={hint} value={value} onChange={onChange} />;
  }

  return (
    <Field label={label} hint={hint}>
      <div className="flex flex-col gap-3 rounded-md border border-dashed p-3">
        {properties.map(([key, child]) => (
          <SchemaField
            key={key}
            name={key}
            schema={child}
            value={record[key]}
            onChange={(next) => onChange({ ...record, [key]: next })}
          />
        ))}
      </div>
    </Field>
  );
}

/**
 * The last resort, and deliberately visible. Text is held locally so a value
 * that does not parse yet survives the keystroke that would otherwise be thrown
 * away, and is pushed back up only once it does.
 */
function JsonField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => serialize(value));
  const [error, setError] = useState("");
  const emitted = useRef(serialize(value));

  useEffect(() => {
    const next = serialize(value);
    if (next === emitted.current) return;
    emitted.current = next;
    setText(next);
    setError("");
  }, [value]);

  return (
    <Field label={label} hint={hint} error={error || undefined}>
      <Textarea
        rows={4}
        className="font-mono text-xs"
        value={text}
        placeholder="{}"
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (!raw.trim()) {
            setError("");
            emitted.current = serialize(undefined);
            onChange(undefined);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(raw);
            setError("");
            emitted.current = serialize(parsed);
            onChange(parsed);
          } catch {
            setError("还不是合法的 JSON");
          }
        }}
      />
    </Field>
  );
}

const serialize = (value: unknown) => (value === undefined ? "" : JSON.stringify(value, null, 2));

/**
 * What a backend can do, read off the schema it already sends. Deliberately not a
 * table of model names in this file: a workflow that gains a resolution or a video
 * model that gains a duration says so in its schema, and this line says it in the
 * same moment rather than the next time somebody remembers to edit it.
 *
 * Local against hosted comes first because it is the one thing the schema cannot
 * say and the reader most wants before committing to a wait: slow and free, or
 * quick and billed.
 */
function summarize(tool: StudioTool) {
  const properties = tool.schema.properties ?? {};
  const choices = (schema: JsonSchema | undefined, unit = "") => {
    const values = schema ? enumOf(schema) : [];
    if (!values.length) return "";
    return `${values.slice(0, 4).map(String).join("/")}${values.length > 4 ? "…" : ""}${unit}`;
  };
  const references = properties[EXTRA_SOURCES_FIELD];
  return [
    tool.modelId ? (tool.local ? "本地" : "托管") : "MCP 工具",
    choices(properties.aspect_ratio),
    choices(properties.resolution ?? properties.size),
    choices(properties.duration ?? properties.duration_seconds, " 秒"),
    references ? `可带 ${references.maxItems ?? "多"} 张参考图` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * What a control is bounded by, and an explanation only where one is needed.
 *
 * A generation schema's `description` is addressed to the model: English,
 * imperative, and about how to compose a call — "Copy an exact image_id from the
 * conversation". Its `title` is the same knob addressed to a person. So a field
 * with a title has already said its piece, and printing the model's copy beneath
 * it puts instructions for somebody else in front of the reader. An MCP tool
 * often has only a description, and there it is all there is to go on.
 */
function describe(schema: JsonSchema) {
  const range =
    schema.minimum == null && schema.maximum == null
      ? ""
      : `范围 ${schema.minimum ?? "不限"} – ${schema.maximum ?? "不限"}`;
  const explanation = schema.title ? "" : schema.description;
  return [explanation, range].filter((part) => Boolean(part)).join(" · ") || undefined;
}

/** `multipleOf` is the JSON Schema spelling of a step; an integer implies one. */
function stepOf(schema: JsonSchema) {
  const multiple = (schema as { multipleOf?: number }).multipleOf;
  if (multiple) return multiple;
  return schema.type === "integer" ? 1 : "any";
}

/** No keyword says "big text box", so a generous length bound stands in. */
const isMultiline = (schema: JsonSchema) =>
  (schema.maxLength ?? 0) > 240 || (schema as { format?: string }).format === "textarea";

const blankOf = (schema: JsonSchema): unknown => {
  if (schema.default !== undefined) return schema.default;
  if (schema.type === "number" || schema.type === "integer") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return "";
};

/** Zod emits unions as anyOf, so enums can hide one level down. */
function enumOf(schema: JsonSchema): Array<string | number> {
  if (schema.enum?.length) return schema.enum;
  return (schema.anyOf ?? []).flatMap((item) => item.enum ?? []);
}

function defaultsOf(schema: JsonSchema) {
  const values: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (property.default !== undefined) values[key] = property.default;
  }
  return values;
}

const filled = (value: unknown) => {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return value != null && String(value).trim() !== "";
};

/** Empty optionals must be omitted: the tools use strict schemas. */
function prune(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => filled(value)));
}
