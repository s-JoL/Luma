/**
 * Reclaims disk from the live database, with the checks that make that safe to
 * do to real data.
 *
 * The order matters. Integrity is verified before anything is written, because
 * vacuuming a corrupt file rewrites the corruption into a smaller file. The
 * backup is taken with `VACUUM INTO`, which asks SQLite for a consistent
 * snapshot rather than copying bytes out from under an active WAL — a plain
 * file copy of a hot database is a well-known way to produce a backup that
 * only fails when you need it. Row counts are taken before and after and
 * compared, so "smaller" is never reported without "same contents".
 *
 *   node --import tsx scripts/reclaim-db.ts --report   read-only, opens nothing for writing
 *   node --import tsx scripts/reclaim-db.ts            verifies and backs up, reclaims nothing
 *   node --import tsx scripts/reclaim-db.ts --apply    also checkpoints and vacuums
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, paths } from "../src/server/env.ts";

const apply = process.argv.includes("--apply");
/** Opens the file read-only and stops after the numbers: safe against a live server. */
const reportOnly = process.argv.includes("--report");
const file = paths.db;

/** Tables whose loss would be the actual disaster, so they are counted by name. */
const CORE_TABLES = [
  "conversations",
  "messages",
  "runs",
  "events",
  "files",
  "chunks",
  "embeddings",
  "memories",
  "images",
  "models",
  "providers",
  "secrets",
  "settings",
  "sessions",
  "mcp_servers",
  "approvals",
];

function sizes() {
  const of = (suffix: string) => {
    try {
      return fs.statSync(`${file}${suffix}`).size;
    } catch {
      return 0;
    }
  };
  return { main: of(""), wal: of("-wal"), shm: of("-shm") };
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

function scalar(db: DatabaseSync, sql: string) {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  return Number(Object.values(row ?? {})[0] ?? 0);
}

function counts(db: DatabaseSync) {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const out: Record<string, number> = {};
  for (const table of CORE_TABLES) {
    if (present.has(table)) out[table] = scalar(db, `SELECT COUNT(*) FROM "${table}"`);
  }
  return out;
}

function report(label: string, db: DatabaseSync) {
  const file = sizes();
  const pageSize = scalar(db, "PRAGMA page_size");
  const pageCount = scalar(db, "PRAGMA page_count");
  const freelist = scalar(db, "PRAGMA freelist_count");
  const autoVacuum = scalar(db, "PRAGMA auto_vacuum");
  console.log(
    `${label.padEnd(7)} main ${mb(file.main).padStart(9)}  wal ${mb(file.wal).padStart(9)}  ` +
      `pages ${String(pageCount).padStart(7)}  free ${String(freelist).padStart(7)}` +
      ` (${mb(freelist * pageSize)})  auto_vacuum=${autoVacuum}`,
  );
  return { ...file, pageSize, pageCount, freelist, autoVacuum };
}

if (!fs.existsSync(file)) {
  console.error(`no database at ${file}`);
  process.exit(1);
}

const mode = reportOnly
  ? "report — opened read-only, nothing is written"
  : apply
    ? "APPLY — the file will be rewritten"
    : "verify and back up — the live file is not modified";
console.log(`database  ${file}`);
console.log(`mode      ${mode}\n`);

const db = new DatabaseSync(file, { readOnly: reportOnly });

// 1. Integrity first: never compact a file that is already damaged.
const integrity = (db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>)
  .map((row) => String(Object.values(row)[0]))
  .join("; ");
const foreignKeys = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
console.log(`integrity_check    ${integrity}`);
console.log(`foreign_key_check  ${foreignKeys.length ? `${foreignKeys.length} violation(s)` : "ok"}\n`);
if (integrity !== "ok") {
  console.error("refusing to touch a database that does not pass integrity_check");
  db.close();
  process.exit(1);
}

const before = report("before", db);
const beforeCounts = counts(db);
console.log(
  `\ncounts    ${Object.entries(beforeCounts)
    .map(([table, count]) => `${table}=${count}`)
    .join("  ")}\n`,
);

if (reportOnly) {
  db.close();
  console.log("report only — no backup taken, nothing reclaimed");
  process.exit(0);
}

// 2. A consistent snapshot, written by SQLite itself.
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupDir = path.join(DATA_DIR, "backups");
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `luma-${stamp}.sqlite`);
db.prepare("VACUUM INTO ?").run(backup);
const backupBytes = fs.statSync(backup).size;

// 3. The backup is only a backup if it opens, verifies and holds the same rows.
const verify = new DatabaseSync(backup, { readOnly: true });
const backupIntegrity = String(Object.values((verify.prepare("PRAGMA integrity_check").get() ?? {}) as object)[0]);
const backupCounts = counts(verify);
verify.close();
const drift = Object.entries(beforeCounts).filter(([table, count]) => backupCounts[table] !== count);
console.log(`backup    ${backup}`);
console.log(`          ${mb(backupBytes)}  integrity_check=${backupIntegrity}  ${drift.length ? `DRIFT: ${drift.map(([t]) => t).join(",")}` : "row counts match"}`);
if (backupIntegrity !== "ok" || drift.length) {
  console.error("\nbackup did not verify; nothing was reclaimed");
  db.close();
  process.exit(1);
}

if (!apply) {
  console.log("\ndry run complete — re-run with --apply to reclaim");
  db.close();
  process.exit(0);
}

// 4. Fold the WAL back in, then rewrite the file.
const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, unknown> | undefined;
console.log(`\ncheckpoint ${JSON.stringify(checkpoint)}`);
if (before.autoVacuum === 0) {
  console.log("auto_vacuum is off; switching to INCREMENTAL, which needs a full VACUUM to take effect");
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
}
db.exec("VACUUM");
db.exec("PRAGMA optimize");

// VACUUM rewrites the whole database through the WAL, so measuring here without
// folding that back reports a file that grew by its own size. The second
// checkpoint is what makes the "after" numbers the ones that survive a restart.
const settle = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Record<string, unknown> | undefined;
console.log(`checkpoint ${JSON.stringify(settle)}`);

const after = report("after ", db);
const afterCounts = counts(db);
const lost = Object.entries(beforeCounts).filter(([table, count]) => afterCounts[table] !== count);
console.log(
  `\ncounts    ${Object.entries(afterCounts)
    .map(([table, count]) => `${table}=${count}`)
    .join("  ")}`,
);

const finalIntegrity = String(Object.values((db.prepare("PRAGMA integrity_check").get() ?? {}) as object)[0]);
console.log(`\nintegrity_check after  ${finalIntegrity}`);
db.close();

const freed = before.main + before.wal - (after.main + after.wal);
console.log(
  `\nreclaimed ${mb(freed)}  (main ${mb(before.main)} → ${mb(after.main)}, wal ${mb(before.wal)} → ${mb(after.wal)})`,
);
console.log(`backup kept at ${backup}`);

if (lost.length) {
  console.error(`\nROW LOSS in ${lost.map(([table]) => table).join(", ")} — restore from the backup`);
  process.exit(1);
}
if (finalIntegrity !== "ok") {
  console.error("\nintegrity_check failed after vacuum — restore from the backup");
  process.exit(1);
}
console.log("all row counts unchanged");
