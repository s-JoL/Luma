/**
 * Where a picture came from, and the two things worth doing with the answer.
 *
 * A generated image used to be a dead end: the prompt that made it was somewhere
 * up the transcript, and the parameters were nowhere at all. Both are on record —
 * the asset row knows its backend, the job row knows what was asked — so the only
 * thing missing was somewhere to read them and a way to act on them.
 *
 * Two actions, because they are different intentions. "Again" repeats the request
 * unchanged, which is what you want when a model is stochastic and the last roll
 * was nearly right. "Adjust" opens the same parameters in the studio's form, which
 * is what you want when it was not.
 */
import { Copy, Images, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import type { Provenance } from "@shared/types.ts";
import { OP_LABELS } from "@shared/types.ts";
import { api } from "./api.ts";
import { handToStudio } from "./studio-draft.ts";
import { Badge, Button, Empty, formatDuration, formatTime, Spinner, useToast } from "./ui.tsx";

/**
 * The asset id out of the url that displays it. Every one of these is
 * `/v1/images/<id>` or `/v1/videos/<id>`, optionally with a thumbnail width, so
 * the src a viewer was opened with already names the asset and no caller has to
 * carry the id separately alongside it.
 */
export function assetIdOf(src: string) {
  return /\/(img_[0-9a-f]{32}|vid_[0-9a-f]{32})/i.exec(src)?.[1]?.toLowerCase() ?? "";
}

/** The parameters as the job sent them, with the prompt lifted out to be read. */
function readable(params: Record<string, unknown>) {
  const prompt = typeof params.prompt === "string" ? params.prompt : "";
  const rest = Object.entries(params).filter(([key, value]) => key !== "prompt" && value !== "" && value != null);
  return { prompt, rest };
}

export function ProvenanceCard({ assetId }: { assetId: string }) {
  const [record, setRecord] = useState<Provenance | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let live = true;
    setRecord(null);
    setError("");
    api
      .provenance(assetId)
      .then((value) => live && setRecord(value))
      .catch((reason: unknown) => live && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      live = false;
    };
  }, [assetId]);

  if (error) return <Empty className="p-4 text-xs">{error}</Empty>;
  if (!record) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Spinner className="size-3" /> 读取来源
      </div>
    );
  }

  const job = record.job;
  const { prompt, rest } = readable(job?.params ?? {});

  const again = async () => {
    if (!job) return;
    setBusy(true);
    try {
      await api.submitJob({ modelId: job.modelId, op: job.op, params: job.params, sources: job.sources });
      toast("已排队，同样的参数再来一张");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : String(reason), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-h-[80dvh] w-80 flex-col gap-3 overflow-y-auto rounded-xl border bg-card p-3 text-sm shadow-2xl">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone="outline">{record.kind === "video" ? "视频" : "图片"}</Badge>
        {record.width && record.height ? <Badge tone="outline">{`${record.width}×${record.height}`}</Badge> : null}
        {record.durationMs ? <Badge tone="outline">{formatDuration(record.durationMs)}</Badge> : null}
        {job ? <Badge tone="outline">{OP_LABELS[job.op] ?? job.op}</Badge> : null}
      </div>

      <dl className="flex flex-col gap-1 text-xs">
        <Line label="模型" value={job?.modelName || record.model || "未记录"} />
        <Line label="后端" value={record.provider ?? "未记录"} />
        {record.createdAt ? <Line label="生成于" value={formatTime(record.createdAt)} /> : null}
        {job?.elapsedMs ? <Line label="耗时" value={formatDuration(job.elapsedMs)} /> : null}
      </dl>

      {prompt ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="flex-1">提示词</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="复制提示词"
              onClick={() => void navigator.clipboard.writeText(prompt).then(() => toast("提示词已复制"))}
            >
              <Copy />
            </Button>
          </div>
          <p className="max-h-40 overflow-y-auto rounded-lg bg-muted/50 p-2 text-xs whitespace-pre-wrap">{prompt}</p>
        </div>
      ) : null}

      {rest.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">参数</span>
          <dl className="flex flex-col gap-1 text-xs">
            {rest.map(([key, value]) => (
              <Line key={key} label={key} value={typeof value === "object" ? JSON.stringify(value) : String(value)} />
            ))}
          </dl>
        </div>
      ) : null}

      {record.parents.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Images className="size-3.5" /> 由 {record.parents.length} 张源图而来
          </span>
          <div className="flex flex-wrap gap-1.5">
            {record.parents.map((parent) => (
              <img
                key={parent}
                src={`/v1/images/${parent}?w=160`}
                alt=""
                className="size-12 rounded-md border object-cover"
                loading="lazy"
              />
            ))}
          </div>
        </div>
      ) : null}

      {job ? (
        <div className="flex flex-col gap-2 border-t pt-3">
          {job.repeatable ? (
            <>
              <Button variant="secondary" onClick={() => void again()} disabled={busy}>
                <RefreshCw /> 同参再来一张
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  handToStudio({ modelId: job.modelId, op: job.op, params: job.params, sources: job.sources })
                }
              >
                <SlidersHorizontal /> 改参数重画
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">生成它的模型已不可用，无法照原样再来一张。</p>
          )}
        </div>
      ) : (
        <p className="border-t pt-3 text-xs text-muted-foreground">
          没有对应的生成记录：它可能是上传的，或者是在队列开始记账之前画的。
        </p>
      )}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{value}</dd>
    </div>
  );
}
