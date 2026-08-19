/**
 * Compares the SQL in `docs/01-data-model.md` against `schema.sql`, so the
 * document that explains the database cannot quietly describe a different one.
 * Only tables the doc chooses to spell out are checked, and only their column
 * names: the doc abbreviates types deliberately.
 *
 *   node --import tsx scripts/audit-doc-schema.ts
 */
import fs from "node:fs";

const schema = fs.readFileSync("src/server/store/schema.sql", "utf8");
const doc = fs.readFileSync("docs/01-data-model.md", "utf8");

/** Column names from a `create table` body, ignoring constraints and comments. */
function columns(body: string) {
  // Split on CRLF too: `.` does not match a carriage return, so a comment on a
  // CRLF line would survive the strip below and its words would read as columns.
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, "").trim())
    .filter(Boolean)
    .flatMap((line) => (/^(primary|unique|foreign|check|constraint)\b/i.test(line) ? [] : line.split(",")))
    .map((part) => part.trim().split(/[\s(]/)[0] ?? "")
    .filter((name) => /^[a-z_]+$/.test(name));
}

function tables(sql: string) {
  const found = new Map<string, string[]>();
  for (const match of sql.matchAll(/create table (?:if not exists )?(\w+)\s*\(([\s\S]*?)\n\)/gi)) {
    found.set(match[1]!.toLowerCase(), columns(match[2]!));
  }
  return found;
}

const real = tables(schema);
const described = tables(doc);
let problems = 0;

for (const [name, documented] of described) {
  const actual = real.get(name);
  if (!actual) {
    console.log(`${name}: documented but not in schema.sql`);
    problems += 1;
    continue;
  }
  const missing = documented.filter((column) => !actual.includes(column));
  const undocumented = actual.filter((column) => !documented.includes(column));
  if (missing.length) {
    console.log(`${name}: documented column(s) that do not exist — ${missing.join(", ")}`);
    problems += 1;
  }
  // A doc that lists some columns and says so is fine; one that lists all but a
  // few is where a reader is misled, so this is reported rather than failed.
  if (undocumented.length) console.log(`${name}: not mentioned — ${undocumented.join(", ")}`);
}

const unmentioned = [...real.keys()].filter((name) => !described.has(name));
console.log(`\n${described.size} table(s) checked, ${problems} mismatch(es)`);
if (unmentioned.length) console.log(`tables described in prose only: ${unmentioned.join(", ")}`);
if (problems) process.exitCode = 1;
