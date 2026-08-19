/**
 * Checks that an MCP tool schema survives the trip to a provider that only
 * accepts Google's OpenAPI subset, and that nothing useful is lost on the way.
 *
 *   node --import tsx scripts/audit-schema.ts
 */
import { portableSchema } from "../src/server/mcp/schema.ts";

let failures = 0;

function check(name: string, run: () => string | void) {
  try {
    const note = run();
    console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

/** Every keyword Google's function declarations reject, wherever it can hide. */
const REJECTED = [
  "multipleOf",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "uniqueItems",
  "const",
  "oneOf",
  "allOf",
  "not",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
  "dependentRequired",
  "if",
  "then",
  "else",
  "examples",
];

function keysIn(value: unknown, found = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) keysIn(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    found.add(key);
    keysIn(child, found);
  }
  return found;
}

// The real shape that broke Gemini: a ComfyUI-style generate tool.
const comfy = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: { type: "string", minLength: 1 },
    width: { type: "integer", minimum: 256, maximum: 2048, multipleOf: 8, description: "Image width" },
    height: { type: "integer", minimum: 256, maximum: 2048, multipleOf: 8 },
    cfg: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 30 },
    sampler: { type: "string", enum: ["euler", "dpmpp_2m"] },
    version: { const: "v1" },
    loras: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "object",
        properties: { name: { type: "string" }, weight: { type: "number", multipleOf: 0.05 } },
        additionalProperties: false,
      },
    },
  },
  required: ["prompt"],
};

check("no rejected keyword survives anywhere in the tree", () => {
  const keys = keysIn(portableSchema(comfy));
  const leaked = REJECTED.filter((key) => keys.has(key));
  assert(leaked.length === 0, `leaked ${leaked.join(", ")}`);
  return `${keys.size} distinct keys, none rejected`;
});

check("dropped constraints are explained in the description", () => {
  const output = portableSchema(comfy) as any;
  const width = output.properties.width;
  assert(/multiple of 8/.test(width.description), `width description lost the step: ${width.description}`);
  assert(/Image width/.test(width.description), "width lost its original description");
  const cfg = output.properties.cfg;
  assert(/greater than 0/.test(cfg.description) && /less than 30/.test(cfg.description), `cfg: ${cfg.description}`);
  const weight = output.properties.loras.items.properties.weight;
  assert(/multiple of 0.05/.test(weight.description), `nested weight lost its step: ${weight.description}`);
  return "width, cfg and a nested array item all kept their constraints as prose";
});

check("keywords every provider accepts are preserved", () => {
  const output = portableSchema(comfy) as any;
  assert(output.type === "object", "root type lost");
  assert(output.required?.[0] === "prompt", "required lost");
  assert(output.properties.width.minimum === 256, "minimum lost");
  assert(output.properties.width.maximum === 2048, "maximum lost");
  assert(output.properties.prompt.minLength === 1, "minLength lost");
  assert(output.properties.sampler.enum.length === 2, "enum lost");
  assert(output.properties.loras.items.type === "object", "array item type lost");
  return "type, required, bounds, enum and item shape all intact";
});

check("const becomes a single-value enum", () => {
  const output = portableSchema(comfy) as any;
  assert(Array.isArray(output.properties.version.enum), "const did not become an enum");
  assert(output.properties.version.enum[0] === "v1", "const value lost");
  return 'version → enum ["v1"]';
});

check("an unusable format is dropped and a known one kept", () => {
  const output = portableSchema({
    type: "object",
    properties: {
      when: { type: "string", format: "date-time" },
      who: { type: "string", format: "email" },
    },
  }) as any;
  assert(output.properties.when.format === "date-time", "date-time should survive");
  assert(output.properties.who.format === undefined, "email should be dropped");
  return "date-time kept, email dropped";
});

check("every property ends up with a type", () => {
  const output = portableSchema({
    type: "object",
    properties: { loose: { description: "no type at all" }, list: { items: { type: "string" } } },
  }) as any;
  assert(output.properties.loose.type === "string", "untyped property got no fallback type");
  assert(output.properties.list.type === "array", "property with items did not become an array");
  return "untyped → string, items → array";
});

check("a hostile schema cannot blow the stack", () => {
  const deep: Record<string, unknown> = { type: "object", properties: {} };
  let node = deep;
  for (let index = 0; index < 200; index += 1) {
    const child: Record<string, unknown> = { type: "object", properties: {} };
    (node.properties as Record<string, unknown>).child = child;
    node = child;
  }
  const output = portableSchema(deep) as any;
  assert(output.type === "object", "deep schema did not survive");
  return "200 levels truncated without throwing";
});

check("garbage in produces a usable object schema", () => {
  for (const input of [null, undefined, "string", 42, [], { type: "string" }]) {
    const output = portableSchema(input) as any;
    assert(output.type === "object", `input ${JSON.stringify(input)} produced ${JSON.stringify(output)}`);
    assert(output.properties !== undefined, "missing properties");
  }
  return "null, undefined, scalars, arrays and non-object schemas all normalise";
});

console.log(failures ? `\n${failures} failed` : "\nall schema checks passed");
process.exit(failures ? 1 : 0);
