import { formatSkillInvocation, loadSkills, type AgentTool, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { Type } from "@earendil-works/pi-ai";
import { paths } from "../env.ts";
import { INTENT_DESCRIPTION } from "./descriptions.ts";

/**
 * Skills are folders of written instructions the agent can pull in when a task
 * calls for them: `data/skills/<name>/SKILL.md`, with a `name` and `description`
 * in the frontmatter and the procedure in the body.
 *
 * Only the one-line descriptions go into the system prompt. The body — which can
 * be thousands of tokens of procedure — is fetched by the tool below, and only
 * for the skill the model actually decided to use. That is what makes a large
 * library of skills affordable: the prompt grows by a line per skill, not by a
 * document per skill.
 *
 * There is no setting for this. A conversation gains the capability by there
 * being a skill on disk, and loses it by there not being one, which is one less
 * switch to explain and one less state to get wrong.
 */
export async function loadSkillLibrary(directory = paths.skills) {
  const { skills, diagnostics } = await loadSkills(new NodeExecutionEnv({ cwd: directory }), directory);
  for (const diagnostic of diagnostics) {
    console.warn(`[skills] ${diagnostic.code} in ${diagnostic.path}: ${diagnostic.message}`);
  }
  // A skill whose author opted out of model invocation cannot be reached by the
  // tool, so advertising it would only invite a call that always fails.
  return skills.filter((skill) => !skill.disableModelInvocation);
}

/** The catalogue for the system prompt: what exists, and when to reach for it. */
export function skillCatalogue(skills: Skill[]) {
  if (!skills.length) return "";
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
  return [
    "# Skills",
    "",
    "These are written procedures for specific kinds of work. When one matches the",
    "task, call `use_skill` with its name and follow the instructions it returns",
    "before doing the work yourself.",
    "",
    lines,
  ].join("\n");
}

export function skillTools(skills: Skill[]): AgentTool[] {
  if (!skills.length) return [];
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  return [
    {
      name: "use_skill",
      label: "use_skill",
      description:
        "Load the full instructions for one of the skills listed in the system prompt. Call this before starting work that a skill covers, then follow what it returns.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          intent: { type: "string", description: INTENT_DESCRIPTION },
          name: { type: "string", description: `The skill to load. One of: ${[...byName.keys()].join(", ")}` },
        },
        required: ["intent", "name"],
      }),
      executionMode: "sequential",
      execute: async (_callId, params) => {
        const { name } = params as { name?: string };
        const skill = byName.get(String(name));
        if (!skill) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No skill named "${name}". Available: ${[...byName.keys()].join(", ")}`,
              },
            ],
            details: {},
          };
        }
        return {
          content: [{ type: "text" as const, text: formatSkillInvocation(skill) }],
          details: { structuredContent: { skill: { name: skill.name, path: skill.filePath } } },
        };
      },
    },
  ];
}
