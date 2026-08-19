/**
 * The generation layer against the real backends, which is the only place the
 * fakes in `audit-generation.ts` cannot reach: a wire shape a provider actually
 * accepts, and which model each agent tool is really bound to.
 *
 *   node --import tsx scripts/verify-generation-live.ts            # free: seed and report
 *   node --import tsx scripts/verify-generation-live.ts --draw     # one hosted image
 *   node --import tsx scripts/verify-generation-live.ts --edit     # one hosted edit
 *   node --import tsx scripts/verify-generation-live.ts --video    # one hosted clip
 *
 * The rendering flags cost real money, one render each, which is why reporting
 * is the default and every render is asked for by name.
 */
import fs from "node:fs";
import path from "node:path";

const { paths, ensureDirectories } = await import("../src/server/env.ts");
const { Db } = await import("../src/server/store/db.ts");
const { Store } = await import("../src/server/store/store.ts");
const { SecretVault, loadMasterKey } = await import("../src/server/crypto/secrets.ts");
const { Config } = await import("../src/server/config.ts");
const { seed } = await import("../src/server/store/seed.ts");
const { Jobs } = await import("../src/server/generation/jobs.ts");
const { schemaOf, opsOf, forModel } = await import("../src/server/generation/index.ts");
const { resolveProfile } = await import("../src/server/agent/profile.ts");
const { saveImageBytes } = await import("../src/server/images.ts");

ensureDirectories();
const db = new Db(paths.db);
const store = new Store(db);
const vault = new SecretVault(store, loadMasterKey(paths.masterKey));
const config = new Config(store, vault);

console.log(seed(store, config, vault) ? "seed: applied" : "seed: already current");

/* ── what the agent is actually bound to ─────────────────────────────────── */

const resolved = resolveProfile(store, config, {});
console.log("\nagent tool bindings");
for (const [role, spec] of [
  ["generate_image", resolved.image],
  ["edit_image", resolved.edit],
  ["generate_video", resolved.video],
] as const) {
  console.log(`  ${role.padEnd(15)} ${spec ? `${spec.name}  (${spec.id}, ${spec.apiMode})` : "— nothing bound"}`);
}
console.log(`  profile         ${resolved.profile?.name ?? "— none, falling back to sort order"}`);

console.log("\ngeneration models and the parameters each one offers  (* studio only, never sent to the model)");
for (const spec of store.listModels().filter((entry) => entry.kind === "image" || entry.kind === "video")) {
  console.log(`  ${spec.name}  (${spec.id}) ${spec.enabled ? "" : "[disabled] "}${spec.apiMode}`);
  for (const op of opsOf(spec)) {
    const schema = schemaOf(spec, op);
    const fields = Object.entries(schema.properties ?? {}).map(([name, field]) => {
      const options = field.enum?.length ? `=${field.enum.slice(0, 3).join("|")}${field.enum.length > 3 ? "…" : ""}` : "";
      return `${name}${options}${field.audience === "studio" ? "*" : ""}`;
    });
    const offered = Object.keys(forModel(schema).properties ?? {}).length;
    console.log(`      ${op}: ${fields.join(", ")}`);
    console.log(`        ${offered} of ${fields.length} reach the model, plus intent`);
  }
}

/* ── real renders, each one asked for by name ─────────────────────────────── */

const jobs = new Jobs(store, vault);
const outDir = path.join(paths.root, "probe-out");
fs.mkdirSync(outDir, { recursive: true });

async function render(label: string, request: Parameters<typeof jobs.run>[0]) {
  process.stdout.write(`\n── ${label}\n`);
  const started = Date.now();
  const job = await jobs.run(request);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (job.status !== "succeeded") {
    console.log(`   ${job.status.toUpperCase()} after ${seconds}s: ${job.error}`);
    return undefined;
  }
  for (const asset of job.assets) {
    const file = store.getFile(asset.assetId);
    const bytes = file ? fs.statSync(file.diskPath).size : 0;
    console.log(`   OK in ${seconds}s: ${asset.assetId} ${asset.width}x${asset.height} ${asset.kind} ${bytes} bytes`);
    if (file) {
      const copy = path.join(outDir, `live-${label.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}${path.extname(file.diskPath)}`);
      fs.copyFileSync(file.diskPath, copy);
      console.log(`   copied to ${path.relative(paths.root, copy)}`);
    }
  }
  return job.assets[0]?.assetId;
}

const wants = (flag: string) => process.argv.includes(flag);
/** `--image=<modelId>` renders through a named row instead of the bound one. */
const named = (flag: string) =>
  process.argv.find((argument) => argument.startsWith(`${flag}=`))?.split("=", 2)[1];
const rowFor = (flag: string, fallback: typeof resolved.image) => {
  const id = named(flag);
  if (!id) return fallback;
  const spec = store.getModel(id);
  if (!spec) throw new Error(`no model row ${id}`);
  return spec;
};

let drawn: string | undefined;

if (wants("--draw")) {
  const spec = rowFor("--image", resolved.image);
  if (!spec) console.log("\n── draw skipped: nothing bound");
  else
    drawn = await render(`draw via ${spec.apiMode}`, {
      modelId: spec.id,
      params: {
        prompt: "A single ripe persimmon on a bare concrete ledge, overcast daylight, no text.",
        ...(spec.apiMode === "openai-images" ? { size: "2736x1536" } : {}),
      },
    });
}

if (wants("--edit") && resolved.edit) {
  // Two references through one call, which is the claim the system prompt makes
  // and the thing a single-image edit route silently cannot honour.
  const { default: sharp } = await import("sharp");
  const swatch = async (r: number, g: number, b: number) =>
    saveImageBytes(
      store,
      await sharp({ create: { width: 512, height: 288, channels: 3, background: { r, g, b } } }).png().toBuffer(),
      { mime: "image/png", provider: "verify", model: "fixture" },
    );
  const first = drawn ?? (await swatch(220, 40, 40));
  const second = await swatch(40, 60, 220);
  await render("edit with two references", {
    modelId: resolved.edit.id,
    op: "image_to_image",
    params: {
      prompt: "Place the subject of [Image 1] on the flat colour field of [Image 2]. Keep the subject recognisable.",
      source_image_id: first,
      additional_source_image_ids: [second],
    },
  });
}

if (wants("--video") && resolved.video) {
  await render("video", {
    modelId: resolved.video.id,
    params: {
      prompt: "A slow push-in on a ripe persimmon resting on a concrete ledge, overcast daylight.",
      duration: 4,
      size: "854x480",
    },
  });
}

jobs.close();
db.close();
