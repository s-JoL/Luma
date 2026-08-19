/**
 * The generation layer against fake backends: the adapters, the job queue, and
 * the tools the model is offered.
 *
 * The backends are local HTTP servers that speak the same wire protocol as
 * ComfyUI, an OpenAI-shaped image API and an asynchronous video API, which is
 * what lets this assert on submit/poll/fetch, cancellation and restart recovery
 * without a GPU or a bill. The claims tested are the ones in
 * `08-generation.md §What must be tested`.
 *
 *   node --import tsx scripts/audit-generation.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "luma-generation-"));
process.env.LUMA_DATA_DIR = path.join(sandbox, "data");

const { paths, ensureDirectories } = await import("../src/server/env.ts");
const { Db } = await import("../src/server/store/db.ts");
const { Store } = await import("../src/server/store/store.ts");
const { SecretVault } = await import("../src/server/crypto/secrets.ts");
const { SECRET } = await import("../src/server/config.ts");
const { Jobs } = await import("../src/server/generation/jobs.ts");
const { opsOf, schemaOf, supportsOp } = await import("../src/server/generation/index.ts");
const { generationTools } = await import("../src/server/tools/generation.ts");
const { jobProviderId } = await import("../src/server/store/store.ts");
const { classifyModel } = await import("../src/server/models/catalogue.ts");
const { saveImageBytes } = await import("../src/server/images.ts");

ensureDirectories();

let failures = 0;

async function check(name: string, run: () => Promise<string | void> | string | void) {
  try {
    const note = await run();
    console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

/**
 * An 8×8 PNG, so the fake backends return bytes a decoder actually accepts.
 * The one-pixel fixture this replaced was truncated and failed to parse, which
 * silently exercised every fallback path instead of the real one.
 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWM4UaGBFTEMLQkAUtVaAUH78mEAAAAASUVORK5CYII=",
  "base64",
);
const MP4 = Buffer.concat([Buffer.from("\u0000\u0000\u0000\u0018ftypmp42"), crypto.randomBytes(64)]);

const listen = (server: http.Server) =>
  new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

const body = (request: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => resolve(raw));
  });

/* ── the fake ComfyUI ────────────────────────────────────────────────────── */

interface ComfyState {
  prompts: Map<string, { graph: Record<string, { inputs?: Record<string, unknown> }>; done: boolean }>;
  cancelled: string[];
  uploads: string[];
  /** Polls before a prompt is reported finished, so progress has to be waited on. */
  pollsBeforeDone: number;
  polls: Map<string, number>;
  views: string[];
}

const comfyState: ComfyState = {
  prompts: new Map(),
  cancelled: [],
  uploads: [],
  pollsBeforeDone: 1,
  polls: new Map(),
  views: [],
};

const comfyServer = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://comfy");
  const send = (status: number, payload: unknown, mime = "application/json") => {
    response.writeHead(status, { "content-type": mime });
    response.end(typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
  };

  if (request.method === "POST" && url.pathname === "/prompt") {
    const parsed = JSON.parse(await body(request)) as { prompt_id: string; prompt: never };
    comfyState.prompts.set(parsed.prompt_id, { graph: parsed.prompt, done: false });
    return send(200, { prompt_id: parsed.prompt_id });
  }
  if (request.method === "POST" && url.pathname === "/upload/image") {
    const name = `uploaded-${comfyState.uploads.length}.png`;
    comfyState.uploads.push(name);
    return send(200, { name });
  }
  if (url.pathname.startsWith("/history/")) {
    const id = decodeURIComponent(url.pathname.slice("/history/".length));
    const seen = (comfyState.polls.get(id) ?? 0) + 1;
    comfyState.polls.set(id, seen);
    if (!comfyState.prompts.has(id) || seen <= comfyState.pollsBeforeDone) return send(200, {});
    return send(200, {
      [id]: {
        status: { status_str: "success", completed: true },
        outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
      },
    });
  }
  if (url.pathname === "/view") {
    comfyState.views.push(url.searchParams.get("preview") ?? "full");
    return send(200, PNG, "image/png");
  }
  if (url.pathname === "/queue") return send(200, { queue_running: [], queue_pending: [] });
  if (url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/cancel")) {
    comfyState.cancelled.push(decodeURIComponent(url.pathname.split("/")[3] ?? ""));
    return send(200, {});
  }
  if (url.pathname.startsWith("/api/jobs/")) return send(404, {});
  return send(404, { error: url.pathname });
});

