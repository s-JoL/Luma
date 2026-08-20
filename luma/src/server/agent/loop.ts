/**
 * The agent loop Runtime talks to. pi is the current implementation; another
 * engine is a second factory that returns this shape. Runtime never constructs
 * pi's `Agent`, never passes pi constructor options, and never subscribes to
 * pi's `AgentEvent` — those stay inside `createPiLoop`.
 */
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export type LoopImage = { type: "image"; data: string; mimeType: string };

/**
 * What a loop must emit. Named for what Runtime does with them. A second engine
 * produces this union; it does not re-export pi's `AgentEvent`.
 */
export type LoopEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: unknown }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: unknown }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

export type LoopListener = (event: LoopEvent) => Promise<void> | void;

export interface AgentLoop {
  prompt(text: string, media: LoopImage[]): Promise<void>;
  continue(): Promise<void>;
  steer(text: string): void;
  abort(): void;
  subscribe(listener: LoopListener): void;
}

/**
 * What Runtime hands a factory. Queueing and tool-execution strategy are the
 * engine's business — `createPiLoop` picks pi's, a second factory picks its own.
 */
export interface LoopStart {
  systemPrompt: string;
  model: Model<never>;
  thinkingLevel: string;
  tools: AgentTool[];
  messages: AgentMessage[];
  sessionId: string;
  stream: StreamFn;
  convertToLlm: (messages: AgentMessage[]) => unknown;
  transformContext: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  onPayload: (payload: unknown) => unknown;
  beforeToolCall: (
    context: { toolCall: { name: string; id: string }; args: unknown },
    signal?: AbortSignal,
  ) => Promise<{ block: true; reason: string } | undefined>;
}

export type LoopFactory = (start: LoopStart) => AgentLoop;

export function createPiLoop(start: LoopStart): AgentLoop {
  const agent = new Agent({
    initialState: {
      systemPrompt: start.systemPrompt,
      model: start.model,
      thinkingLevel: start.thinkingLevel as never,
      tools: start.tools as never,
      messages: start.messages,
    },
    streamFn: start.stream,
    convertToLlm: start.convertToLlm as never,
    transformContext: start.transformContext,
    sessionId: start.sessionId,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    toolExecution: "parallel",
    onPayload: start.onPayload as never,
    beforeToolCall: async (context, signal) =>
      start.beforeToolCall({ toolCall: { name: context.toolCall.name, id: context.toolCall.id }, args: context.args }, signal),
  });
  return {
    prompt: (text, media) => agent.prompt(text, media),
    continue: () => agent.continue(),
    steer: (text) => {
      agent.steer({ role: "user", content: text, timestamp: Date.now() } as AgentMessage);
    },
    abort: () => agent.abort(),
    subscribe: (listener) => {
      agent.subscribe(async (event) => {
        await listener(event as LoopEvent);
      });
    },
  };
}
