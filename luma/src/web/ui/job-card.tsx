/**
 * One generation job, rendered from its record and nothing else. A job's whole
 * state is that row, so the same card serves the studio queue and a generation
 * the agent started mid-conversation — the two used to disagree, and chat only
 * ever showed a spinner.
 */
import { X } from "lucide-react";
import type { JobRecord, JobStatus } from "@shared/types.ts";
import { OP_LABELS } from "@shared/types.ts";
import { Button } from "./button.tsx";
import { cn } from "./cn.ts";
import { Badge, Spinner, Tooltip } from "./controls.tsx";
import { ImageThumb, VideoView } from "./media.tsx";
import { Card } from "./overlay.tsx";
import { formatTime } from "./util.ts";

const STATUS: Record<JobStatus, { label: string; tone: "neutral" | "accent" | "success" | "danger" }> = {
  queued: { label: "排队中", tone: "neutral" },
  running: { label: "生成中", tone: "accent" },
  succeeded: { label: "完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
};

export const ACTIVE_JOB_STATUSES = new Set<JobStatus>(["queued", "running"]);

export function JobCard({
  job,
  onZoom,
  onCancel,
  className,
}: {
  job: JobRecord;
  onZoom: (src: string) => void;
  /** Omitted where the caller has no safe way to abandon the work. */
  onCancel?: () => void | Promise<void>;
  className?: string;
}) {
  const status = STATUS[job.status];
  const active = ACTIVE_JOB_STATUSES.has(job.status);
  const videos = job.assets.filter((asset) => asset.kind === "video");
  const images = job.assets.filter((asset) => asset.kind === "image");
  const percent = job.progress == null ? null : Math.round(job.progress * 100);

  return (
    <Card className={cn("flex flex-col gap-2 p-2.5", className)}>
      <div className="flex items-center gap-2 text-xs">
        <Badge tone={status.tone}>
          {active ? <Spinner className="size-3" /> : null}
          {status.label}
        </Badge>
        <span className="truncate font-medium">{job.modelName}</span>
        <span className="truncate text-muted-foreground">{OP_LABELS[job.op] ?? job.op}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">{formatTime(job.createdAt)}</span>
        {active && onCancel ? (
          <Tooltip label="取消">
            <Button variant="ghost" size="icon-sm" aria-label="取消生成" onClick={() => void onCancel()}>
              <X />
            </Button>
          </Tooltip>
        ) : null}
      </div>

      {typeof job.params.prompt === "string" && job.params.prompt ? (
        <p className="line-clamp-2 text-xs text-muted-foreground">{String(job.params.prompt)}</p>
      ) : null}

      {active ? (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full bg-primary transition-[width]", percent == null && "w-1/3 animate-pulse")}
            style={percent == null ? undefined : { width: `${percent}%` }}
          />
        </div>
      ) : null}
      {active && (job.note || percent != null) ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{job.note}</span>
          {percent == null ? null : <span className="shrink-0 tabular-nums">{percent}%</span>}
        </p>
      ) : null}
      {job.error ? <p className="text-xs text-destructive">{job.error}</p> : null}

      {images.length || videos.length ? (
        <div className="flex flex-wrap items-start gap-2">
          {images.map((asset) => (
            <ImageThumb
              key={asset.assetId}
              className="size-16 cursor-zoom-in"
              imageId={asset.assetId}
              width={160}
              label="查看大图"
              onOpen={() => onZoom(`/v1/images/${asset.assetId}`)}
            />
          ))}
          {videos.map((asset) => (
            <VideoView
              key={asset.assetId}
              className="max-h-40"
              videoId={asset.assetId}
              posterImageId={asset.posterAssetId}
              durationMs={asset.durationMs}
              posterWidth={640}
            />
          ))}
        </div>
      ) : null}
    </Card>
  );
}