/* ── the fake hosted API: OpenAI-shaped images plus async video ───────────── */

interface HostedState {
  edits: number;
  generations: number;
  videoStatus: string[];
  videoPolls: number;
  videoSubmits: number;
  cancelledVideos: string[];
  /** Drops the connection on the next request to this route, once. */
  dropNext: Set<string>;
}

const hostedState: HostedState = {
  edits: 0,
  generations: 0,
  videoStatus: ["queued", "in_progress", "completed"],
  videoPolls: 0,
  videoSubmits: 0,
  cancelledVideos: [],
  dropNext: new Set(),
};

const hostedServer = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://hosted");
  const send = (status: number, payload: unknown, mime = "application/json") => {
    response.writeHead(status, { "content-type": mime });
    response.end(typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
  };

  // A hosted render can take a minute and a half, long enough that the socket
  // sometimes dies before the answer arrives. This is that.
  if (hostedState.dropNext.has(url.pathname)) {
    hostedState.dropNext.delete(url.pathname);
    if (url.pathname === "/images/generations") hostedState.generations += 1;
    if (url.pathname === "/videos") hostedState.videoSubmits += 1;
    request.destroy();
    response.destroy();
    return;
  }

  if (request.method === "POST" && url.pathname === "/images/generations") {
    hostedState.generations += 1;
    await body(request);
    return send(200, { data: [{ b64_json: PNG.toString("base64") }] });
  }
  if (request.method === "POST" && url.pathname === "/images/edits") {
    hostedState.edits += 1;
    await body(request);
    return send(200, { data: [{ b64_json: PNG.toString("base64") }] });
  }
  if (request.method === "POST" && url.pathname === "/videos") {
    hostedState.videoSubmits += 1;
    await body(request);
    return send(200, { id: "vid-remote-1", status: "queued" });
  }
  if (request.method === "POST" && url.pathname.endsWith("/cancel")) {
    hostedState.cancelledVideos.push(url.pathname.split("/")[2] ?? "");
    return send(200, {});
  }
  if (url.pathname === "/videos/vid-remote-1/content") return send(200, MP4, "video/mp4");
  if (url.pathname === "/videos/vid-remote-1") {
    const index = Math.min(hostedState.videoPolls, hostedState.videoStatus.length - 1);
    hostedState.videoPolls += 1;
    return send(200, { id: "vid-remote-1", status: hostedState.videoStatus[index], progress: 50 });
  }
  if (url.pathname === "/models") {
    return send(200, {
      data: [
        { id: "grok-4.6" },
        { id: "seedream-5-pro" },
        { id: "seedance-2.5-pro" },
        { id: "text-embedding-3-large" },
      ],
    });
  }
  return send(404, { error: url.pathname });
});

const comfyUrl = await listen(comfyServer);
const hostedUrl = await listen(hostedServer);

/* ── the deployment under test ───────────────────────────────────────────── */

const db = new Db(path.join(sandbox, "data", "luma.sqlite"));
const store = new Store(db);
const vault = new SecretVault(store, crypto.randomBytes(32));
store.upsertProvider({ id: "comfy", name: "Local ComfyUI", baseUrl: comfyUrl });
store.upsertProvider({ id: "hosted", name: "Hosted", baseUrl: hostedUrl });
vault.set(SECRET.provider("hosted"), "test-key");

fs.writeFileSync(
  path.join(paths.workflows, "audit.json"),
  JSON.stringify({
    "4": { class_type: "CLIPTextEncode", inputs: { text: "placeholder" } },
    "7": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 } },
    "8": { class_type: "KSampler", inputs: { seed: 0 } },
    "9": { class_type: "SaveImage", inputs: { images: ["7", 0] } },
  }),
);
fs.writeFileSync(
  path.join(paths.workflows, "audit-edit.json"),
  JSON.stringify({
    "1": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "placeholder" } },
    "5": { class_type: "ImageScaleToMegapixels", inputs: { megapixels: 1 } },
    "9": { class_type: "SaveImage", inputs: { images: ["5", 0] } },
  }),
);

