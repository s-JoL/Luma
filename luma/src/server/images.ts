import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ImageAsset } from "@shared/types.ts";
import { paths } from "./env.ts";
import type { Store } from "./store/store.ts";

/**
 * Image tools write bytes straight into the asset directory, so a generated
 * image is a file on disk before Luma knows anything about it. The directory is
 * indexed once instead of being scanned per request; a miss refreshes the
 * index, throttled so a stale id cannot turn every request into a directory
 * walk.
 */
let index = new Map<string, string>();
let indexedAt = 0;

function refresh() {
  index = new Map();
  indexedAt = Date.now();
  if (!fs.existsSync(paths.assetFiles)) return;
  for (const name of fs.readdirSync(paths.assetFiles)) {
    const dot = name.indexOf(".");
    if (dot > 0) index.set(name.slice(0, dot), path.join(paths.assetFiles, name));
  }
}

export function assetPath(imageId: string) {
  if (!indexedAt) refresh();
  const hit = index.get(imageId);
  if (hit) return fs.existsSync(hit) ? hit : undefined;
  if (Date.now() - indexedAt < 2_000) return undefined;
  refresh();
  const retry = index.get(imageId);
  return retry && fs.existsSync(retry) ? retry : undefined;
}

/** Called after a tool writes a new image so the next request sees it. */
export function forgetAssetIndex() {
  indexedAt = 0;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

/**
 * The bytes on disk say nothing about where they came from, so provenance is
 * written beside them: what made the picture, from which parents, and what it
 * weighed. Anything that lands in the asset directory writes one, which is what
 * lets the file be identified again after the row that described it is gone.
 */
export function writeImageSidecar(
  imageId: string,
  meta: {
    mime: string;
    byteLength: number;
    sha256: string;
    storageFile: string;
    provider: string;
    model?: string | null;
    parents?: string[];
    origin: string;
    width?: number | null;
    height?: number | null;
  },
) {
  fs.mkdirSync(paths.assetMeta, { recursive: true });
  fs.writeFileSync(
    path.join(paths.assetMeta, `${imageId}.json`),
    JSON.stringify(
      {
        image_id: imageId,
        origin: meta.origin,
        parent_image_ids: meta.parents ?? [],
        width: meta.width ?? null,
        height: meta.height ?? null,
        mime_type: meta.mime,
        byte_length: meta.byteLength,
        sha256: meta.sha256,
        storage_file: meta.storageFile,
        provider: meta.provider,
        provider_model: meta.model ?? null,
        created_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * The pixel size of encoded bytes, for the providers that do not report one.
 * Every surface that lays an image out — the gallery's columns, the transcript's
 * placeholder, a client deciding what to download — needs it, and reading it
 * once here is cheaper than every reader guessing.
 */
async function measure(bytes: Buffer) {
  try {
    const { default: sharp } = await import("sharp");
    const meta = await sharp(bytes).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

/**
 * Where an image's bytes are, whichever way it arrived. Generated assets are
 * adopted into `files`, but adoption can lag a render by a moment, so the asset
 * directory stays the fallback rather than the exception.
 */
export function locateImage(store: Store, id: string) {
  const file = store.getFile(id);
  if (file && file.mime.startsWith("image/") && fs.existsSync(file.diskPath)) {
    return { diskPath: file.diskPath, mime: file.mime, width: file.width, height: file.height };
  }
  const diskPath = assetPath(id);
  if (!diskPath) return undefined;
  // Videos live in the same directory and are indexed by the same walk, so an
  // unrecognised extension has to be a miss rather than a guess. Defaulting it
  // to `image/png` meant a `vid_…` id — which the transcript now names in plain
  // text, so it is the obvious thing for a model to try — resolved to an mp4
  // that was then base64'd whole and posted as a picture.
  const extension = path.extname(diskPath).toLowerCase();
  const mime = Object.entries(EXTENSIONS).find(([, value]) => value === extension)?.[0];
  return mime ? { diskPath, mime, width: null, height: null } : undefined;
}

/**
 * The longest edge a model is ever shown. Vision models tile an image into
 * fixed patches and stop, so pixels past the last tile are billed and then
 * discarded; a 4K render costs the same to look at as this once it is resized.
 */
const MODEL_IMAGE_EDGE = 1568;

/**
 * The edge limit alone is not the ceiling. Anthropic also caps an image at 1568
 * visual tokens, counted as ceil(w/28) × ceil(h/28), so a 1568×1568 upload is
 * 3,136 tokens and is downscaled again server-side — we would be paying to send
 * pixels the model never sees. 1568 tokens × 750 px per token is the area that
 * survives, and for a square source it lands beside the documented 1092×1092
 * no-resize size.
 *
 * Newer Claude tiers raise this to 2576 px / 4784 tokens, so this may have to
 * become a per-model property rather than one number.
 */
const MODEL_IMAGE_AREA = 1_176_000;

/**
 * The longest edge to encode at, honouring both ceilings. Returned as an edge
 * because that is what `fit: "inside"` understands, and scaling both sides by
 * the same factor is what keeps the aspect ratio the model is shown correct.
 */
function modelEdge(width?: number | null, height?: number | null) {
  if (!width || !height) return MODEL_IMAGE_EDGE;
  const scale = Math.sqrt(MODEL_IMAGE_AREA / (width * height));
  if (scale >= 1) return MODEL_IMAGE_EDGE;
  return Math.min(MODEL_IMAGE_EDGE, Math.floor(Math.max(width, height) * scale));
}

/**
 * The one encoder for every image a model sees — an upload, a fresh render, an
 * older picture it asked to look at. Routing all of them through here is what
 * makes the cost of looking a property of Luma rather than of whichever backend
 * happened to draw it, and the encoded copy is cached so looking twice is free.
 */
export async function encodeForModel(id: string, diskPath: string, mime: string) {
  if (!fs.existsSync(diskPath)) return undefined;
  const cached = path.join(paths.thumbs, `${id}_model.jpg`);
  try {
    if (!fs.existsSync(cached)) {
      const { default: sharp } = await import("sharp");
      fs.mkdirSync(paths.thumbs, { recursive: true });
      // Encoded aside and moved into place, because `toFile` creates the target
      // and then grows it: a second caller — tools run in parallel — would find
      // the path existing, skip the encode, and read half a JPEG.
      const staging = `${cached}.${randomBytes(6).toString("hex")}.tmp`;
      // The area cap needs the source size, and `metadata()` reports it
      // pre-rotation, so a portrait photo tagged sideways has to be un-swapped
      // here or it would be measured as landscape.
      const source = await sharp(diskPath, { animated: false }).metadata();
      const upright = (source.orientation ?? 1) >= 5;
      const edge = modelEdge(
        upright ? source.height : source.width,
        upright ? source.width : source.height,
      );
      try {
        await sharp(diskPath, { animated: false })
          .rotate()
          .resize({
            width: edge,
            height: edge,
            fit: "inside",
            withoutEnlargement: true,
          })
          // Transparency reads as black to a model that has no alpha channel.
          .flatten({ background: "#ffffff" })
          // sharp's own default for jpeg() and webp(); named rather than omitted
          // so a future change to it is a decision here, not an upgrade.
          .jpeg({ quality: 80 })
          .toFile(staging);
        fs.renameSync(staging, cached);
      } catch (error) {
        fs.rmSync(staging, { force: true });
        throw error;
      }
    }
    return { data: fs.readFileSync(cached).toString("base64"), mimeType: "image/jpeg" };
  } catch {
    // Sharp could not read it. Passing the raw bytes through is worth doing for
    // a format a provider accepts anyway, and is actively harmful otherwise:
    // shipping a BMP, an AVIF or an entire video under an image mime fails the
    // whole turn instead of one attachment.
    if (!EXTENSIONS[mime]) return undefined;
    try {
      return { data: fs.readFileSync(diskPath).toString("base64"), mimeType: mime };
    } catch {
      return undefined;
    }
  }
}

/**
 * Persists image bytes produced by a provider call: same directory, sidecar and
 * provenance as an MCP tool's output, so the studio, the gallery and the edit
 * tools cannot tell the two apart.
 */
export async function saveImageBytes(
  store: Store,
  bytes: Buffer,
  meta: {
    mime: string;
    provider: string;
    model?: string | null;
    width?: number | null;
    height?: number | null;
    /** Source images an edit was derived from, so provenance survives. */
    parents?: string[];
  },
) {
  const imageId = `img_${randomBytes(16).toString("hex")}`;
  const extension = EXTENSIONS[meta.mime] ?? ".png";
  fs.mkdirSync(paths.assetFiles, { recursive: true });
  const storageFile = `${imageId}${extension}`;
  fs.writeFileSync(path.join(paths.assetFiles, storageFile), bytes);
  const size = meta.width && meta.height ? { width: meta.width, height: meta.height } : await measure(bytes);
  writeImageSidecar(imageId, {
    mime: meta.mime,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storageFile,
    provider: meta.provider,
    model: meta.model,
    parents: meta.parents,
    origin: meta.parents?.length ? "edited" : "generated",
    ...size,
  });
  registerGeneratedImage(store, {
    image_id: imageId,
    mime_type: meta.mime,
    ...size,
    provider: meta.provider,
    model: meta.model ?? null,
    parent_image_ids: meta.parents ?? [],
  });
  return imageId;
}

const VIDEO_EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

/**
 * Video lands beside images: same directory, same `files` row, so the library
 * and the gallery see it without learning a new table. There is no sidecar,
 * because the sidecar exists for the edit tools and nothing edits a video.
 */
export function saveVideoBytes(
  store: Store,
  bytes: Buffer,
  meta: {
    mime: string;
    provider: string;
    model?: string | null;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    posterImageId?: string | null;
    parents?: string[];
  },
) {
  const videoId = `vid_${randomBytes(16).toString("hex")}`;
  const extension = VIDEO_EXTENSIONS[meta.mime] ?? ".mp4";
  fs.mkdirSync(paths.assetFiles, { recursive: true });
  const storageFile = `${videoId}${extension}`;
  const diskPath = path.join(paths.assetFiles, storageFile);
  fs.writeFileSync(diskPath, bytes);
  forgetAssetIndex();
  const asset = store.registerVideoAsset({
    videoId,
    mime: meta.mime,
    width: meta.width ?? null,
    height: meta.height ?? null,
    durationMs: meta.durationMs ?? null,
    posterImageId: meta.posterImageId ?? null,
    provider: meta.provider,
    model: meta.model ?? null,
    parents: meta.parents ?? [],
  });
  const createdAt = asset?.createdAt ?? Date.now();
  if (!store.getFile(videoId)) {
    store.addFile({
      id: videoId,
      name: `${meta.provider}_${stamp(createdAt)}_${videoId.slice(4, 12)}${extension}`,
      mime: meta.mime,
      bytes: bytes.byteLength,
      diskPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      source: "generated",
      width: meta.width ?? null,
      height: meta.height ?? null,
      createdAt,
    });
  }
  return videoId;
}

const stamp = (at: number) => {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
};

/**
 * Gives a generated image a row in `files` so one library lists everything the
 * user owns, whatever produced it. The asset directory stays the source of
 * truth for the bytes; this only records the identity, which is what the
 * library, the filters and deletion all key off.
 */
function adoptImageAsset(store: Store, asset: ImageAsset) {
  if (store.getFile(asset.imageId)) return undefined;
  const diskPath = assetPath(asset.imageId);
  if (!diskPath) return undefined;
  const bytes = fs.readFileSync(diskPath);
  const extension = path.extname(diskPath) || ".png";
  const origin = asset.provider ?? "generated";
  return store.addFile({
    id: asset.imageId,
    name: `${origin}_${stamp(asset.createdAt)}_${asset.imageId.slice(4, 12)}${extension}`,
    mime: asset.mime,
    bytes: bytes.byteLength,
    diskPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: "generated",
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt,
  });
}

/**
 * Single entry point for "a tool just produced an image": records provenance,
 * puts it in the library, and invalidates the path index so the very next
 * request can serve it.
 */
export function registerGeneratedImage(store: Store, meta: unknown) {
  const asset = store.registerImageAsset(meta);
  if (!asset) return undefined;
  forgetAssetIndex();
  adoptImageAsset(store, asset);
  return asset;
}

/** One-time catch-up for images generated before the library was unified. */
export function adoptOrphanedAssets(store: Store) {
  let adopted = 0;
  for (const asset of store.unadoptedImageAssets()) {
    if (adoptImageAsset(store, asset)) adopted += 1;
  }
  return adopted;
}
