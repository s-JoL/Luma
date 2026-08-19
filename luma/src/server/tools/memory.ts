import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { isMemoryKey, type MemoryCapability } from "@shared/types.ts";
import { countTokens } from "../prompts/context.ts";
import type { Store } from "../store/store.ts";
import {
  DELETE_MEMORY_DESCRIPTION,
  INTENT_DESCRIPTION,
  SET_MEMORY_DESCRIPTION,
  SET_MEMORY_VALUE_DESCRIPTION,
} from "./descriptions.ts";

const MALFORMED_KEY =
  "Keys are 1-64 characters of letters, digits, underscore or hyphen. Rewrite the key and try again.";

export function memoryTools(store: Store, config: MemoryCapability): AgentTool[] {
  if (!config.enabled || !config.writeEnabled) return [];
  const existing = store.listMemories().map((memory) => memory.key);
  // Reuse is a preference, not a rule: naming the keys already in play is what
  // stops the same fact being written twice under two spellings, while leaving
  // the model free to open a subject nobody anticipated.
  const known = [...new Set([...existing, ...config.suggestedKeys])];
  const keyDescription = `A short snake_case name for what this fact is about. Reuse an existing key when the subject matches, and coin a new one when none fits. Keys in use or suggested: ${known.join(", ")}`;
  const deleteKeyDescription = `The key of the memory to delete. Currently stored: ${existing.join(", ") || "nothing yet"}`;
  let currentTotalTokens = store.listMemories().reduce((total, memory) => total + countTokens(memory.value), 0);

  const setMemory: AgentTool = {
    name: "set_memory",
    label: "set_memory",
    description: SET_MEMORY_DESCRIPTION,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        intent: { type: "string", description: INTENT_DESCRIPTION },
        key: { type: "string", description: keyDescription },
        value: { type: "string", description: SET_MEMORY_VALUE_DESCRIPTION },
      },
      required: ["intent", "key", "value"],
    }),
    executionMode: "sequential",
    execute: async (_callId, params) => {
      const { key, value } = params as { key: string; value: string };
      if (!isMemoryKey(key)) {
        return { content: [{ type: "text", text: `Invalid key "${key}". ${MALFORMED_KEY}` }], details: {} };
      }
      if (value.length > config.charLimit) {
        return {
          content: [{ type: "text", text: `Value exceeds maximum length of ${config.charLimit} characters.` }],
          details: {},
        };
      }
      const previous = store.getMemory(key);
      const previousTokens = previous ? countTokens(previous.value) : 0;
      const tokenCount = countTokens(value);
      const nextTotal = currentTotalTokens - previousTokens + tokenCount;
      if (nextTotal > config.tokenLimit) {
        return {
          content: [{ type: "text", text: "Memory storage would exceed limit. Cannot save this memory." }],
          details: {},
        };
      }
      store.upsertMemory(key, value, tokenCount);
      currentTotalTokens = nextTotal;
      return {
        content: [{ type: "text", text: `Memory set for key "${key}" (${tokenCount} tokens)` }],
        details: { structuredContent: { memory: { key, value, tokenCount, type: "update" } } },
      };
    },
  };

  const deleteMemory: AgentTool = {
    name: "delete_memory",
    label: "delete_memory",
    description: DELETE_MEMORY_DESCRIPTION,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        intent: { type: "string", description: INTENT_DESCRIPTION },
        key: { type: "string", description: deleteKeyDescription },
      },
      required: ["intent", "key"],
    }),
    executionMode: "sequential",
    execute: async (_callId, params) => {
      const { key } = params as { key: string };
      if (!isMemoryKey(key)) {
        return { content: [{ type: "text", text: `Invalid key "${key}". ${MALFORMED_KEY}` }], details: {} };
      }
      const previous = store.getMemory(key);
      if (!store.deleteMemory(key)) {
        return { content: [{ type: "text", text: `Failed to delete memory for key "${key}"` }], details: {} };
      }
      if (previous) currentTotalTokens -= countTokens(previous.value);
      return {
        content: [{ type: "text", text: `Memory deleted for key "${key}"` }],
        details: { structuredContent: { memory: { key, type: "delete" } } },
      };
    },
  };

  return [setMemory, deleteMemory];
}