const chatModel = {
  id: "chat", providerId: "hosted", name: "Grok", model: "grok-4.6", kind: "chat" as const, ops: [],
  enabled: true, pinned: true, reasoning: false, input: ["text" as const],
  contextWindow: 128_000, maxTokens: 8_192, thinkingLevel: "off" as const,
  apiMode: "openai-chat" as const, librechatCompat: false,
};

store.upsertModel(chatModel);
store.upsertModel({
  ...chatModel,
  id: "local", name: "Lustify v10", model: "lustify-v10", providerId: "comfy",
  kind: "image", ops: ["text_to_image"], apiMode: "comfy-workflow",
  params: { workflow: "audit.json", bind: { prompt: "4.inputs.text", width: "7.inputs.width", height: "7.inputs.height", seed: "8.inputs.seed" }, sizes: { auto: [512, 768], "1:1": [640, 640] } },
});
store.upsertModel({
  ...chatModel,
  id: "local-edit", name: "Qwen Edit", model: "qwen-edit", providerId: "comfy",
  kind: "image", ops: ["image_to_image"], apiMode: "comfy-workflow",
  params: { workflow: "audit-edit.json", bind: { prompt: "4.inputs.text", source: "1.inputs.image", megapixels: "5.inputs.megapixels" } },
});
store.upsertModel({
  ...chatModel,
  id: "hosted-image", name: "Seedream", model: "seedream-5-pro", providerId: "hosted",
  kind: "image", ops: ["text_to_image", "image_to_image"], apiMode: "openai-images",
});
store.upsertModel({
  ...chatModel,
  id: "hosted-video", name: "Seedance", model: "seedance-2.5-pro", providerId: "hosted",
  kind: "video", ops: ["text_to_video", "image_to_video"], apiMode: "openai-videos",
  params: { durations: [5, 10] },
});

const jobs = new Jobs(store, vault);
const spec = (id: string) => {
  const found = store.getModel(id);
  if (!found) throw new Error(`missing model ${id}`);
  return found;
};

/* ── the checks ──────────────────────────────────────────────────────────── */

await check("a workflow model draws with only a row and a graph file", async () => {
  const job = await jobs.run({ modelId: "local", params: { prompt: "a bowl of beef balls", aspect_ratio: "1:1" } });
  assert(job.status === "succeeded", `job ${job.status}: ${job.error}`);
  const asset = job.assets[0]!;
  assert(/^img_[0-9a-f]{32}$/.test(asset.assetId), `asset id ${asset.assetId}`);
  assert(fs.existsSync(store.getFile(asset.assetId)!.diskPath), "asset bytes were not saved");
  const submitted = [...comfyState.prompts.values()].at(-1)!;
  assert(submitted.graph["4"]!.inputs!.text === "a bowl of beef balls", "the prompt was not bound into the graph");
  assert(submitted.graph["7"]!.inputs!.width === 640, `width bound as ${submitted.graph["7"]!.inputs!.width}`);
  assert(submitted.graph["8"]!.inputs!.seed !== 0, "the seed was left at the graph's value");
  // One render, one download. The second fetch that used to pull a `jpeg;80`
  // preview was never read by anything: what the model sees is encoded once,
  // from the bytes on disk, the same way for every backend.
  assert(comfyState.views.length === 1, `the image was fetched ${comfyState.views.length} times`);
  assert(!comfyState.views.some((view) => view !== "full"), `a preview variant was requested: ${comfyState.views}`);
  return `${asset.assetId} at 640×640, seed randomised`;
});

await check("the same size cannot be asked for twice and mean two things", async () => {
  const job = await jobs.run({ modelId: "local", params: { prompt: "x", width: "4096", height: "4096" } });
  assert(job.status === "failed", `a 16MP request ${job.status}`);
  assert(/pixel budget/.test(job.error ?? ""), `error was ${job.error}`);
  return "a request above the workflow's pixel budget is refused before submitting";
});

const seedImage = await saveImageBytes(store, PNG, {
  mime: "image/png",
  provider: "hosted",
  model: "seed",
  width: 1,
  height: 1,
});

