/**
 * Exercises the coding tools directly against a throwaway workspace: path
 * boundaries, atomic multi-file edits, revision conflicts, destructive
 * confirmation and recovery.
 *
 *   node --import tsx scripts/audit-coding.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "luma-coding-"));
const workspace = path.join(sandbox, "project");
const outside = path.join(sandbox, "outside");
fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
// The audit's own trash and journal must not touch the real data directory.
process.env.LUMA_DATA_DIR = path.join(sandbox, "data");

const { codingTools, SHELL_TOOL } = await import("../src/server/tools/coding.ts");
const tools = codingTools({ workspace, read: true, write: true, shell: true });
const byName = new Map(tools.map((tool) => [tool.name, tool]));

const call = async (name: string, args: Record<string, unknown>) => {
  const tool = byName.get(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  const output = await tool.execute("call", args as never);
  return {
    text: output.content.map((part) => ("text" in part ? part.text : "")).join(""),
    details: output.details as Record<string, unknown>,
  };
};

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
async function check(name: string, fn: () => Promise<string>) {
  try {
    results.push({ name, ok: true, detail: await fn() });
    console.log(`PASS ${name} — ${results.at(-1)!.detail}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    console.log(`FAIL ${name} — ${results.at(-1)!.detail}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function rejects(fn: () => Promise<unknown>, match: RegExp, label: string) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(match.test(message), `${label}: wrong error "${message}"`);
    return message;
  }
  throw new Error(`${label}: expected a rejection`);
}

console.log(`workspace ${workspace}\ntools: ${tools.map((tool) => tool.name).join(", ")}\n`);

fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\nexport const shared = 0;\n");
fs.writeFileSync(path.join(workspace, "src", "b.ts"), "export const b = 2;\nexport const shared = 0;\n");
fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET\n");

await check("write and read round-trip reports a revision", async () => {
  await call("write_file", { path: "notes.md", content: "# notes\n" });
  const read = await call("read_file", { path: "notes.md" });
  assert(read.text.includes("# notes"), "content missing");
  assert(typeof read.details.revision === "string", "no revision reported");
  return `revision ${read.details.revision}`;
});

await check("path bounds reject traversal and absolute escapes", async () => {
  const messages = [
    await rejects(() => call("read_file", { path: "../outside/secret.txt" }), /outside/i, "relative traversal"),
    await rejects(() => call("read_file", { path: outside + "/secret.txt" }), /outside/i, "absolute path"),
    await rejects(() => call("write_file", { path: "../escaped.txt", content: "x" }), /outside/i, "write escape"),
    await rejects(() => call("move_path", { from: "notes.md", to: "../escaped.md" }), /outside/i, "move escape"),
  ];
  return `${messages.length} escapes refused`;
});

await check("symlink into the parent directory is refused", async () => {
  try {
    fs.symlinkSync(outside, path.join(workspace, "link"), "junction");
  } catch (error) {
    return `skipped, cannot create link: ${(error as Error).message}`;
  }
  await rejects(() => call("read_file", { path: "link/secret.txt" }), /outside/i, "symlink read");
  fs.rmSync(path.join(workspace, "link"), { recursive: true, force: true });
  return "symlinked path refused";
});

await check("multi-file edit applies atomically", async () => {
  const before = await call("edit_file", {
    edits: [
      { path: "src/a.ts", old_text: "const a = 1", new_text: "const a = 11" },
      { path: "src/b.ts", old_text: "const b = 2", new_text: "const b = 22" },
    ],
  });
  assert(/2 file/.test(before.text), before.text);
  assert(fs.readFileSync(path.join(workspace, "src", "a.ts"), "utf8").includes("a = 11"), "a.ts not written");
  assert(fs.readFileSync(path.join(workspace, "src", "b.ts"), "utf8").includes("b = 22"), "b.ts not written");
  return "both files updated";
});

await check("a failing edit in a batch writes nothing", async () => {
  const snapshot = ["src/a.ts", "src/b.ts"].map((file) => fs.readFileSync(path.join(workspace, file), "utf8"));
  await rejects(
    () =>
      call("edit_file", {
        edits: [
          { path: "src/a.ts", old_text: "const a = 11", new_text: "const a = 111" },
          { path: "src/b.ts", old_text: "TEXT THAT IS NOT THERE", new_text: "x" },
        ],
      }),
    /No match/i,
    "batch with a bad edit",
  );
  const after = ["src/a.ts", "src/b.ts"].map((file) => fs.readFileSync(path.join(workspace, file), "utf8"));
  assert(snapshot[0] === after[0] && snapshot[1] === after[1], "a partial batch was written to disk");
  return "workspace unchanged after the batch failed";
});

await check("ambiguous edit is refused, replace_all accepted", async () => {
  await rejects(
    () => call("edit_file", { path: "src/a.ts", old_text: "export const", new_text: "export let" }),
    /matches/i,
    "ambiguous edit",
  );
  const all = await call("edit_file", {
    path: "src/a.ts",
    old_text: "export const",
    new_text: "export let",
    replace_all: true,
  });
  assert(/2 replacements/.test(all.text), all.text);
  return "ambiguity surfaced, replace_all honoured";
});

await check("stale revision is rejected", async () => {
  const read = await call("read_file", { path: "notes.md" });
  fs.appendFileSync(path.join(workspace, "notes.md"), "changed by someone else\n");
  await rejects(
    () => call("edit_file", { path: "notes.md", old_text: "# notes", new_text: "# renamed", expect_revision: String(read.details.revision) }),
    /changed since you read it/i,
    "stale edit",
  );
  const fresh = await call("read_file", { path: "notes.md" });
  const ok = await call("edit_file", {
    path: "notes.md",
    old_text: "# notes",
    new_text: "# renamed",
    expect_revision: String(fresh.details.revision),
  });
  assert(/Updated/.test(ok.text), ok.text);
  return "conflict detected, retry with a fresh revision accepted";
});

await check("concurrent edits to one file serialise", async () => {
  await call("write_file", { path: "counter.txt", content: "0\n" });
  await Promise.all(
    ["1", "2", "3", "4", "5"].map((value, index) =>
      call("edit_file", { path: "counter.txt", old_text: index === 0 ? "0" : String(index), new_text: value }),
    ),
  );
  const final = fs.readFileSync(path.join(workspace, "counter.txt"), "utf8").trim();
  assert(final === "5", `expected the chain to end at 5, got ${final}`);
  return "five overlapping edits applied in order";
});

await check("rename moves and refuses to clobber", async () => {
  await call("move_path", { from: "src/b.ts", to: "src/renamed.ts" });
  assert(!fs.existsSync(path.join(workspace, "src", "b.ts")), "source still present");
  assert(fs.existsSync(path.join(workspace, "src", "renamed.ts")), "destination missing");
  await rejects(() => call("move_path", { from: "src/a.ts", to: "src/renamed.ts" }), /already exists/i, "clobber");
  const forced = await call("move_path", { from: "src/a.ts", to: "src/renamed.ts", overwrite: true });
  assert(/Moved/.test(forced.text), forced.text);
  return "renamed, clobber refused, overwrite honoured";
});

await check("delete stays recoverable, and cannot be self-confirmed", async () => {
  await call("write_file", { path: "doomed.txt", content: "important\n" });
  // Authorisation is not the tool's job any more. It used to demand
  // `confirm: true`, which the model simply passed — the same reasoning that
  // chose the delete also approved it. The gate in agent/approvals.ts holds the
  // call for a person instead, so the schema must not offer a way to opt out.
  const schema = (tools.find((tool) => tool.name === "delete_path")!.parameters ?? {}) as {
    properties?: Record<string, unknown>;
  };
  assert(!schema.properties?.confirm, "delete_path still lets the model confirm to itself");

  const removed = await call("delete_path", { path: "doomed.txt" });
  assert(!fs.existsSync(path.join(workspace, "doomed.txt")), "file survived the delete");
  const backup = String(removed.details.backup);
  assert(backup && backup !== "null", "no backup recorded");

  const listing = await call("restore_file", {});
  assert(listing.text.includes(backup), `backup not listed: ${listing.text.slice(0, 200)}`);
  await call("restore_file", { backup });
  assert(
    fs.readFileSync(path.join(workspace, "doomed.txt"), "utf8") === "important\n",
    "restored content does not match",
  );
  return `deleted and restored via ${backup}`;
});

await check("directory delete needs recursive and refuses the root", async () => {
  fs.mkdirSync(path.join(workspace, "tree", "deep"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "tree", "deep", "x.txt"), "x");
  await rejects(() => call("delete_path", { path: "tree" }), /recursive/i, "non-recursive");
  await rejects(() => call("delete_path", { path: ".", recursive: true }), /workspace root/i, "root");
  const gone = await call("delete_path", { path: "tree", recursive: true });
  assert(!fs.existsSync(path.join(workspace, "tree")), "tree survived");
  return gone.text;
});

await check("grep finds matches and survives without ripgrep", async () => {
  const found = await call("grep_search", { query: "export let" });
  assert(/renamed\.ts|a\.ts/.test(found.text), `no hits: ${found.text.slice(0, 200)}`);

  // Force the fallback by hiding ripgrep from PATH for this call only.
  const realPath = process.env.PATH;
  process.env.PATH = path.join(sandbox, "empty-path");
  try {
    const fallback = await call("grep_search", { query: "export let" });
    assert(fallback.details.engine === "fallback", `engine was ${String(fallback.details.engine)}`);
    assert(/export let/.test(fallback.text), `fallback found nothing: ${fallback.text.slice(0, 200)}`);
  } finally {
    process.env.PATH = realPath;
  }
  return "ripgrep path and fallback path both return hits";
});

await check("failing command reports its output", async () => {
  const ok = await call(SHELL_TOOL, { command: "echo luma-ok" });
  assert(/luma-ok/.test(ok.text), ok.text);
  const node = await call(SHELL_TOOL, { command: "node --version" });
  assert(/^v2[4-9]\./m.test(node.text), `bundled Node is not reachable: ${node.text}`);
  // One shell language on every host is the point of borrowing pi's tool: this
  // is the same command on Windows as it is anywhere else.
  const message = await rejects(
    () => call(SHELL_TOOL, { command: "echo boom >&2; exit 3" }),
    /exited with code 3/,
    "non-zero exit",
  );
  assert(/boom/.test(message), `stderr not surfaced: ${message}`);
  return "bundled Node, exit code and stderr all reach the model";
});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.rmSync(sandbox, { recursive: true, force: true });
if (failed.length) process.exit(1);
