/**
 * MCP servers publish whatever JSON Schema their author wrote. Google's
 * function-declaration dialect accepts a small OpenAPI 3.0 subset and rejects
 * the rest outright, so one `multipleOf: 8` on a ComfyUI width field fails
 * every tool-enabled turn on a Gemini-backed model with
 * `Unknown name "multipleOf" … Cannot find field`.
 *
 * Rather than teach each provider its own dialect, the copy handed to the model
 * is narrowed to the keywords every provider understands. That allowlist is
 * also the defensive fallback: a keyword nobody has vetted is dropped rather
 * than forwarded, so a schema this file has never seen cannot make a provider
 * reject the whole tool declaration. Constraints that carry real information
 * are folded into the description instead of being dropped, so the model still
 * knows a width must be a multiple of eight. The studio keeps the original
 * schema, because it renders the form itself and a slider genuinely wants the
 * step.
 *
 * What structure survives, since a third-party server is entitled to all of it:
 * `$ref`/`$defs` are resolved and inlined, `allOf` is merged, `oneOf` becomes
 * `anyOf`, `const` becomes a one-value `enum`, and `enum`, `default`, `format`,
 * nested `properties` and nested `items` are carried through untouched.
 *
 * What is still removed, and why:
 *
 * - `additionalProperties`, `patternProperties`, `propertyNames` — Google
 *   rejects them, and an object with no declared extras is already open.
 * - `not`, `if`/`then`/`else`, `dependentRequired` — conditional validation has
 *   no equivalent in any function-declaration dialect.
 * - `multipleOf`, `exclusiveMinimum`/`Maximum`, `uniqueItems` — kept as prose.
 * - a `format` outside Google's list — kept as prose; the word alone makes it
 *   reject the declaration.
 * - `$schema`, `$id`, `examples`, `readOnly`, `deprecated` — annotations the
 *   model cannot act on and one provider or another refuses.
 */

/** Keywords in Google's OpenAPI subset, which OpenAI and Anthropic also accept. */
const KEEP = new Set([
  "type",
  "title",
  "description",
  "nullable",
  "enum",
  "default",
  "properties",
  "required",
  "items",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "anyOf",
  "propertyOrdering",
]);

/** Formats Google recognises; anything else makes it reject the declaration. */
const FORMATS = new Set(["date-time", "enum", "int32", "int64", "float", "double"]);

/** Constraints worth telling the model about in prose once the keyword is gone. */
function describeDropped(schema: Record<string, unknown>) {
  const notes: string[] = [];
  const { multipleOf, exclusiveMinimum, exclusiveMaximum, uniqueItems, const: constant } = schema;
  if (typeof multipleOf === "number") notes.push(`must be a multiple of ${multipleOf}`);
  if (typeof exclusiveMinimum === "number") notes.push(`must be greater than ${exclusiveMinimum}`);
  if (typeof exclusiveMaximum === "number") notes.push(`must be less than ${exclusiveMaximum}`);
  if (uniqueItems === true) notes.push("items must be unique");
  if (constant !== undefined && !Array.isArray(schema.enum)) notes.push(`must be ${JSON.stringify(constant)}`);
  if (typeof schema.format === "string" && !FORMATS.has(schema.format)) notes.push(`format: ${schema.format}`);
  // A schema-valued `additionalProperties` is how a dictionary argument is
  // written, and the keyword itself cannot survive: say so instead.
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    notes.push("further keys of the same shape are allowed");
  }
  if (Array.isArray(schema.type)) {
    const alternatives = schema.type.filter((item) => typeof item === "string" && item !== "null").slice(1);
    if (alternatives.length) notes.push(`may also be ${alternatives.join(" or ")}`);
  }
  return notes;
}

/**
 * Follows a local `$ref` to the definition it names.
 *
 * Every mainstream JSON Schema generator — `zod-to-json-schema` most of all —
 * lifts a repeated shape into `$defs` and refers to it, so a great many real MCP
 * tools describe their arguments this way. `$ref` is not in `KEEP`, so the
 * property came through with no keywords at all and was then typed as a string,
 * and the model was asked to fill an object-shaped argument with prose.
 */