await check("a local edit and a hosted edit agree on shape and on parentage", async () => {
  const local = await jobs.run({ modelId: "local-edit", params: { prompt: "make it warmer", source_image_id: seedImage } });
  const hosted = await jobs.run({ modelId: "hosted-image", op: "image_to_image", params: { prompt: "make it warmer", source_image_id: seedImage } });
  for (const [label, job] of [["local", local], ["hosted", hosted]] as const) {
    assert(job.status === "succeeded", `${label} edit ${job.status}: ${job.error}`);
    assert(job.assets.length === 1 && job.assets[0]!.kind === "image", `${label} returned ${JSON.stringify(job.assets)}`);
    assert(job.sources[0] === seedImage, `${label} lost the source id`);
    const asset = store.getImageAsset(job.assets[0]!.assetId);
    assert(asset?.parentImageIds?.includes(seedImage), `${label} did not record the parent image`);
  }
  assert(comfyState.uploads.length === 1, `${comfyState.uploads.length} uploads to ComfyUI`);
  const graph = [...comfyState.prompts.values()].at(-1)!.graph;
  assert(graph["1"]!.inputs!.image === comfyState.uploads[0], "the uploaded name was not bound");
  assert(hostedState.edits === 1, `${hostedState.edits} hosted edits`);
  return "both produced one image with the source recorded as its parent";
});

await check("a cancelled local job tells ComfyUI to stop as well", async () => {
  comfyState.pollsBeforeDone = 1_000;
  const job = jobs.submit({ modelId: "local", params: { prompt: "something slow" } });
  const settled = jobs.await(job.id);
  // Cancel only once the backend owns the work, which is what makes the
  // forwarded cancel meaningful.
  for (let i = 0; i < 100 && !jobProviderId(store, job.id); i += 1) await new Promise((r) => setTimeout(r, 20));
  const promptId = jobProviderId(store, job.id);
  assert(promptId, "the job never adopted a prompt id");
  await jobs.cancel(job.id);
  const done = await settled;
  assert(done.status === "cancelled", `job ${done.status}`);
  assert(comfyState.cancelled.includes(promptId!), `ComfyUI was not told: ${JSON.stringify(comfyState.cancelled)}`);
  comfyState.pollsBeforeDone = 1;
  return `prompt ${promptId!.slice(0, 8)} cancelled upstream`;
});

await check("a local backend renders one at a time", async () => {
  comfyState.pollsBeforeDone = 2;
  const first = jobs.submit({ modelId: "local", params: { prompt: "one" } });
  const second = jobs.submit({ modelId: "local", params: { prompt: "two" } });
  await new Promise((r) => setTimeout(r, 50));
  const states = [store.getJob(first.id)!.status, store.getJob(second.id)!.status];
  assert(states[0] === "running" && states[1] === "queued", `states were ${states.join(", ")}`);
  await Promise.all([jobs.await(first.id), jobs.await(second.id)]);
  comfyState.pollsBeforeDone = 1;
  return "the second waited while the first held the GPU";
});

await check("a video arrives as a video asset with its own kind", async () => {
  const job = await jobs.run({ modelId: "hosted-video", params: { prompt: "a wave", duration: 5 } });
  assert(job.status === "succeeded", `video job ${job.status}: ${job.error}`);
  const asset = job.assets[0]!;
  assert(asset.kind === "video" && /^vid_[0-9a-f]{32}$/.test(asset.assetId), `asset ${JSON.stringify(asset)}`);
  assert(store.getVideoAsset(asset.assetId), "no provenance row for the video");
  assert(store.getFile(asset.assetId), "the video is invisible to the library");
  assert(hostedState.videoPolls >= 2, `settled after ${hostedState.videoPolls} polls`);
  return `${asset.assetId} after ${hostedState.videoPolls} polls`;
});

await check("a render the backend owns survives a restart, one it does not is failed", async () => {
  const owned = store.createJob({ kind: "video", op: "text_to_video", modelId: "hosted-video", modelName: "Seedance", params: { prompt: "a" }, sources: [] });
  store.markJobRunning(owned.id);
  store.setJobProviderId(owned.id, "vid-remote-1");
  const orphan = store.createJob({ kind: "image", op: "text_to_image", modelId: "local", modelName: "Lustify", params: { prompt: "b" }, sources: [] });
  store.markJobRunning(orphan.id);
  const queued = store.createJob({ kind: "image", op: "text_to_image", modelId: "local", modelName: "Lustify", params: { prompt: "c" }, sources: [] });

  hostedState.videoPolls = hostedState.videoStatus.length - 1;
  const report = new Jobs(store, vault).recover();
  assert(store.getJob(orphan.id)!.status === "failed", "a locally orphaned render was not failed");
  assert(report.rejoined === 1, `rejoined ${report.rejoined}`);
  assert(report.requeued === 1, `requeued ${report.requeued}`);
  await new Promise((r) => setTimeout(r, 200));
  assert(store.getJob(queued.id)!.status !== "queued", "a queued job was not picked up again");
  return `1 rejoined, 1 requeued, 1 failed`;
});

