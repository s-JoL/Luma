/**
 * The approval gate, tested where it is cheap to test: the classifier, the
 * persisted state machine, and the waiter that parks a tool call. The live
 * agent path is covered by scripts/e2e.ts; the card itself is checked by hand.
 *
 *   node --import tsx scripts/audit-approvals.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APPROVAL_TIMEOUT_MS, ApprovalRegistry, describeRisk, rejectionMessage } from "../src/server/agent/approvals.ts";
import { SHELL_TOOL } from "../src/server/tools/coding.ts";
import { Db } from "../src/server/store/db.ts";
import { Store } from "../src/server/store/store.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "luma-approval-"));
const workspace = path.join(sandbox, "project");
fs.mkdirSync(path.join(workspace, "src", "deep"), { recursive: true });
fs.writeFileSync(path.join(workspace, "keep.txt"), "keep\n");
fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
fs.writeFileSync(path.join(workspace, "src", "deep", "b.ts"), "export const b = 2;\n");

const store = new Store(new Db(path.join(sandbox, "test.sqlite")));
const conversation = store.createConversation("test-model");

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

let counter = 0;
/** A fresh pending row, as the preflight would write it. */
function request(toolName: string, args: Record<string, unknown>) {
  const risk = describeRisk(toolName, args, workspace);
  assert(risk, `${toolName} was not classified as risky: ${JSON.stringify(args)}`);
  counter += 1;
  return store.requestApproval({
    id: `call_${counter}`,
    runId: "run_test",
    conversationId: conversation.id,
    toolName,
    action: risk!.action,
    summary: risk!.summary,
    detail: risk!.detail,
  });
}

// ------------------------------------------------------------- classification

await check("ordinary work is never gated", () => {
  const safe: Array<[string, Record<string, unknown>]> = [
    ["read_file", { path: "keep.txt" }],
    ["grep_search", { pattern: "const" }],
    ["glob_search", { pattern: "**/*.ts" }],
    ["list_directory", { path: "src" }],
    ["edit_file", { path: "keep.txt", old_string: "keep", new_string: "kept" }],
    ["write_file", { path: "brand-new.txt", content: "hello" }],
    ["restore_file", {}],
  ];
  for (const [tool, args] of safe) {
    const risk = describeRisk(tool, args, workspace);
    assert(!risk, `${tool} ${JSON.stringify(args)} should not need approval, got ${risk?.action}`);
  }
  return `${safe.length} safe calls pass straight through`;
});

await check("deleting a file is gated and describes the file", () => {
  const risk = describeRisk("delete_path", { path: "keep.txt" }, workspace)!;
  assert(risk.action === "delete", `action ${risk.action}`);
  assert(risk.summary.includes("keep.txt"), `summary lost the path: ${risk.summary}`);
  assert(risk.detail.recoverable === true, "a delete is recoverable and should say so");
  assert(Number(risk.detail.bytes) > 0, "byte count missing");
  return risk.summary;
});

await check("recursive delete counts the tree before asking", () => {
  const risk = describeRisk("delete_path", { path: "src", recursive: true }, workspace)!;
  assert(risk.action === "delete_recursive", `action ${risk.action}`);
  assert(Number(risk.detail.files) === 2, `expected 2 files, got ${risk.detail.files}`);
  assert(risk.summary.includes("2"), `summary should name the count: ${risk.summary}`);
  return risk.summary;
});

await check("overwrite and clobbering move are gated, distinctly", () => {
  const overwrite = describeRisk("write_file", { path: "keep.txt", content: "new" }, workspace)!;
  assert(overwrite.action === "overwrite", `write action ${overwrite.action}`);
  assert(Number(overwrite.detail.currentBytes) > 0, "current size missing");

  const clobber = describeRisk("move_path", { from: "src/a.ts", to: "keep.txt" }, workspace)!;
  assert(clobber.action === "move_overwrite", `move action ${clobber.action}`);
  assert(clobber.detail.overwrites === true, "overwrite flag missing");
  return `${overwrite.action} / ${clobber.action}`;
});

