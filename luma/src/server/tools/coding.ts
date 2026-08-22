import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  createBashTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";
import type { CodingCapability } from "@shared/types.ts";
import { paths } from "../env.ts";
import { INTENT_DESCRIPTION } from "./descriptions.ts";

/** Named once, because the approval gate has to hold exactly this tool. */
export const SHELL_TOOL = "bash_tool";

const execFileAsync = promisify(execFile);
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".luma-trash"]);

/** Guards against a model deleting or rewriting a tree by accident. */
const MAX_DELETE_ENTRIES = 200;

/**
 * Confines a path to the workspace. Resolving the nearest existing ancestor
 * through `realpath` first is what closes the symlink hole: `path.relative`
 * alone happily accepts `link/../../etc` when `link` points outside.
 */
function safePath(workspace: string, requested = ".") {
  const target = path.resolve(workspace, requested);
  let probe = target;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);

  let resolved = target;
  let root = workspace;
  try {
    // Plain `realpathSync`, not `.native`. The native binding is the one path
    // API here whose answer is a property of the host: it folds case on macOS
    // but not on Linux, rewrites the drive letter on Windows, and throws EPERM
    // on a network mount — where the catch below silently downgrades this to a
    // lexical check that no longer sees through a symlink. Both sides are
    // resolved together, so a failure on the second call leaves the comparison
    // lexical on both rather than measuring a resolved root against an
    // unresolved target.
    const realTarget = path.join(fs.realpathSync(probe), path.relative(probe, target));
    root = fs.realpathSync(workspace);
    resolved = realTarget;
  } catch {
    // A path that cannot be resolved is checked lexically, which is still safe.
  }

  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the configured coding workspace: ${requested}`);
  }
  return resolved;
}

const result = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const intent = { intent: { type: "string", description: INTENT_DESCRIPTION } };

/** Short content hash a caller quotes back to prove it edited what it read. */
const revisionOf = (content: string) => createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);

function readRevision(file: string) {
  try {
    return revisionOf(fs.readFileSync(file, "utf8"));
  } catch {
    return "absent";
  }
}

function checkRevision(file: string, expected: string | undefined, relative: string) {
  if (!expected) return;
  const actual = readRevision(file);
  if (actual !== expected) {
    throw new Error(
      `${relative} changed since you read it (revision ${actual}, you expected ${expected}). Read it again before editing.`,
    );
  }
}

/**
 * Serialises writes per file. Two tool calls in one batch can target the same
 * path, and a half-applied pair of edits is far worse than a slow one.
 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort();
  const previous = Promise.all(ordered.map((key) => locks.get(key) ?? Promise.resolve()));
  const next = previous.then(fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  for (const key of ordered) locks.set(key, settled);
  return next;
}

/**
 * Every destructive change copies the previous bytes here first, so a wrong
 * edit is recoverable inside the same conversation instead of being final.
 * It lives beside the database rather than in the workspace, where it would
 * show up in the model's own searches and in the user's version control.
 */
function trashDir() {
  const dir = path.join(paths.data, "coding-trash");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function archive(workspace: string, file: string, reason: string) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const relative = path.relative(workspace, file);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const target = path.join(trashDir(), `${stamp}__${relative.replace(/[\\/]/g, "~")}`);
  fs.copyFileSync(file, target);
  fs.appendFileSync(
    path.join(trashDir(), "journal.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), reason, path: relative, backup: path.basename(target) })}\n`,
    "utf8",
  );
  return path.basename(target);
}

/**
 * Filesystem and shell access for the coding agent. Every tool is off by
 * default and every path is confined to the configured workspace.
 */
function resolveWorkspace(requested: string) {
  const workspace = path.resolve(requested);
  try {
    // macOS presents /var as a symlink to /private/var. safePath already
    // realpath's every target, so the workspace root used for confinement and
    // the "do not delete ." check has to be the same path, or deleting `.`
    // looks like a subdirectory and wipes the project.
    return fs.realpathSync(workspace);
  } catch {
    return workspace;
  }
}