await check("a dropped connection does not throw away a paid render", async () => {
  const before = hostedState.generations;
  hostedState.dropNext.add("/images/generations");
  const job = await jobs.run({ modelId: "hosted-image", params: { prompt: "a persimmon" } });
  assert(job.status === "succeeded", `job ${job.status}: ${job.error}`);
  assert(hostedState.generations === before + 2, `${hostedState.generations - before} attempts`);
  return "the request was made again and the image arrived";
});

await check("a video submit is never retried", async () => {
  const before = hostedState.videoSubmits;
  hostedState.dropNext.add("/videos");
  const job = await jobs.run({ modelId: "hosted-video", params: { prompt: "a wave" } });
  assert(job.status === "failed", `job ${job.status}`);
  assert(hostedState.videoSubmits === before + 1, `${hostedState.videoSubmits - before} submits`);
  return "one submit, one failure: a second would queue a second paid render";
});

await check("the model's tool is the studio's form minus the knobs only a person sets", () => {
  const form = schemaOf(spec("local"), "text_to_image");
  const tools = generationTools({ jobs, store, conversationId: "c1", image: spec("local"), uploads: [] });
  const tool = tools.find((entry) => entry.name === "generate_image")!;
  const advertised = (tool.parameters as { properties: Record<string, unknown>; required?: string[] }).properties;
  // `intent` is the live status label every native tool takes, not something the
  // backend is asked for, so it is the one key a form has no business rendering.
  const keys = Object.keys(advertised);
  assert(keys[0] === "intent", "intent has to come first for a client to label the call");
  const declared = Object.entries(form.properties ?? {});
  const offered = declared.filter(([, field]) => field.audience !== "studio").map(([name]) => name);
  const withheld = declared.filter(([, field]) => field.audience === "studio").map(([name]) => name);
  // The two audiences may differ only by that marking. Anything else on one side
  // alone is a knob one of them has never heard of, which is the drift this whole
  // arrangement exists to prevent.
  assert(keys.slice(1).join() === offered.join(), "the form and the tool diverge by more than the marking");
  assert("aspect_ratio" in advertised, "the tool cannot choose a size the form offers");
  // And the marking has to bite: exact pixels stay with the person, because a
  // model that could still send them could contradict the ratio beside them.
  assert(withheld.includes("width"), "the form lost the exact size a person sets by hand");
  assert(!("width" in advertised), "the model can still contradict the aspect ratio it just chose");
  // A parameter the model cannot send must never be one the call demands.
  const demanded = form.required ?? [];
  assert(!withheld.some((name) => demanded.includes(name)), "a call requires something only a person can send");
  return `${offered.length} offered to the model, ${withheld.length} kept for the form, plus intent`;
});

await check("an operation that consumes an image demands one, an optional frame stays optional", () => {
  for (const id of ["local", "hosted-image"] as const) {
    const editable = supportsOp(spec(id), "image_to_image");
    if (!editable) continue;
    const required = schemaOf(spec(id), "image_to_image").required ?? [];
    assert(required.includes("source_image_id"), `${id} accepts an edit with nothing to edit`);
  }
  const [video] = generationTools({ jobs, store, conversationId: "c1", video: spec("hosted-video"), uploads: [] });
  const schema = video!.parameters as { required?: string[]; properties: Record<string, unknown> };
  assert("source_image_id" in schema.properties, "the video tool cannot animate a frame");
  assert(!schema.required?.includes("source_image_id"), "a text-to-video call was made to name a frame it does not have");
  return "edits require a base image; a first frame is an offer";
});

await check("no edit tool is offered in front of a backend that cannot edit", () => {
  const drawOnly = generationTools({ jobs, store, conversationId: "c1", image: spec("local"), uploads: [] }).map((tool) => tool.name);
  assert(!drawOnly.includes("edit_image"), `offered ${drawOnly.join(", ")}`);
  const withEditor = generationTools({
    jobs, store, conversationId: "c1", image: spec("local"), edit: spec("hosted-image"), uploads: [],
  }).map((tool) => tool.name);
  assert(withEditor.includes("edit_image"), `only offered ${withEditor.join(", ")}`);
  assert(!drawOnly.includes("generate_video"), "a video tool appeared without a video model");
  return `["${drawOnly.join(", ")}"] then ["${withEditor.join(", ")}"]`;
});

