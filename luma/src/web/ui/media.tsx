import { cn } from "./cn.ts";
import { formatDuration } from "./util.ts";

/**
 * The one way a video is shown, wherever it appears. `preload="metadata"` is
 * what makes the browser ask for byte ranges instead of pulling the whole file
 * before the first frame, which is the half of range support a client owns.
 *
 * Every field is optional because a payload written by an older build carries
 * neither a poster nor a duration, and a video that plays is worth more than a
 * caption that is always there.
 */
export function VideoView({
  videoId,
  posterImageId,
  durationMs,
  className,
  posterWidth = 1280,
}: {
  videoId: string;
  posterImageId?: string | null;
  durationMs?: number | null;
  className?: string;
  posterWidth?: number;
}) {
  return (
    <figure className="flex w-fit max-w-full flex-col gap-1">
      <video
        className={cn("max-w-full rounded-lg border", className)}
        src={`/v1/videos/${videoId}`}
        poster={posterImageId ? `/v1/images/${posterImageId}?w=${posterWidth}` : undefined}
        controls
        playsInline
        preload="metadata"
      />
      {durationMs ? (
        <figcaption className="text-xs text-muted-foreground">时长 {formatDuration(durationMs)}</figcaption>
      ) : null}
    </figure>
  );
}

/**
 * A thumbnail that keeps the picture's shape inside a square box, so a portrait
 * image is recognisable instead of being cropped to a strip. Clicking opens the
 * full-size viewer the caller owns.
 */
export function ImageThumb({
  imageId,
  label,
  width = 320,
  className,
  onOpen,
}: {
  imageId: string;
  /** Names the picture for a screen reader; the visual label is the image. */
  label: string;
  width?: number;
  className?: string;
  onOpen: () => void;
}) {
  return (
    <button
      className={cn("shrink-0 overflow-hidden rounded-md border bg-muted", className)}
      aria-label={label}
      onClick={onOpen}
    >
      <img
        className="size-full object-contain"
        src={`/v1/images/${imageId}?w=${width}`}
        alt=""
        loading="lazy"
        decoding="async"
      />
    </button>
  );
}
