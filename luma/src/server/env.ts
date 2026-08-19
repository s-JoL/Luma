import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * An operator-supplied directory, absolutised. `~` means nothing to `path`, and
 * on macOS and Linux the string does not always arrive through a shell that
 * would have expanded it — a launchd plist and a systemd unit both hand it over
 * verbatim — so without this Luma creates a directory literally named `~` beside
 * the working directory and puts the user's database in it.
 */
function configuredDirectory(value: string | undefined) {
  if (!value) return undefined;
  const expanded =
    value === "~" || value.startsWith("~/") || value.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), value.slice(1))
      : value;
  return path.resolve(expanded);
}

const ROOT = configuredDirectory(process.env.LUMA_ROOT) ?? path.resolve(here, "..", "..");

export const DATA_DIR = configuredDirectory(process.env.LUMA_DATA_DIR) ?? path.join(ROOT, "data");

export const paths = {
  root: ROOT,
  data: DATA_DIR,
  db: path.join(DATA_DIR, "luma.sqlite"),
  /**
   * pi's session backend owns its own schema and migrations, and its `sessions`
   * table would collide with the device-session table in `luma.sqlite`, so the
   * conversation trees get their own file.
   */
  sessionsDb: path.join(DATA_DIR, "sessions.sqlite"),
  masterKey: path.join(DATA_DIR, "master.key"),
  files: path.join(DATA_DIR, "files"),
  /** Folders of written procedures the agent can load on demand. */
  skills: path.join(DATA_DIR, "skills"),
  /**
   * ComfyUI graphs in API format. A new workflow is a file plus a model row, so
   * adding one is not a release (`07-generation.md`).
   */
  workflows: path.join(DATA_DIR, "workflows"),
  assets: path.join(DATA_DIR, "assets"),
  assetMeta: path.join(DATA_DIR, "assets", "meta"),
  assetFiles: path.join(DATA_DIR, "assets", "files"),
  thumbs: path.join(DATA_DIR, "assets", "thumbs"),
  webDist: path.join(ROOT, "dist"),
};

export const PORT = Number(process.env.LUMA_PORT ?? 8090);
export const HOST = process.env.LUMA_HOST ?? "127.0.0.1";

export const MAX_UPLOAD_BYTES = Number(process.env.LUMA_MAX_UPLOAD_BYTES ?? 64 * 1024 * 1024);
export const MAX_ATTACHMENTS = Number(process.env.LUMA_MAX_ATTACHMENTS ?? 8);

/**
 * Ceiling on the resident copy of the vector matrix. A larger corpus is scored
 * straight out of SQLite in pages instead, trading the reads back rather than
 * the machine's memory. The default holds about 16 000 chunks at 4096
 * dimensions, which is already past the size where `01-data-model.md` points at
 * `sqlite-vec`.
 */
export const VECTOR_CACHE_BYTES = Number(
  process.env.LUMA_VECTOR_CACHE_BYTES ?? 256 * 1024 * 1024,
);

export function ensureDirectories() {
  for (const dir of [
    paths.data,
    paths.files,
    paths.skills,
    paths.workflows,
    paths.assets,
    paths.assetMeta,
    paths.assetFiles,
    paths.thumbs,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
