import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import type { FileKind, FileSearchMode, Provenance } from "@shared/types.ts";
import { MAX_UPLOAD_BYTES, paths } from "../../env.ts";
import { opsOf } from "../../generation/index.ts";
import { assetPath, forgetAssetIndex, writeImageSidecar } from "../../images.ts";
import type { Services } from "../../services.ts";
import { readJson } from "../body.ts";
import { fail, failFromError } from "../errors.ts";

const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** The reverse map, for naming a stored file when the upload arrived without one. */
const MIME_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSION_MIME).map(([extension, mime]) => [mime, extension]),
);

/** `diskPath` and `sha256` are server-side bookkeeping; clients get neither. */
function publicFile<T extends object>(file: T): Omit<T, "diskPath" | "sha256"> {
  const { diskPath: _diskPath, sha256: _sha256, ...rest } = file as T & { diskPath?: string; sha256?: string };
  return rest as Omit<T, "diskPath" | "sha256">;
}

export function fileRoutes(services: Services) {
  const app = new Hono();
  const { store, config, retrieval } = services;

  app.get("/files", (context) => {
    const query = context.req.query();
    const library = store.listFiles({
      kind: (query.kind as FileKind) ?? "all",
      source: query.source ?? "all",
      query: query.q ?? "",
      limit: Number(query.limit ?? 60),
      offset: Number(query.offset ?? 0),
    });
    return context.json({ ...library, items: library.items.map(publicFile) });
  });

  /**
   * A note is a file the user writes here rather than uploads, so it lands in
   * the same library and the same index as everything else and `file_search`
   * can reach it immediately.
   */
  app.post("/files/notes", async (context) => {
    const body = await readJson<{ name: string; text: string }>(context);
    const name = (body.name ?? "").trim() || "未命名文档";
    const file = writeNote(services, name.endsWith(".md") ? name : `${name}.md`, body.text ?? "");
    return context.json(publicFile(file), 201);
  });

  app.get("/files/:id/text", (context) => {
    const file = store.getFile(context.req.param("id"));
    if (!file || !fs.existsSync(file.diskPath)) return fail(context, 404, "not_found", "File not found");
    if (!isTextual(file.mime)) return fail(context, 400, "invalid", "This file is not editable text");
    return context.json({ id: file.id, name: file.name, text: fs.readFileSync(file.diskPath, "utf8") });
  });

  app.put("/files/:id/text", async (context) => {
    const file = store.getFile(context.req.param("id"));
    if (!file) return fail(context, 404, "not_found", "File not found");
    if (!isTextual(file.mime)) return fail(context, 400, "invalid", "This file is not editable text");
    const body = await readJson<{ name: string; text: string }>(context);
    const updated = writeNote(services, (body.name ?? file.name).trim() || file.name, body.text ?? "", file.id);
    return context.json(publicFile(updated));
  });

  app.post("/files", async (context) => {
    const form = await context.req.formData().catch(() => null);
    const upload = form?.get("file");
    if (!(upload instanceof File)) return fail(context, 400, "invalid", "file is required");
    if (upload.size > MAX_UPLOAD_BYTES) {
      return fail(context, 413, "too_large", `File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
    }
    const conversationId = String(form?.get("conversationId") ?? "") || null;
    const bytes = Buffer.from(await upload.arrayBuffer());
    const extension = path.extname(upload.name).toLowerCase();
    const mime =
      upload.type && upload.type !== "application/octet-stream"
        ? upload.type
        : (EXTENSION_MIME[extension] ?? "application/octet-stream");
    const isImage = mime.startsWith("image/");
    const isVideo = mime.startsWith("video/");
    /**
     * A picture or a clip goes in as an asset, not as a document: a typed id, the
     * asset directory, a provenance row, and no trip through the indexer. An
     * uploaded clip used to land as a `file_` row instead, which meant the one
     * route that serves video bytes — and it only answers to a `vid_` id — could
     * not play the thing the library had just accepted.
     */
    const visual = isImage || isVideo;
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    // Re-uploading a document the library already holds returns that entry
    // rather than a second copy. Deciding before the write is what keeps the
    // bytes off disk: `addFile` would also dedupe, but only after this route
    // had already written a file nothing would ever reference. Assets are
    // exempt because two identical ones still need separate identities — a
    // generated image and the same image re-used as an edit source.
    const duplicate = visual ? undefined : store.documentBySha256(sha256);
    if (duplicate) return context.json(publicFile(duplicate), 200);

    const id = `${isImage ? "img" : isVideo ? "vid" : "file"}_${randomBytes(16).toString("hex")}`;
    // The stored name is built from values this server knows, never from the
    // browser's `Content-Type`. It used to end `.${mime.split("/")[1]}`, and a
    // part declaring `image/..\..\..\pwned.txt` wrote attacker bytes wherever
    // that resolved to — the key file beside the database included.
    const storageExtension = MIME_EXTENSION[mime] ?? (EXTENSION_MIME[extension] ? extension : ".bin");
    const dir = visual ? paths.assetFiles : paths.files;
    fs.mkdirSync(dir, { recursive: true });
    const diskPath = path.join(dir, `${id}${storageExtension}`);
    fs.writeFileSync(diskPath, bytes);

    const file = store.addFile({
      id,
      name: upload.name,
      mime,
      bytes: bytes.byteLength,
      diskPath,
      sha256,
      conversationId,
      source: "upload",
    });

    if (isImage) {
      // Writing the sidecar is what lets an uploaded image be used as an edit
      // source exactly like a generated one.
      writeImageSidecar(id, {
        mime,
        byteLength: bytes.byteLength,
        sha256,
        storageFile: path.basename(diskPath),
        provider: "upload",
        origin: "upload",
      });
      store.registerImageAsset({ image_id: id, mime_type: mime, provider: "upload" });
      forgetAssetIndex();
    } else if (isVideo) {
      // No sidecar: that exists for the edit tools, and nothing edits a clip.
      // Dimensions and duration stay null — reading them needs a demuxer this
      // server does not have — and every reader already treats them as optional.
      store.registerVideoAsset({ videoId: id, mime, provider: "upload" });
      forgetAssetIndex();
    } else {
      const capabilities = config.capabilities();
      if (capabilities.files.enabled && capabilities.files.searchEnabled) {
        void retrieval
          .indexFile({ id, name: upload.name, mime, diskPath })
          .catch((error: unknown) => console.error(`[rag] ${id}:`, error));
      }
    }

    return context.json(publicFile(store.getFile(file.id)!), 201);
  });

  app.get("/files/:id", (context) => {
    const file = store.getFile(context.req.param("id"));
    if (!file) return fail(context, 404, "not_found", "File not found");
    return context.json(publicFile(file));
  });

  app.get("/files/:id/content", (context) => {
    const file = store.getFile(context.req.param("id"));
    if (!file || !fs.existsSync(file.diskPath)) return fail(context, 404, "not_found", "File not found");
    return new Response(new Uint8Array(fs.readFileSync(file.diskPath)), {
      headers: {
        "content-type": file.mime,
        "cache-control": "private, max-age=31536000, immutable",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      },
    });
  });

  app.delete("/files/:id", (context) => {
    const file = store.deleteFile(context.req.param("id"));
    if (file && fs.existsSync(file.diskPath)) fs.rmSync(file.diskPath, { force: true });
    return context.body(null, 204);
  });

  app.post("/files/:id/reindex", async (context) => {
    const file = store.getFile(context.req.param("id"));
    if (!file) return fail(context, 404, "not_found", "File not found");
    try {
      const result = await retrieval.indexFile(file);
      return context.json({ ...publicFile(store.getFile(file.id)!), ...result });
    } catch (error) {
      return failFromError(context, error);
    }
  });

  app.post("/files/search", async (context) => {
    const body = await readJson<{ query: string; mode: FileSearchMode; limit: number }>(context);
    const query = (body.query ?? "").trim();
    if (!query) return fail(context, 400, "invalid", "query is required");
    try {
      const mode = body.mode ?? config.capabilities().files.mode;
      return context.json(await retrieval.searchFiles(query, mode, body.limit ?? 10));
    } catch (error) {
      return failFromError(context, error);
    }
  });

  /**
   * Serves generated images by their `img_<hex>` id. Generated files are not
   * rows in `files`, so fall back to the asset directory.
   */
  app.get("/images/:imageId", async (context) => {
    const imageId = context.req.param("imageId");
    if (!/^img_[0-9a-f]{32}$/i.test(imageId)) return fail(context, 400, "invalid", "Malformed image id");
    const record = store.getFile(imageId);
    const diskPath = record?.diskPath ?? assetPath(imageId);
    if (!diskPath || !fs.existsSync(diskPath)) return fail(context, 404, "not_found", "Image not found");
    const extension = path.extname(diskPath).toLowerCase();
    const mime = record?.mime ?? EXTENSION_MIME[extension] ?? "application/octet-stream";

    const width = THUMBNAIL_WIDTHS.find((size) => size === Number(context.req.query("w")));
    if (width && mime !== "image/gif") {
      const thumb = await thumbnail(diskPath, imageId, width).catch(() => "");
      if (thumb) {
        return new Response(new Uint8Array(fs.readFileSync(thumb)), {
          headers: { "content-type": "image/webp", "cache-control": "private, max-age=31536000, immutable" },
        });
      }
    }

    return new Response(new Uint8Array(fs.readFileSync(diskPath)), {
      headers: { "content-type": mime, "cache-control": "private, max-age=31536000, immutable" },
    });
  });

  /**
   * Serves generated video by its `vid_<hex>` id, honouring `Range`. A browser
   * seeking in a video sends one, and a server that ignores it makes every
   * scrub download the whole file again.
   */
  app.get("/videos/:videoId", (context) => {
    const videoId = context.req.param("videoId");
    if (!/^vid_[0-9a-f]{32}$/i.test(videoId)) return fail(context, 400, "invalid", "Malformed video id");
    const record = store.getFile(videoId);
    const diskPath = record?.diskPath ?? assetPath(videoId);
    if (!diskPath || !fs.existsSync(diskPath)) return fail(context, 404, "not_found", "Video not found");
    const mime = record?.mime ?? store.getVideoAsset(videoId)?.mime ?? "video/mp4";
    const total = fs.statSync(diskPath).size;
    const common = {
      "content-type": mime,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=31536000, immutable",
    };

    const range = /^bytes=(\d*)-(\d*)$/.exec(context.req.header("range") ?? "");
    if (!range) {
      return new Response(new Uint8Array(fs.readFileSync(diskPath)), {
        headers: { ...common, "content-length": String(total) },
      });
    }
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (!Number.isFinite(start) || start > end || start >= total) {
      return new Response(null, { status: 416, headers: { ...common, "content-range": `bytes */${total}` } });
    }
    const handle = fs.openSync(diskPath, "r");
    try {
      const chunk = Buffer.alloc(end - start + 1);
      fs.readSync(handle, chunk, 0, chunk.byteLength, start);
      return new Response(new Uint8Array(chunk), {
        status: 206,
        headers: {
          ...common,
          "content-length": String(chunk.byteLength),
          "content-range": `bytes ${start}-${end}/${total}`,
        },
      });
    } finally {
      fs.closeSync(handle);
    }
  });

  /**
   * Where one asset came from. Two rows answer it — the asset knows its backend
   * and its parents, the job knows the prompt and the parameters — and neither is
   * asked to keep the other's copy, so the two can never disagree.
   *
   * Both media get the same route because the question is the same one, and a
   * client that has an id already knows which kind it holds from its prefix.
   */
  const provenance = (context: Context, assetId: string, kind: "image" | "video") => {
    const asset = kind === "image" ? store.getImageAsset(assetId) : undefined;
    const video = kind === "video" ? store.getVideoAsset(assetId) : undefined;
    const file = store.getFile(assetId);
    // Neither an asset row nor a library row means nothing here made this and
    // nothing here has it, which is a 404 rather than an empty answer.
    if (!asset && !video && !file) return fail(context, 404, "not_found", "Asset not found");

    const job = store.jobForAsset(assetId);
    const model = job ? store.getModel(job.modelId) : undefined;
    const record: Provenance = {
      assetId,
      kind,
      mime: asset?.mime ?? video?.mime ?? file?.mime ?? (kind === "image" ? "image/png" : "video/mp4"),
      width: asset?.width ?? video?.width ?? file?.width ?? null,
      height: asset?.height ?? video?.height ?? file?.height ?? null,
      durationMs: video?.durationMs ?? null,
      provider: asset?.provider ?? video?.provider ?? file?.source ?? null,
      model: asset?.model ?? video?.model ?? null,
      parents: asset?.parentImageIds ?? video?.parentImageIds ?? [],
      createdAt: asset?.createdAt ?? video?.createdAt ?? file?.createdAt ?? 0,
      job: job
        ? {
            id: job.id,
            op: job.op,
            modelId: job.modelId,
            modelName: job.modelName,
            repeatable: Boolean(model?.enabled && opsOf(model).includes(job.op)),
            params: job.params,
            sources: job.sources,
            elapsedMs: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : null,
          }
        : undefined,
    };
    return context.json(record);
  };

  app.get("/images/:imageId/provenance", (context) => {
    const imageId = context.req.param("imageId");
    if (!/^img_[0-9a-f]{32}$/i.test(imageId)) return fail(context, 400, "invalid", "Malformed image id");
    return provenance(context, imageId.toLowerCase(), "image");
  });

  app.get("/videos/:videoId/provenance", (context) => {
    const videoId = context.req.param("videoId");
    if (!/^vid_[0-9a-f]{32}$/i.test(videoId)) return fail(context, 400, "invalid", "Malformed video id");
    return provenance(context, videoId.toLowerCase(), "video");
  });

  return app;
}

const TEXT_MIMES = new Set(["text/markdown", "text/plain", "text/csv", "application/json", "text/html"]);
const isTextual = (mime: string) => TEXT_MIMES.has(mime) || mime.startsWith("text/");

/**
 * Creates or rewrites a user-authored document. Indexing is deliberately
 * synchronous-ish (fire and forget, but started before the response) so a note
 * saved and immediately searched behaves the way the user expects.
 */
function writeNote(services: Services, name: string, text: string, existingId?: string) {
  const { store, config, retrieval } = services;
  const id = existingId ?? `file_${randomBytes(16).toString("hex")}`;
  fs.mkdirSync(paths.files, { recursive: true });
  const diskPath = store.getFile(id)?.diskPath ?? path.join(paths.files, `${id}.md`);
  const bytes = Buffer.from(text, "utf8");
  fs.writeFileSync(diskPath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const file = existingId
    ? store.updateFileContent(id, { name, bytes: bytes.byteLength, sha256 })
    : store.addFile({
        id,
        name,
        mime: "text/markdown",
        bytes: bytes.byteLength,
        diskPath,
        sha256,
        source: "note",
      });

  // A brand-new note whose text already exists byte for byte folds into the
  // entry that holds it, so the file just written here has nothing pointing at
  // it. Index against the row that survived rather than the id minted above.
  if (file.id !== id) fs.rmSync(diskPath, { force: true });

  if (config.capabilities().files.searchEnabled) {
    void retrieval
      .indexFile({ id: file.id, name: file.name, mime: "text/markdown", diskPath: file.diskPath })
      .catch((error: unknown) => console.error(`[rag] ${file.id}:`, error));
  }
  return file;
}

/** Fixed rungs keep the on-disk cache bounded and the URLs cacheable. */
const THUMBNAIL_WIDTHS = [320, 640, 1280];

async function thumbnail(source: string, imageId: string, width: number) {
  const target = path.join(paths.thumbs, `${imageId}_${width}.webp`);
  if (fs.existsSync(target)) return target;
  const { default: sharp } = await import("sharp");
  fs.mkdirSync(paths.thumbs, { recursive: true });
  await sharp(source, { animated: false })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(target);
  return target;
}