function resolveRef(ref: string, root: Record<string, unknown>): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** `allOf` is an intersection; the flat merge is close enough for a declaration. */
function flatten(schema: Record<string, unknown>) {
  const all = schema.allOf;
  if (!Array.isArray(all)) return schema;
  const merged: Record<string, unknown> = { ...schema };
  delete merged.allOf;
  for (const member of all) {
    if (!member || typeof member !== "object") continue;
    const record = member as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === "properties" && value && typeof value === "object") {
        merged.properties = { ...((merged.properties as object) ?? {}), ...(value as object) };
      } else if (key === "required" && Array.isArray(value)) {
        merged.required = [...new Set([...((merged.required as string[]) ?? []), ...value])];
      } else {
        merged[key] ??= value;
      }
    }
  }
  return merged;
}

function narrow(input: unknown, depth: number, root: Record<string, unknown>, seen: ReadonlySet<string>): unknown {
  if (Array.isArray(input)) return input.map((item) => narrow(item, depth + 1, root, seen));
  if (!input || typeof input !== "object") return input;
  // Deeply recursive or self-referential schemas are not worth chasing; at this
  // depth an untyped object is still a valid declaration.
  if (depth > 12) return { type: "object" };

  let schema = input as Record<string, unknown>;
  const ref = schema.$ref;
  if (typeof ref === "string") {
    // A self-referential definition — a tree node, a comment thread — would
    // otherwise expand forever.
    if (seen.has(ref)) return { type: "object" };
    const target = resolveRef(ref, root);
    if (!target || typeof target !== "object") return { type: "object" };
    const { $ref: _dropped, ...siblings } = schema;
    return narrow({ ...(target as Record<string, unknown>), ...siblings }, depth, root, new Set([...seen, ref]));
  }
  schema = flatten(schema);
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(schema)) {
    // `oneOf` is `anyOf` with an exclusivity every provider ignores anyway, and
    // keeping it as a union beats discarding the branches and guessing a type.
    const target = key === "oneOf" ? "anyOf" : key;
    if (!KEEP.has(target)) continue;
    if (target === "properties" && value && typeof value === "object") {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        properties[name] = narrow(child, depth + 1, root, seen);
      }
      output.properties = properties;
      continue;
    }
    if (target === "type") {
      // `["string", "null"]` is how every generator writes an optional field,
      // and a declaration takes one type plus `nullable` rather than a union.
      const types = (Array.isArray(value) ? value : [value]).filter((item) => typeof item === "string");
      output.type = types.find((item) => item !== "null") ?? "string";
      if (types.includes("null")) output.nullable = true;
      continue;
    }
    if (target === "items") {
      // Draft-04 writes a tuple as an array of schemas; a declaration has room
      // for one item shape, and the first is the one that describes the list.
      const single = Array.isArray(value) ? value[0] : value;
      output.items = narrow(single ?? {}, depth + 1, root, seen);
      continue;
    }
    output[target] = target === "anyOf" ? narrow(value, depth + 1, root, seen) : value;
  }

  // `const` has no equivalent keyword but a one-value enum says the same thing.
  if (schema.const !== undefined && output.enum === undefined) output.enum = [schema.const];
  if (typeof schema.format === "string" && FORMATS.has(schema.format)) output.format = schema.format;

  const notes = describeDropped(schema);
  if (notes.length) {
    const existing = typeof output.description === "string" ? output.description : "";
    output.description = existing ? `${existing} (${notes.join("; ")})` : notes.join("; ");
  }

  // A property with no type at all is rejected as often as an unknown keyword.
  if (output.type === undefined && output.enum === undefined && output.anyOf === undefined) {
    output.type = output.properties ? "object" : output.items ? "array" : "string";
  }
  return output;
}

/** Narrows a tool's input schema to the subset every provider accepts. */
export function portableSchema(schema: unknown) {
  const root = (schema && typeof schema === "object" ? schema : {}) as Record<string, unknown>;
  const narrowed = narrow(schema ?? { type: "object", properties: {} }, 0, root, new Set());
  if (!narrowed || typeof narrowed !== "object" || Array.isArray(narrowed)) {
    return { type: "object", properties: {} };
  }
  const output = narrowed as Record<string, unknown>;
  if (output.type !== "object") return { type: "object", properties: {} };
  output.properties ??= {};
  return output;
}