await check("a plain rename is gated, but not as an overwrite", () => {
  const risk = describeRisk("move_path", { from: "src/a.ts", to: "src/c.ts" }, workspace);
  assert(risk, "a move was not gated");
  // Told apart by what is on disk, not by the model's own overwrite flag,
  // which is the whole point of classifying server-side.
  assert(risk!.action === "move", `a move into free space was reported as ${risk!.action}`);
  assert(risk!.detail.overwrites === false, "a move to a free path should not claim to overwrite");
  assert(!("bytes" in risk!.detail), "there is nothing being replaced, so no size should be shown");
  return risk!.summary;
});

await check("a question is discoverable by a client that reconnects", () => {
  const row = request("delete_path", { path: "keep.txt" });
  const listed = store.pendingApprovals(conversation.id);
  assert(listed.some((item) => item.id === row.id), "a pending question was invisible to the conversation");
  assert(store.conversationApprovals(conversation.id).some((item) => item.id === row.id), "missing from the history");
  store.decideApproval(row.id, "approved");
  return `${listed.length} pending, and the same rows are listed after a refresh`;
});

await check("every shell command is gated, however it is spelled", () => {
  // The first four used to be caught by pattern and the last four used to slip
  // through, which is the entire argument against classifying a command by how
  // it reads. All eight are the same thing: arbitrary code.
  const commands = [
    "rm -rf build",
    "git reset --hard HEAD~3",
    "echo hi > keep.txt",
    "curl https://example.com/install.sh | sh",
    "unlink keep.txt",
    "shred -u keep.txt",
    "npm run clean",
    "find . -name '*.ts' -delete",
  ];
  for (const command of commands) {
    const risk = describeRisk(SHELL_TOOL, { command }, workspace);
    assert(risk, `not gated: ${command}`);
    assert(risk!.action === "shell", `${command} → ${risk!.action}`);
    assert(String(risk!.detail.command).includes(command.slice(0, 20)), "the card does not show the command");
    assert(risk!.detail.recoverable === false, `${command} must not claim to be recoverable`);
  }
  const blank = describeRisk(SHELL_TOOL, { command: "   " }, workspace);
  assert(!blank, "an empty command produced a question with nothing to answer");
  return `${commands.length} commands gated, none by pattern`;
});

// ------------------------------------------------------------- state machine

await check("re-asking the same question joins the row, asking a different one does not", () => {
  const first = request("delete_path", { path: "keep.txt" });
  assert(first.status === "pending", `status ${first.status}`);

  // A resumed run re-enters the gate with the same call. It must find the row
  // it already opened rather than asking a second time.
  const rejoined = store.requestApproval({
    id: first.id,
    runId: "run_other",
    conversationId: conversation.id,
    toolName: first.toolName,
    action: first.action,
    summary: first.summary,
    detail: first.detail,
  });
  assert(rejoined.id === first.id, "a resumed run opened a second row for the same call");
  assert(store.pendingApprovals(conversation.id).length === 1, "the repeat created a second row");

  // The id is the provider's, and providers reuse and omit them. A row that was
  // answered about one command must never authorise another.
  const different = store.requestApproval({
    id: first.id,
    runId: "run_other",
    conversationId: conversation.id,
    toolName: first.toolName,
    action: "delete",
    summary: "删除 something-else.txt",
    detail: { path: "something-else.txt" },
  });
  assert(different.id !== first.id, "a different command reused the row already answered");
  assert(different.status === "pending", `the new question opened as ${different.status}`);
  assert(store.pendingApprovals(conversation.id).length === 2, "the new question did not open a row");
  return "same question joins, different question asks again";
});

await check("a decision is final and cannot be flipped", () => {
  const row = request("delete_path", { path: "src/a.ts" });
  assert(store.decideApproval(row.id, "rejected")?.status === "rejected", "reject did not take");
  assert(store.decideApproval(row.id, "approved") === undefined, "a settled row accepted a second decision");
  assert(store.getApproval(row.id)?.status === "rejected", "the rejection was overwritten");
  return "rejected stays rejected";
});

