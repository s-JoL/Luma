import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { encodeForModel, locateImage } from "../images.ts";
import type { Store } from "../store/store.ts";
import { INTENT_DESCRIPTION } from "./descriptions.ts";

/**
 * Loads one picture into the conversation.
 *
 * History carries images as `[image image_id=…]` lines rather than pixels, so
 * looking is something the model does when it decides the answer depends on
 * what is in the frame. That is the whole point: Luma has no way to know from
 * the wording of a turn which picture matters, and the model does.
 *
 * The result is not persisted as an image, so a second turn that needs the same
 * picture asks again. Paying per look is what keeps a hundred-turn conversation
 * from carrying a hundred images it stopped caring about.
 */
export function viewImageTool(store: Store): AgentTool {
  return {
    name: "view_image",
    label: "view_image",
    description:
      "Look at an image that already exists — one the user uploaded, one you generated, or one named by an [image image_id=…] line earlier in the conversation. Copy the image_id exactly. Call this whenever your answer depends on what the picture actually shows; editing an image does not require it, because edit_image reads the pixels itself.",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        intent: { type: "string", description: INTENT_DESCRIPTION },
        image_id: { type: "string", description: "The exact image_id to look at." },
      },
      required: ["intent", "image_id"],
    }),
    execute: async (_callId, params) => {
      const id = String((params as { image_id?: unknown })?.image_id ?? "").trim();
      const located = locateImage(store, id);
      const encoded = located && (await encodeForModel(id, located.diskPath, located.mime));
      if (!encoded) {
        return {
          content: [
            {
              type: "text" as const,
              text: `There is no readable image ${id}. Copy an image_id exactly as it appears in the conversation.`,
            },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text" as const, text: `Image ${id}.` }, { type: "image" as const, ...encoded }],
        details: {},
      };
    },
  };
}
