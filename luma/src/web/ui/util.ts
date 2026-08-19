import { useEffect, useState } from "react";

/**
 * True on a device whose primary input is a finger. A touch keyboard has no
 * Shift, so anywhere Enter would otherwise be a shortcut it has to stay a plain
 * newline instead — there would be no other way to type one.
 */
export function useTouchPrimary() {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => window.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setCoarse(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return coarse;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ms: number) {
  const date = new Date(ms);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** Milliseconds as a compact duration: 900ms, 4.2s, 1:05. */
export function formatDuration(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
