/**
 * Human approval for destructive coding calls.
 *
 * The model used to authorise itself by passing `confirm: true`, which is not a
 * safety property: the same reasoning that decided to delete the directory also
 * decided the delete was fine. Two pieces replace it. `describeRisk` classifies
 * a call from its validated arguments, and `ApprovalRegistry` parks the agent
 * loop until a person answers.
 *
 * Classification reads structure — which tool, which path, whether the target
 * exists — and never the meaning of a string. Whatever the model wrote is data
 * to be shown, not evidence to be interpreted.
 *
 * The durable half is the `approvals` table, written before anyone is asked and
 * the only thing a decision touches, so a refresh, a reconnect or a second
 * browser all see the same state and a double-tap decides once. This module is
 * the volatile half and is deliberately thin, because everything it holds dies
 * with the process while the row does not.
 *
 * One rule the code enforces rather than documents: a wait never resolves
 * itself as approved. Both the timeout and the run-cancelled path settle the
 * row as refused, so a question nobody answered can only ever fail closed.
 */
import fs from "node:fs";
import path from "node:path";
import type { Approval } from "@shared/types.ts";
import type { Store } from "../store/store.ts";
import { SHELL_TOOL } from "../tools/coding.ts";

/** How long a pending request waits before it gives up and refuses. */
export const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

export interface Risk {
  /** Stable identifier for the kind of danger, shown as a badge and logged. */
  action: string;
  /** One sentence naming exactly what will happen. */
  summary: string;
  /** Facts the card lists under the sentence. */
  detail: Record<string, unknown>;
}

function label(workspace: string, target: string) {
  return path.relative(workspace, target) || ".";
}

function sizeOf(target: string) {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}

/** Counts files under a directory, stopping early so a huge tree cannot stall the gate. */
function measure(target: string, budget = 5_000) {
  let files = 0;
  let bytes = 0;
  let truncated = false;
  const walk = (dir: string) => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files += 1;
      if (files > budget) {
        truncated = true;
        return;
      }
      bytes += sizeOf(full);
    }
  };
  walk(target);
  return { files, bytes, truncated };
}

function inside(workspace: string, requested: unknown) {
  if (typeof requested !== "string" || !requested) return null;
  return path.resolve(workspace, requested);
}

/**
 * Every call the gate holds, and how each one is described.
 *
 * The coupling is by tool name because that is the only handle the tool
 * definitions offer: `AgentTool` carries no risk metadata, and the harness owns
 * that type. Keeping the whole set in one table is what makes the coupling
 * legible — a tool that is renamed or added in `src/server/tools/coding.ts`
 * needs exactly one edit here, and a tool absent from this table runs
 * unattended by construction. When a tool definition can declare its own risk,
 * `describeRisk` should read the classifier off the definition and fall back to
 * this table.
 */
const CLASSIFIERS: Record<string, (input: Record<string, unknown>, root: string) => Risk | null> = {
  delete_path: (input, root) => {
    const target = inside(root, input.path);
    if (!target) return null;
    const shown = label(root, target);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(target).isDirectory();
    } catch {
      // Reported by the tool. The gate still asks, because the model still asked to delete.
    }
    if (!isDirectory) {
      return {
        action: "delete",
        summary: `删除文件 ${shown}`,
        detail: { path: shown, bytes: sizeOf(target), recoverable: true },
      };
    }
    const { files, bytes, truncated } = measure(target);
    return {
      action: "delete_recursive",
      summary: `递归删除目录 ${shown}，包含 ${truncated ? `超过 ${files}` : files} 个文件`,
      detail: { path: shown, files, bytes, truncated, recursive: Boolean(input.recursive), recoverable: true },
    };
  },

  // A move that lands on an existing path destroys it; a move into free space
  // still takes a file out from under anything that refers to it. Both are
  // asked about, but they are separate actions so the card can say which one
  // this is and the reader is not shown "overwrite" for a plain rename.
  move_path: (input, root) => {
    const from = inside(root, input.from);
    const to = inside(root, input.to);
    if (!from || !to) return null;
    const clobbers = fs.existsSync(to);
    return {
      action: clobbers ? "move_overwrite" : "move",
      summary: clobbers
        ? `移动 ${label(root, from)} 覆盖已存在的 ${label(root, to)}`
        : `移动 ${label(root, from)} 到 ${label(root, to)}`,
      detail: {
        from: label(root, from),
        to: label(root, to),
        overwrites: clobbers,
        overwriteRequested: Boolean(input.overwrite),
        ...(clobbers ? { bytes: sizeOf(to) } : {}),
        recoverable: true,
      },
    };
  },

  // Creating a file is ordinary work; replacing one the user already has is not.
  write_file: (input, root) => {
    const target = inside(root, input.path);
    if (!target || !fs.existsSync(target)) return null;
    return {
      action: "overwrite",
      summary: `覆盖已存在的文件 ${label(root, target)}`,
      detail: {
        path: label(root, target),
        currentBytes: sizeOf(target),
        newBytes: typeof input.content === "string" ? Buffer.byteLength(input.content) : 0,
        recoverable: true,
      },
    };
  },

  // A shell command is arbitrary code, and there is no honest way to sort the
  // arbitrary into safe and dangerous from the outside. The list of patterns
  // that used to try — rm, del, Remove-Item, git push — matched `rm -rf` and
  // missed `unlink`, `shred`, and `npm run clean`, so it read as a safety
  // control while being a suggestion. Showing every command is the only version
  // that is true: the reader sees what will run, and nothing gets through by
  // being spelled differently.
  [SHELL_TOOL]: (input, root) => {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command.trim()) return null;
    // The full command travels in the detail, because a reader who approves a
    // shortened version has approved something else. The summary is a label and
    // may be cut, but it says so when it is: a long harmless prefix hiding a
    // payload is exactly how a silent ellipsis gets abused.
    const shown =
      command.length > 300 ? `${command.slice(0, 300)}…（共 ${command.length} 字符，见下方完整命令）` : command;
    return {
      action: "shell",
      summary: `运行命令：${shown}`,
      detail: { command, workspace: root, recoverable: false },
    };
  },
};

