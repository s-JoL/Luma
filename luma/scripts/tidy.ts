/**
 * Removes what a test run leaves behind: conversations, runs, events, jobs, and
 * any file that is not one of the source documents. Safe to run repeatedly.
 *
 * It resets `$LUMA_DATA_DIR`, which defaults to `data` — the real instance. Point
 * it at a scratch directory before running it against test leftovers, and stop
 * the server first: this takes the databases for itself.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA = process.env.LUMA_DATA_DIR ?? "data";
const db = new DatabaseSync(path.join(DATA, "luma.sqlite"));
db.exec("PRAGMA foreign_keys = ON");

const KEEP = "SELECT id FROM files WHERE source = 'librechat' AND mime NOT LIKE 'image/%'";

const doomed = db
  .prepare(`SELECT id, name, disk_path FROM files WHERE id NOT IN (${KEEP})`)
  .all() as { id: string; name: string; disk_path: string }[];

let bytes = 0;
for (const file of doomed) {
  if (file.disk_path && fs.existsSync(file.disk_path)) {
    bytes += fs.statSync(file.disk_path).size;
    fs.rmSync(file.disk_path);
  }
}
for (const dir of ["assets/files", "assets/thumbs", "assets/meta"]) {
  const full = path.join(DATA, dir);
  if (!fs.existsSync(full)) continue;
  for (const entry of fs.readdirSync(full)) {
    const target = path.join(full, entry);
    bytes += fs.statSync(target).size;
    fs.rmSync(target, { recursive: true, force: true });
  }
}

db.exec("BEGIN");
db.exec("DELETE FROM conversations");
db.exec("DELETE FROM events");
db.exec("DELETE FROM runs");
// Jobs and video assets are part of a run's leftovers too: leaving them behind
// would list generations whose pixels this script just deleted.
db.exec("DELETE FROM jobs");
db.exec("DELETE FROM video_assets");
db.exec("DELETE FROM image_assets");
db.exec(`DELETE FROM files WHERE id NOT IN (${KEEP})`);
db.exec("COMMIT");
db.exec("VACUUM");

// The transcripts themselves live in the session database, and a session tree
// whose conversation is gone is dead weight the search index would still carry.
// Dropping the file is the whole reset; it is rebuilt on the next boot.
db.close();
for (const suffix of ["", "-wal", "-shm"]) {
  const file = path.join(DATA, `sessions.sqlite${suffix}`);
  if (fs.existsSync(file)) fs.rmSync(file);
}
const remaining = new DatabaseSync(path.join(DATA, "luma.sqlite"));
const count = (table: string) =>
  Number((remaining.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c);

console.log(`removed ${doomed.length} files (${(bytes / 1024 / 1024).toFixed(1)} MB) from ${DATA}`);
console.log(`kept ${count("files")} documents, ${count("memories")} memories`);
