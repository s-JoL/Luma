/**
 * Read-only report on the live database, plus an isolated copy that carries
 * only configuration so a test server can run real models without touching the
 * production transcript.
 *
 *   node --import tsx scripts/audit-db.ts            # report only
 *   node --import tsx scripts/audit-db.ts --clone    # also build data-audit/
 */
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const DATA = join(process.cwd(), "data");
const LIVE = join(DATA, "luma.sqlite");
const CLONE_DIR = join(process.cwd(), "data-audit");

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const size = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

console.log(`main ${mb(size(LIVE))} | wal ${mb(size(`${LIVE}-wal`))} | shm ${mb(size(`${LIVE}-shm`))}`);

const db = new DatabaseSync(LIVE, { readOnly: true });

const tables = db
  .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
  .all() as Array<{ name: string }>;
console.log(`\ntables: ${tables.map((table) => table.name).join(", ")}`);

console.log("\nrow counts");
for (const { name } of tables) {
  try {
    const row = db.prepare(`select count(*) as n from "${name}"`).get() as { n: number };
    if (row.n) console.log(`  ${name.padEnd(22)} ${row.n}`);
  } catch (error) {
    console.log(`  ${name.padEnd(22)} unreadable: ${(error as Error).message}`);
  }
}

console.log("\nevents by type (count, stored json bytes)");
const byType = db
  .prepare("select type, count(*) as n, sum(length(data)) as bytes from events group by type order by bytes desc")
  .all() as Array<{ type: string; n: number; bytes: number }>;
let total = 0;
for (const row of byType) {
  total += row.bytes ?? 0;
  console.log(`  ${row.type.padEnd(24)} ${String(row.n).padStart(9)}  ${mb(row.bytes ?? 0)}`);
}
console.log(`  ${"TOTAL".padEnd(24)} ${"".padStart(9)}  ${mb(total)}`);

const settled = db
  .prepare(
    `select count(*) as n, sum(length(e.data)) as bytes
       from events e join runs r on r.id = e.run_id
      where e.type = 'message.delta' and r.status in ('completed','failed','cancelled')`,
  )
  .get() as { n: number; bytes: number };
console.log(`\ndeltas still stored for settled runs: ${settled.n ?? 0} rows, ${mb(settled.bytes ?? 0)}`);

for (const pragma of ["auto_vacuum", "journal_mode", "synchronous", "busy_timeout", "page_size", "freelist_count"]) {
  const row = db.prepare(`pragma ${pragma}`).get() as Record<string, unknown> | undefined;
  console.log(`pragma ${pragma.padEnd(15)} ${row ? Object.values(row)[0] : "(none)"}`);
}

if (process.argv.includes("--clone")) {
  // Configuration only: providers, models, capability settings, MCP servers and
  // the encrypted provider keys come across so the audit server talks to the
  // same real endpoints, while conversations, runs, events, files and memories
  // start empty. The access code is replaced below so the real one is never
  // handled by the test harness.
  const CONFIG_TABLES = ["settings", "providers", "models", "mcp_servers", "secrets"].filter((name) =>
    tables.some((table) => table.name === name),
  );

  rmSync(CLONE_DIR, { recursive: true, force: true });
  mkdirSync(CLONE_DIR, { recursive: true });
  copyFileSync(join(DATA, "master.key"), join(CLONE_DIR, "master.key"));

  const clonePath = join(CLONE_DIR, "luma.sqlite");
  const target = new DatabaseSync(clonePath);
  for (const name of CONFIG_TABLES) {
    const ddl = db.prepare("select sql from sqlite_master where type='table' and name=?").get(name) as {
      sql: string;
    };
    target.exec(ddl.sql);
    const rows = db.prepare(`select * from "${name}"`).all() as Array<Record<string, unknown>>;
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]!);
    const insert = target.prepare(
      `insert into "${name}" (${columns.map((c) => `"${c}"`).join(",")}) values (${columns.map(() => "?").join(",")})`,
    );
    for (const row of rows) insert.run(...columns.map((column) => row[column] as never));
    console.log(`cloned ${name}: ${rows.length} rows`);
  }
  target.close();

  // Swap in a throwaway access code so the audit instance never authenticates
  // with the credential the real server uses.
  const { SECRET } = await import("../src/server/config.ts");
  const { loadMasterKey, SecretVault } = await import("../src/server/crypto/secrets.ts");
  const { Db } = await import("../src/server/store/db.ts");
  const { Store } = await import("../src/server/store/store.ts");
  const auditStore = new Store(new Db(clonePath));
  new SecretVault(auditStore, loadMasterKey(join(CLONE_DIR, "master.key"))).set(SECRET.accessCode, "AUDITCODE");
  auditStore.setSetting("totp", JSON.stringify({ enabled: false }));

  console.log(`\naudit database ready at ${clonePath} (access code AUDITCODE)`);
}

db.close();