/**
 * Returns the risk a call carries, or null when it may run unattended.
 *
 * Only two states matter to the caller: a `Risk` means hold the call and ask,
 * null means proceed. There is deliberately no third "warn but continue"
 * state, because a warning nobody has to answer is not a control.
 *
 * Classification reads the filesystem so the card can say "delete src/ and 42
 * files" rather than "delete src/". Reading is best-effort: a path that has
 * vanished between the model's decision and this preflight still produces a
 * card, and the tool itself reports the real failure.
 */
export function describeRisk(toolName: string, args: Record<string, unknown>, workspace: string): Risk | null {
  return CLASSIFIERS[toolName]?.(args ?? {}, path.resolve(workspace)) ?? null;
}

/**
 * What the model is told when a call does not run. Written as an instruction
 * rather than an error, because the useful next step differs: a refusal means
 * stop and ask, while an expiry means the question simply went unanswered.
 */
export function rejectionMessage(approval: Approval): string {
  if (approval.status === "expired") {
    return "这个操作的人工批准请求已超时，没有执行。不要自动重试，先向用户说明并等待指示。";
  }
  return "用户拒绝了这个操作，它没有执行。不要重试同一个操作，改用其他方式或先询问用户。";
}

/**
 * Parks the agent loop on a pending row and wakes it when someone decides.
 *
 * The registry holds no state worth persisting: `notify` only says "this row
 * changed, read it again", which is what lets a decision made by any request
 * handler — or by a second browser tab — reach the waiting run.
 */
export class ApprovalRegistry {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly timeoutMs = APPROVAL_TIMEOUT_MS) {}

  /** Tells anyone waiting on this row to re-read it. Safe to call for unknown ids. */
  notify(id: string) {
    for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
  }

  /** Number of calls currently parked, for diagnostics and tests. */
  get pending() {
    return this.waiters.size;
  }

  async wait(store: Store, id: string, signal?: AbortSignal): Promise<Approval> {
    const current = store.getApproval(id);
    if (!current) throw new Error(`Unknown approval ${id}`);
    if (current.status !== "pending") return current;

    return new Promise<Approval>((resolve) => {
      const done = (approval: Approval) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const set = this.waiters.get(id);
        set?.delete(wake);
        if (set && !set.size) this.waiters.delete(id);
        resolve(approval);
      };

      // Settling the row here rather than resolving optimistically is what
      // makes "nobody answered" indistinguishable from "answered no" to
      // everything downstream, including a client that reconnects later.
      const refuse = (status: "rejected" | "expired") => {
        done(store.decideApproval(id, status) ?? store.getApproval(id)!);
      };

      const wake = () => {
        const latest = store.getApproval(id);
        if (latest && latest.status !== "pending") done(latest);
      };

      const onAbort = () => refuse("rejected");
      const timer = setTimeout(() => refuse("expired"), this.timeoutMs);
      timer.unref?.();

      if (signal?.aborted) {
        refuse("rejected");
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      const set = this.waiters.get(id) ?? new Set<() => void>();
      set.add(wake);
      this.waiters.set(id, set);

      // A decision can land between the read above and the listener going in.
      wake();
    });
  }
}