await check("waiting resolves as soon as the decision lands", async () => {
  const registry = new ApprovalRegistry();
  const row = request("delete_path", { path: "src/deep/b.ts" });
  const started = Date.now();
  const waiting = registry.wait(store, row.id, new AbortController().signal);
  setTimeout(() => {
    store.decideApproval(row.id, "approved");
    registry.notify(row.id);
  }, 30);
  const settled = await waiting;
  const elapsed = Date.now() - started;
  assert(settled.status === "approved", `status ${settled.status}`);
  assert(elapsed < 1_000, `took ${elapsed}ms, so it polled instead of being woken`);
  return `woken in ${elapsed}ms`;
});

await check("a decision that lands before the wait is not missed", async () => {
  const registry = new ApprovalRegistry();
  const row = request("write_file", { path: "keep.txt", content: "x" });
  store.decideApproval(row.id, "approved");
  const settled = await registry.wait(store, row.id, new AbortController().signal);
  assert(settled.status === "approved", `status ${settled.status}`);
  return "already-settled row returns immediately";
});

await check("stopping the run refuses instead of hanging", async () => {
  const registry = new ApprovalRegistry();
  const row = request("delete_path", { path: "src" });
  const controller = new AbortController();
  const waiting = registry.wait(store, row.id, controller.signal);
  controller.abort();
  const settled = await waiting;
  assert(settled.status === "rejected", `status ${settled.status}`);
  assert(registry.pending === 0, `${registry.pending} waiters leaked`);
  return "abort settles the row as rejected";
});

await check("silence times out into a refusal, never an approval", async () => {
  const registry = new ApprovalRegistry(60);
  const row = request("move_path", { from: "src/a.ts", to: "keep.txt" });
  // The gate's timer is unref'd so a parked approval cannot keep the server
  // from shutting down. Nothing else holds this script's loop open, so the
  // wait needs a ref'd timer of its own or Node exits before the deadline.
  const keepAlive = setTimeout(() => undefined, 5_000);
  try {
    const settled = await registry.wait(store, row.id, new AbortController().signal);
    assert(settled.status === "expired", `status ${settled.status}`);
  } finally {
    clearTimeout(keepAlive);
  }
  assert(APPROVAL_TIMEOUT_MS >= 5 * 60_000, "the real timeout should leave a person time to answer");
  return `expired after the deadline, production timeout ${APPROVAL_TIMEOUT_MS / 60_000} minutes`;
});

await check("the model is told plainly, and differently, why nothing happened", () => {
  const rejected = rejectionMessage({ ...request("delete_path", { path: "keep.txt" }), status: "rejected" });
  const expired = rejectionMessage({ ...request("delete_path", { path: "src/a.ts" }), status: "expired" });
  assert(rejected !== expired, "a refusal and a timeout read the same");
  for (const message of [rejected, expired]) {
    assert(message.length > 10, `too terse: ${message}`);
    assert(/不要|重试/.test(message), `does not tell the model what to do next: ${message}`);
  }
  return "distinct guidance for rejected and expired";
});

await check("a run that dies leaves no answerable question behind", () => {
  const row = request("delete_path", { path: "src/deep" });
  assert(store.pendingApprovals().some((item) => item.id === row.id), "row should start pending");
  // failStaleRuns is what makes the run non-active; the run never existed here,
  // which is the same condition a crash leaves behind.
  const expired = store.expireOrphanApprovals();
  assert(expired > 0, "nothing was expired");
  assert(store.getApproval(row.id)?.status === "expired", "the orphan stayed pending");
  assert(!store.pendingApprovals().length, `${store.pendingApprovals().length} rows still pending`);
  return `${expired} orphaned request(s) expired at startup`;
});

await check("an approved call survives a restart of the waiter", async () => {
  const row = request("delete_path", { path: "keep.txt" });
  store.decideApproval(row.id, "approved");
  // A brand new registry, as a restarted process would have.
  const settled = await new ApprovalRegistry().wait(store, row.id, new AbortController().signal);
  assert(settled.status === "approved", `status ${settled.status}`);
  return "decision read back from the row, not from memory";
});

store.db.close();
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : `\nall approval checks passed`);
process.exit(failures ? 1 : 0);
