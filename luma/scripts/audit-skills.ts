/**
 * Skills, tested against a real directory on disk: what the loader accepts, what
 * reaches the system prompt, and what the `use_skill` tool hands back.
 *
 * The point of the design is that the prompt pays a line per skill while the body
 * is fetched only when the model asks for it, so the checks below are mostly about
 * where text is *not*.
 *
 *   node --import tsx scripts/audit-skills.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSkillLibrary, skillCatalogue, skillTools } from "../src/server/tools/skills.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "luma-skills-"));

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

function writeSkill(name: string, frontmatter: string, body: string) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

const LONG_BODY = "第一步：先量尺寸。\n".repeat(40);

writeSkill(
  "poster",
  'name: poster\ndescription: "Lay out a poster: sizes, safe margins, and where the text goes."',
  LONG_BODY,
);
writeSkill(
  "retouch",
  "name: retouch\ndescription: Clean up a photo without making it look plastic.",
  "Work in passes, and stop before the skin goes flat.",
);
writeSkill(
  "internal",
  "name: internal\ndescription: Bookkeeping the model should never pick on its own.\ndisable-model-invocation: true",
  "Not for the model.",
);
// A malformed skill must not take the rest of the library down with it.
fs.mkdirSync(path.join(sandbox, "broken"), { recursive: true });
fs.writeFileSync(path.join(sandbox, "broken", "SKILL.md"), "no frontmatter at all\n", "utf8");

const skills = await loadSkillLibrary(sandbox);

await check("skills load from disk, and a broken one is skipped rather than fatal", () => {
  const names = skills.map((skill) => skill.name).sort();
  assert(names.includes("poster") && names.includes("retouch"), `loaded ${JSON.stringify(names)}`);
  assert(!names.includes("broken"), "a skill without frontmatter was loaded as if it were valid");
  return `loaded ${JSON.stringify(names)}`;
});

await check("a skill its author closed to the model is not offered to the model", () => {
  assert(!skills.some((skill) => skill.name === "internal"), "internal skill is reachable");
  assert(!skillCatalogue(skills).includes("internal"), "internal skill is advertised in the prompt");
  return "internal skill withheld";
});

await check("the prompt gets one line per skill, not the procedures", () => {
  const catalogue = skillCatalogue(skills);
  assert(catalogue.includes("poster") && catalogue.includes("retouch"), `catalogue was:\n${catalogue}`);
  assert(catalogue.includes("Lay out a poster"), "the description never made it into the prompt");
  assert(!catalogue.includes("第一步：先量尺寸"), "the whole procedure was pasted into the prompt");
  assert(catalogue.split("\n").length < 20, `catalogue is ${catalogue.split("\n").length} lines for 2 skills`);
  return `${catalogue.length} chars for 2 skills, body is ${LONG_BODY.length} chars`;
});

await check("an empty library adds nothing to the prompt and no tool", async () => {
  const empty = path.join(sandbox, "nothing-here");
  const none = await loadSkillLibrary(empty);
  assert(none.length === 0, `${none.length} skills found in a directory that does not exist`);
  assert(skillCatalogue(none) === "", "an empty library still wrote a prompt section");
  assert(skillTools(none).length === 0, "an empty library still offered use_skill");
  return "missing directory is not an error";
});

const [tool] = skillTools(skills);

await check("use_skill returns the full procedure for the skill the model asked for", async () => {
  assert(tool, "no use_skill tool");
  const result = await tool!.execute("call-1", { intent: "lay out a poster", name: "poster" }, {} as never);
  const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
  assert(text.includes("第一步：先量尺寸"), "the procedure was not returned");
  assert(text.includes('<skill name="poster"'), "the procedure arrived without the wrapper naming it");
  assert(!text.includes("Clean up a photo"), "the tool leaked a skill that was not asked for");
  return `${text.length} chars returned on demand`;
});

await check("asking for a skill that does not exist says so and lists the ones that do", async () => {
  const result = await tool!.execute("call-2", { intent: "typo", name: "postre" }, {} as never);
  const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
  assert(text.includes("postre"), `unhelpful error: ${text}`);
  assert(text.includes("poster"), "the error did not tell the model what it could have called");
  return text.trim();
});

await check("the tool's own parameter description enumerates the loadable skills", () => {
  const description = JSON.stringify(tool!.parameters);
  assert(description.includes("poster") && description.includes("retouch"), "the name parameter is unconstrained");
  assert(!description.includes("internal"), "the name parameter advertises a withheld skill");
  return "name parameter lists poster, retouch";
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : `\nall skill checks passed`);
process.exit(failures ? 1 : 0);