await check("an image uploaded this turn is named in the edit tool's description", () => {
  const [, edit] = generationTools({
    jobs, store, conversationId: "c1", image: spec("hosted-image"), uploads: [{ id: seedImage, mime: "image/png", width: 1, height: 1 }],
  });
  assert(edit!.description.includes(seedImage), "the model was not told the id it has to copy");
  return "the id a blind model cannot see is written into the tool";
});

await check("one video tool covers both starting from text and from a frame", async () => {
  const tools = generationTools({ jobs, store, conversationId: "c1", video: spec("hosted-video"), uploads: [] });
  const tool = tools.find((entry) => entry.name === "generate_video")!;
  const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
  assert("source_image_id" in properties, "an animate-this-image model offers no way to name the image");
  hostedState.videoPolls = hostedState.videoStatus.length - 1;
  const result = (await tool.execute!("call-1", { prompt: "animate it", source_image_id: seedImage }, undefined as never)) as {
    details: { structuredContent: { video_id: string } };
  };
  const job = store.listJobs({ conversationId: "c1" })[0]!;
  assert(job.op === "image_to_video", `the op was ${job.op}`);
  assert(/^vid_/.test(result.details.structuredContent.video_id), "the tool returned no video id");
  return "naming a first frame switches the op, not the tool";
});

await check("the tool hands the model the picture, and the transcript a reference", async () => {
  const tools = generationTools({ jobs, store, conversationId: "c2", image: spec("local"), uploads: [] });
  const tool = tools.find((entry) => entry.name === "generate_image")!;
  const result = (await tool.execute!("call-2", { prompt: "a lantern" }, undefined as never)) as {
    content: Array<{ type: string; data?: string }>;
    details: { structuredContent: { image_id: string } };
  };
  assert(result.content.some((part) => part.type === "image" && (part.data?.length ?? 0) > 0), "the model was not shown the result");
  const { imageRef, videoRef } = await import("../src/server/agent/messages.ts");
  assert(imageRef(result.details.structuredContent), "the structured result does not become an image ref");
  assert(!videoRef(result.details.structuredContent), "an image was mistaken for a video");
  return "base64 for the model, an id for the transcript";
});

await check("a video reference is appended rather than replacing bytes", async () => {
  const { persistMessage, withAppendedRef, videoRef, describeRefs } = await import("../src/server/agent/messages.ts");
  const ref = videoRef({ video_id: `vid_${"a".repeat(32)}`, mime_type: "video/mp4", duration_ms: 5_000 })!;
  const stored = withAppendedRef(
    persistMessage({ role: "toolResult", toolCallId: "call-3", content: [{ type: "text", text: "Rendered" }] }, []),
    ref,
  ) as { content: Array<{ type: string }> };
  assert(stored.content.at(-1)!.type === "video_ref", `content ended with ${stored.content.at(-1)!.type}`);
  assert(stored.content.some((part) => part.type === "text"), "the text was lost");
  const described = describeRefs([stored] as never) as Array<{ content: Array<{ type: string; text?: string }> }>;
  const parts = described[0]!.content;
  assert(!parts.some((part) => part.type === "image"), "a video became an image part");
  assert(parts.at(-1)!.text?.startsWith("[video video_id=vid_"), `the ref read as ${parts.at(-1)!.text}`);
  return `kept as ${parts.map((part) => part.type).join(", ")}`;
});

await check("history names its images instead of guessing which ones to re-upload", async () => {
  const { describeRefs } = await import("../src/server/agent/messages.ts");
  const id = `img_${"b".repeat(32)}`;
  const turns = [
    { role: "assistant", content: [{ type: "image_ref", image_id: id, mime_type: "image/png", width: 1024, height: 1024 }] },
    { role: "user", content: [{ type: "text", text: "把这张图改成夜景" }] },
  ];
  const described = describeRefs(turns as never) as Array<{ content: Array<{ type: string; text?: string }> }>;
  assert(
    !described.flatMap((turn) => turn.content).some((part) => part.type === "image"),
    "a picture entered the context without the model asking",
  );
  assert(
    described[0]!.content[0]!.text === `[image image_id=${id} 1024x1024 image/png]`,
    `the ref read as ${described[0]!.content[0]!.text}`,
  );
  return "an image-shaped request costs nothing until view_image is called";
});

