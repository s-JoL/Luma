/**
 * Reports exported functions, values and classes that nothing outside their own
 * file uses, so a refactor's leftovers show up as a list rather than as code
 * nobody dares delete. Types are not reported: exporting the interface of a
 * parameter is documentation, not a claim that someone imports it.
 *
 *   node --import tsx scripts/audit-dead.ts
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src", "scripts"];
const EXPORTED = /export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g;

const files: string[] = [];
const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
};
for (const root of ROOTS) walk(root);

const sources = new Map(files.map((file) => [file, fs.readFileSync(file, "utf8")]));

/**
 * Declarations are looked for in code only. Several scripts embed a fixture
 * module in a template literal, and an `export` in there is a string, not this
 * file's API — while a *use* inside a string still counts, since that is how
 * those fixtures reach the thing they exercise.
 */
const blank = (literal: string) => literal.replace(/[^\n]/g, " ");
const withoutLiterals = (text: string) =>
  text
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, blank)
    .replace(/(["'])(?:\\[\s\S]|(?!\1)[^\\\n])*\1/g, blank);

let dead = 0;
for (const [file, text] of sources) {
  const code = withoutLiterals(text);
  for (const match of code.matchAll(EXPORTED)) {
    const name = match[1]!;
    const used = [...sources].some(([other, body]) => other !== file && new RegExp(`\\b${name}\\b`).test(body));
    if (used) continue;
    console.log(`${file}:${code.slice(0, match.index).split("\n").length}  ${name}`);
    dead += 1;
  }
}
console.log(`\n${dead} exported name(s) referenced only in their own file`);
// A finding is a real one: either the name has no callers and should go, or the
// `export` should. Failing here is what keeps that from accumulating.
if (dead) process.exitCode = 1;