export function codingTools(config: CodingCapability): AgentTool[] {
  const tools: AgentTool[] = [];
  const workspace = resolveWorkspace(config.workspace);
  const show = (file: string) => path.relative(workspace, file) || ".";

  if (config.read) {
    tools.push({
      name: "read_file",
      label: "Read file",
      description:
        `Read a UTF-8 text file inside ${workspace}. ` +
        "The reported revision is the token to pass as expect_revision when editing.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          ...intent,
          path: { type: "string" },
          start_line: { type: "number", minimum: 1 },
          max_lines: { type: "number", minimum: 1, maximum: DEFAULT_MAX_LINES },
        },
        required: ["path"],
      }),
      execute: async (_callId, params) => {
        const args = params as { path: string; start_line?: number; max_lines?: number };
        const file = safePath(workspace, args.path);
        const content = fs.readFileSync(file, "utf8");
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, args.start_line ?? 1);
        const max = Math.min(DEFAULT_MAX_LINES, args.max_lines ?? DEFAULT_MAX_LINES);
        const numbered = lines
          .slice(start - 1, start - 1 + max)
          .map((line, index) => `${start + index}: ${line}`)
          .join("\n");
        // pi's dual limit, because a line count alone does not bound a read: a
        // 2000-line slice of minified source is megabytes. The continuation hint
        // is what makes the cut recoverable — without it the model has to guess
        // whether there is more, and asking for the same range again is all it
        // can do. `outputLines` is floored at one so the hint always advances.
        const bounded = truncateHead(numbered, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        const reason = bounded.truncatedBy === "lines" ? `${bounded.maxLines} lines` : formatSize(bounded.maxBytes);
        const body = bounded.truncated
          ? `${bounded.content}\n…[truncated at ${reason}; continue with start_line=${
              start + Math.max(1, bounded.outputLines)
            }]`
          : bounded.content;
        const revision = revisionOf(content);
        return result(`revision ${revision} · ${lines.length} lines\n${body}`, {
          path: show(file),
          totalLines: lines.length,
          revision,
        });
      },
    });

    tools.push({
      name: "glob_search",
      label: "Find files",
      description: "List files by name fragment inside the coding workspace.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          ...intent,
          query: { type: "string" },
          path: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 500 },
        },
        required: [],
      }),
      execute: async (_callId, params) => {
        const args = params as { query?: string; path?: string; limit?: number };
        const base = safePath(workspace, args.path ?? ".");
        const query = String(args.query ?? "").toLowerCase();
        const limit = args.limit ?? 200;
        const found: string[] = [];
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (found.length >= limit || SKIP_DIRECTORIES.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (!query || entry.name.toLowerCase().includes(query)) {
              found.push(path.relative(workspace, full));
            }
          }
        };
        walk(base);
        return result(found.join("\n") || "No files found", { count: found.length, workspace });
      },
    });

    tools.push({
      name: "grep_search",
      label: "Search code",
      description: "Search file contents inside the coding workspace.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          ...intent,
          query: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          limit: { type: "number", minimum: 1, maximum: 300 },
        },
        required: ["query"],
      }),
      // Both engines cut a match line at pi's grep width and say so. A bare
      // slice left the model unable to tell a cut line from a short one, and one
      // minified match could otherwise fill the whole tool result on its own.
      execute: async (_callId, params) => {
        const args = params as { query: string; path?: string; glob?: string; limit?: number };
        const base = safePath(workspace, args.path ?? ".");
        const limit = args.limit ?? 100;
        const commandArgs = ["-n", "--no-heading", "--color", "never", "--max-count", String(limit)];
        if (args.glob) commandArgs.push("-g", args.glob);
        commandArgs.push(args.query, base);
        try {
          const { stdout } = await execFileAsync("rg", commandArgs, {
            cwd: workspace,
            timeout: 30_000,
            maxBuffer: 2_000_000,
          });
          const bounded = stdout.trim().split("\n").map((line) => truncateLine(line).text);
          return result(bounded.join("\n") || "No matches", { workspace, engine: "ripgrep" });
        } catch (error) {
          const code = (error as { code?: number | string }).code;
          if (code === 1) return result("No matches", { workspace, engine: "ripgrep" });
          // A spawn that never happened is not a search that failed: ripgrep may
          // be absent (ENOENT), or be a `.cmd` shim Node refuses to launch
          // without a shell (EINVAL) — and a shell here would hand the model's
          // query to the interpreter as syntax. Both degrade to the internal
          // scan; a numeric exit code means ripgrep ran and objected, which the
          // model needs to be told about.
          if (typeof code !== "string") throw error;
          const hits = scanForMatches(base, workspace, args.query, args.glob, limit);
          return result(hits.join("\n") || "No matches", { workspace, engine: "fallback" });
        }
      },
    });

    tools.push({
      name: "list_directory",
      label: "List directory",
      description: "List the immediate entries of a directory inside the coding workspace.",
      parameters: Type.Unsafe({
        type: "object",
        properties: { ...intent, path: { type: "string" } },
        required: [],
      }),
      execute: async (_callId, params) => {
        const args = params as { path?: string };
        const dir = safePath(workspace, args.path ?? ".");
        const entries = fs
          .readdirSync(dir, { withFileTypes: true })
          .map((entry) => `${entry.isDirectory() ? "dir " : "file"}  ${entry.name}`)
          .sort();
        return result(entries.join("\n") || "(empty)", { path: show(dir), count: entries.length });
      },
    });
  }

  if (config.write) {
    tools.push({
      name: "edit_file",
      label: "Edit file",
      description:
        "Apply exact text replacements. Pass `edits` to change several files in one atomic step: every " +
        "edit is validated before anything is written, so a bad match leaves the workspace untouched. " +
        "Read each file first and pass its revision as expect_revision to be told about a concurrent change.",
      executionMode: "sequential",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          ...intent,
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          expect_revision: { type: "string" },
          replace_all: { type: "boolean" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                old_text: { type: "string" },
                new_text: { type: "string" },
                expect_revision: { type: "string" },
                replace_all: { type: "boolean" },
              },
              required: ["path", "old_text", "new_text"],
            },
          },
        },
        required: [],
      }),
      execute: async (_callId, params) => {
        const args = params as Edit & { edits?: Edit[] };
        const edits = args.edits?.length ? args.edits : [args];
        if (!edits.length || edits.some((edit) => !edit?.path || edit.old_text === undefined)) {
          throw new Error("Provide either path/old_text/new_text or a non-empty edits array");
        }

        const files = edits.map((edit) => safePath(workspace, edit.path));
        return withLock(files, async () => {
          // Stage every file in memory first so a failure in the last edit
          // cannot leave the earlier ones applied.
          const staged = new Map<string, string>();
          const applied: string[] = [];
          for (const [index, edit] of edits.entries()) {
            const file = files[index]!;
            const relative = show(file);
            checkRevision(file, edit.expect_revision, relative);
            const before = staged.get(file) ?? fs.readFileSync(file, "utf8");
            const count = before.split(edit.old_text).length - 1;
            if (count === 0) throw new Error(`No match for the old_text in ${relative}`);
            if (count > 1 && !edit.replace_all) {
              throw new Error(`${count} matches in ${relative}; pass replace_all or include more context`);
            }
            staged.set(file, edit.replace_all ? before.split(edit.old_text).join(edit.new_text) : before.replace(edit.old_text, edit.new_text));
            applied.push(`${relative} (${count} replacement${count > 1 ? "s" : ""})`);
          }

          const revisions: Record<string, string> = {};
          for (const [file, content] of staged) {
            archive(workspace, file, "edit_file");
            fs.writeFileSync(file, content, "utf8");
            revisions[show(file)] = revisionOf(content);
          }
          return result(`Updated ${staged.size} file(s):\n${applied.join("\n")}`, { revisions, changed: true });
        });
      },
    });

    tools.push({
      name: "write_file",
      label: "Write file",
      description:
        "Create or overwrite a UTF-8 file inside the coding workspace. Overwriting an existing file keeps a " +
        "recoverable copy; pass expect_revision to be told if it changed since you read it.",
      executionMode: "sequential",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          ...intent,
          path: { type: "string" },
          content: { type: "string" },
          expect_revision: { type: "string" },
        },
        required: ["path", "content"],
      }),
      execute: async (_callId, params) => {
        const args = params as { path: string; content: string; expect_revision?: string };
        const file = safePath(workspace, args.path);
        return withLock([file], async () => {
          checkRevision(file, args.expect_revision, show(file));
          const backup = archive(workspace, file, "write_file");
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, args.content, "utf8");
          return result(`Wrote ${show(file)}${backup ? `. Previous version: restore_file backup=${backup}` : ""}`, {
            bytes: Buffer.byteLength(args.content),
            revision: revisionOf(args.content),
            backup,
          });
        });
      },
    });

    tools.push({
      name: "move_path",
      label: "Rename or move",
      description:
        "Rename or move a file or directory inside the coding workspace. Refuses to clobber an existing " +
        "destination unless overwrite is set.",
      executionMode: "sequential",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          ...intent,
          from: { type: "string" },
          to: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["from", "to"],
      }),
      execute: async (_callId, params) => {
        const args = params as { from: string; to: string; overwrite?: boolean };
        const from = safePath(workspace, args.from);
        const to = safePath(workspace, args.to);
        return withLock([from, to], async () => {
          if (!fs.existsSync(from)) throw new Error(`${show(from)} does not exist`);
          if (from === to) throw new Error("Source and destination are the same path");
          if (fs.existsSync(to)) {
            if (!args.overwrite) throw new Error(`${show(to)} already exists; pass overwrite to replace it`);
            archive(workspace, to, "move_path overwrite");
          }
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.renameSync(from, to);
          return result(`Moved ${show(from)} → ${show(to)}`, { from: show(from), to: show(to) });
        });
      },
    });

    tools.push({
      name: "delete_path",
      label: "Delete",
      description:
        "Delete a file, or a directory with recursive set. A person is asked to approve the deletion before " +
        "it runs, and deleted files are copied aside first and can be restored with restore_file.",
      executionMode: "sequential",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          ...intent,
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
      }),
      execute: async (_callId, params) => {
        const args = params as { path: string; recursive?: boolean };
        const target = safePath(workspace, args.path);
        if (target === path.resolve(workspace)) throw new Error("Refusing to delete the workspace root");
        if (!fs.existsSync(target)) throw new Error(`${show(target)} does not exist`);

        return withLock([target], async () => {
          const stat = fs.statSync(target);
          if (!stat.isDirectory()) {
            const backup = archive(workspace, target, "delete_path");
            fs.rmSync(target);
            // The id goes in the text, not only in the details: the model reads
            // the text, and without it undoing this needs a listing call first.
            return result(
              `Deleted ${show(target)}${backup ? `. Restore it with restore_file backup=${backup}` : ""}`,
              { backup, entries: 1 },
            );
          }

          if (!args.recursive) throw new Error(`${show(target)} is a directory; pass recursive to delete it`);
          const files: string[] = [];
          const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) walk(full);
              else files.push(full);
            }
          };
          walk(target);
          if (files.length > MAX_DELETE_ENTRIES) {
            throw new Error(
              `${show(target)} holds ${files.length} files, over the ${MAX_DELETE_ENTRIES} limit for one delete. Remove it in smaller pieces.`,
            );
          }
          for (const file of files) archive(workspace, file, "delete_path recursive");
          fs.rmSync(target, { recursive: true });
          return result(
            `Deleted ${show(target)} and ${files.length} file(s). Call restore_file with no backup id to list them.`,
            { entries: files.length },
          );
        });
      },
    });

    tools.push({
      name: "restore_file",
      label: "Restore",
      description:
        "Undo a delete or overwrite. With no arguments it lists what can be restored; pass a backup id to " +
        "put those bytes back at their original path.",
      executionMode: "sequential",
      parameters: Type.Unsafe({
        type: "object",
        properties: { ...intent, backup: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 100 } },
        required: [],
      }),
      execute: async (_callId, params) => {
        const args = params as { backup?: string; limit?: number };
        const journalPath = path.join(trashDir(), "journal.jsonl");
        const entries = fs.existsSync(journalPath)
          ? fs
              .readFileSync(journalPath, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { at: string; reason: string; path: string; backup: string })
          : [];

        if (!args.backup) {
          const recent = entries.slice(-(args.limit ?? 20)).reverse();
          const listing = recent.map((entry) => `${entry.backup}  ${entry.at}  ${entry.reason}  ${entry.path}`);
          return result(listing.join("\n") || "Nothing to restore", { count: recent.length });
        }

        const entry = entries.findLast((item) => item.backup === args.backup);
        if (!entry) throw new Error(`Unknown backup id ${args.backup}`);
        const source = path.join(trashDir(), entry.backup);
        if (!fs.existsSync(source)) throw new Error(`Backup ${args.backup} is no longer on disk`);
        const target = safePath(workspace, entry.path);
        return withLock([target], async () => {
          archive(workspace, target, "restore_file overwrite");
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target);
          return result(`Restored ${entry.path}`, { path: entry.path, revision: readRevision(target) });
        });
      },
    });
  }

  if (config.shell) tools.push(shellTool(workspace));

  return tools;
}