await check("view_image is what puts pixels in front of the model", async () => {
  const { viewImageTool } = await import("../src/server/tools/vision.ts");
  const tool = viewImageTool(store);
  const missing = (await tool.execute!("call-4", { image_id: `img_${"c".repeat(32)}` }, undefined as never)) as {
    content: Array<{ type: string }>;
  };
  assert(!missing.content.some((part) => part.type === "image"), "an unknown id produced an image");

  const generated = generationTools({ jobs, store, conversationId: "c3", image: spec("local"), uploads: [] });
  const made = (await generated
    .find((entry) => entry.name === "generate_image")!
    .execute!("call-5", { prompt: "a lantern" }, undefined as never)) as {
    details: { structuredContent: { image_id: string } };
  };
  const seen = (await tool.execute!("call-6", { image_id: made.details.structuredContent.image_id }, undefined as never)) as {
    content: Array<{ type: string; data?: string; mimeType?: string }>;
  };
  const image = seen.content.find((part) => part.type === "image");
  assert((image?.data?.length ?? 0) > 0, "the model was shown nothing");
  assert(image?.mimeType === "image/jpeg", `the model was sent ${image?.mimeType}`);
  return "a named id resolves, an invented one does not";
});

await check("a deployment with no profiles behaves exactly as before", async () => {
  const { resolveProfile } = await import("../src/server/agent/profile.ts");
  const { Config } = await import("../src/server/config.ts");
  const config = new Config(store, vault);
  const resolved = resolveProfile(store, config, {});
  assert(!resolved.profile, "a conversation without a profile invented one");
  assert(resolved.image?.id === "local", `fell back to ${resolved.image?.id ?? "nothing"}`);
  assert(resolved.edit?.id === "local-edit", `no editor was found: ${resolved.edit?.id ?? "none"}`);
  assert(resolved.prompts.globalPrompt === config.prompts().globalPrompt, "the global prompt changed");
  return "generation still works, prompts unchanged";
});

await check("a model asked for by name gets a tool of its own, and never twice", async () => {
  const { resolveProfile } = await import("../src/server/agent/profile.ts");
  const { Config } = await import("../src/server/config.ts");
  const config = new Config(store, vault);
  const toolsNow = () => {
    const resolved = resolveProfile(store, config, {});
    return generationTools({
      jobs,
      store,
      conversationId: "c3",
      image: resolved.image,
      edit: resolved.edit,
      video: resolved.video,
      extraGeneration: resolved.extraGeneration,
      uploads: [],
    }).map((tool) => tool.name);
  };

  const before = toolsNow();
  assert(before.length === 3, `an unflagged deployment offered ${before.join(", ")}`);

  store.upsertModel({ ...spec("hosted-image"), agentTool: true });
  const named = toolsNow();
  assert(named.includes("generate_image_hosted_image"), `no named draw tool in ${named.join(", ")}`);
  assert(named.includes("edit_image_hosted_image"), `no named edit tool in ${named.join(", ")}`);

  // "local" already carries `generate_image`; asking for it by name as well would
  // hand the model two tools that do one thing.
  store.upsertModel({ ...spec("local"), agentTool: true });
  const both = toolsNow();
  assert(!both.some((name) => name.startsWith("generate_image_local")), `local was offered twice: ${both.join(", ")}`);
  assert(new Set(both).size === both.length, `duplicate tool name in ${both.join(", ")}`);

  store.upsertModel({ ...spec("hosted-image"), agentTool: false });
  store.upsertModel({ ...spec("local"), agentTool: false });
  assert(toolsNow().length === 3, "clearing the flag left a tool behind");
  return `3 by default, ${named.length} once one model is named, and the default model is never doubled`;
});