/**
 * The shell, borrowed whole from pi-agent-core.
 *
 * Luma used to spawn PowerShell on Windows and `/bin/sh` elsewhere, which made
 * the language the model had to write a property of the host it happened to run
 * on. The harness resolves one bash everywhere and brings streaming output,
 * truncation with an overflow file, and process-tree kills — all of which the
 * hand-written version either lacked or got subtly wrong.
 *
 * `createBashTool` also offers a `prepare` hook for exactly this kind of
 * preflight, but the approval gate stays one level up in `beforeToolCall`,
 * where a refusal becomes a tool result the model can read instead of an error
 * it is likely to retry.
 */
function shellTool(workspace: string): AgentTool {
  // Git Bash rebuilds PATH from the Windows process environment. Production
  // starts Luma with its bundled Node at the front, but other launchers (and
  // the audit server) need the same guarantee here: coding commands are part of
  // Luma, so they must not depend on a system-wide Node installation.
  const nodeDir = path.dirname(process.execPath);
  const shellPath = [nodeDir, process.env.PATH].filter(Boolean).join(path.delimiter);
  const env = new NodeExecutionEnv({ cwd: workspace, shellEnv: { PATH: shellPath } });
  const bash = createBashTool();
  return {
    ...bash,
    name: SHELL_TOOL,
    label: "Run command",
    description: `${bash.description} Runs in ${workspace}. Every command is shown to the user for approval before it runs.`,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        ...intent,
        command: { type: "string", description: "Shell command to execute." },
        timeout: { type: "number", description: "Timeout in seconds. Optional; there is no default." },
      },
      required: ["command"],
    }),
    execute: (callId, params, signal, onUpdate) =>
      bash.execute(callId, params as { command: string; timeout?: number }, signal, onUpdate as never, { env }),
  } as AgentTool;
}

interface Edit {
  path: string;
  old_text: string;
  new_text: string;
  expect_revision?: string;
  replace_all?: boolean;
}

/** Line-by-line search used when ripgrep is not installed. */
function scanForMatches(base: string, workspace: string, query: string, glob: string | undefined, limit: number) {
  const pattern = new RegExp(query, "i");
  const suffix = glob?.replace(/^\*+/, "");
  const hits: string[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (hits.length >= limit || SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (suffix && !entry.name.endsWith(suffix)) continue;
      let content: string;
      try {
        if (fs.statSync(full).size > 2_000_000) continue;
        content = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      content.split(/\r?\n/).forEach((line, index) => {
        if (hits.length < limit && pattern.test(line)) {
          hits.push(`${path.relative(workspace, full)}:${index + 1}:${truncateLine(line).text}`);
        }
      });
    }
  };

  const stat = fs.statSync(base);
  if (stat.isDirectory()) walk(base);
  return hits;
}