await check("two profiles in one deployment get different tools", async () => {
  const { resolveProfile } = await import("../src/server/agent/profile.ts");
  const { Config } = await import("../src/server/config.ts");
  const config = new Config(store, vault);
  store.upsertProfile({ id: "draw", name: "画图", chatModelId: "chat", imageModelId: "local", capabilities: { memory: true, files: true, web: true, coding: false, generation: true, skills: true }, mcpServers: [] });
  store.upsertProfile({ id: "write", name: "写作", chatModelId: "chat", capabilities: { memory: true, files: true, web: true, coding: false, generation: false, skills: true }, mcpServers: [] });

  const drawing = resolveProfile(store, config, { profileId: "draw" });
  const writing = resolveProfile(store, config, { profileId: "write" });
  const drawTools = generationTools({ jobs, store, conversationId: "c3", image: drawing.image, edit: drawing.edit, video: drawing.video, uploads: [] });
  const writeTools = generationTools({ jobs, store, conversationId: "c3", image: writing.image, edit: writing.edit, video: writing.video, uploads: [] });
  assert(drawTools.length > 0, "the drawing profile got no generation tools");
  assert(writeTools.length === 0, `the writing profile got ${writeTools.map((tool) => tool.name).join(", ")}`);
  assert(drawing.image!.id === "local", `the drawing profile resolved to ${drawing.image!.id}`);
  return `画图 → ${drawTools.map((tool) => tool.name).join(", ")}; 写作 → none`;
});

await check("a profile only narrows what the deployment configured", async () => {
  const { resolveProfile } = await import("../src/server/agent/profile.ts");
  const { Config } = await import("../src/server/config.ts");
  const config = new Config(store, vault);
  config.saveCapabilities({ web: { ...config.capabilities().web, enabled: false } });
  store.upsertProfile({ id: "all-on", name: "全开", chatModelId: "chat", capabilities: { memory: true, files: true, web: true, coding: true, generation: true, skills: true }, mcpServers: [] });
  const resolved = resolveProfile(store, config, { profileId: "all-on" });
  assert(!resolved.capabilities.web.enabled, "a profile switched on a capability the deployment has not configured");
  return "asking for web where the deployment has none does nothing";
});

await check("discovery suggests a kind, and everything else follows from it", () => {
  const drawing = classifyModel("flux-kontext-pro", "hosted");
  assert(drawing.kind === "image", `an editor was suggested as ${drawing.kind}`);
  assert(drawing.ops.join() === "text_to_image,image_to_image", `an editor suggested ${drawing.ops.join(", ")}`);
  assert(drawing.apiMode === "openai-images", `wrong protocol: ${drawing.apiMode}`);
  assert(!drawing.input.includes("image"), "a generation model claimed image input on the chat side");

  const animator = classifyModel("kling-v2-master", "hosted");
  assert(animator.kind === "video" && animator.ops.includes("image_to_video"), "a first-frame video model lost its op");
  const plain = classifyModel("sora-2", "hosted");
  assert(plain.ops.join() === "text_to_video", `a text-only video model suggested ${plain.ops.join(", ")}`);

  const vision = classifyModel("gemini-2.5-pro", "hosted");
  assert(vision.reasoning && vision.input.includes("image"), "a reasoning vision model lost both flags");

  // An id no pattern knows still has to produce a row the user can correct.
  const unknown = classifyModel("something-shipped-last-tuesday", "hosted");
  assert(unknown.kind === "chat" && !unknown.ops.length, `an unrecognised id became ${unknown.kind}`);

  const venice = classifyModel("lustify-sdxl", "venice", "https://api.venice.ai/api/v1");
  assert(venice.apiMode === "venice-image", `venice got ${venice.apiMode}`);
  return "kind, ops, protocol and input all follow from the id";
});

await check("a row's declared ops are trusted, but not beyond its kind", () => {
  store.upsertModel({ ...spec("hosted-video"), ops: ["text_to_video", "text_to_image"] });
  const ops = opsOf(spec("hosted-video"));
  assert(!ops.includes("text_to_image" as never), `a video model offered ${ops.join(", ")}`);
  assert(supportsOp(spec("hosted-video"), "text_to_video"), "the video op was lost");
  store.upsertModel({ ...spec("hosted-video"), ops: ["text_to_video", "image_to_video"] });
  return "a video row cannot advertise an image op";
});

jobs.close();
db.close();
comfyServer.close();
hostedServer.close();
fs.rmSync(sandbox, { recursive: true, force: true });

console.log(failures ? `\n${failures} generation check(s) failed` : "\nall generation checks passed");
process.exit(failures ? 1 : 0);
