// A type-level check. The unit tests compile this file with `tsc --noEmit`; it is never run and never shipped.
//
// It follows one tool-calling turn and one streamed tool call the way a caller writes them, with no cast. If a
// member of the turn loses its type, or a shape that must be refused starts to compile, this file stops compiling.
// Every name and value in it is made up.
import {
  RunInfra,
  RunInfraError,
  RunInfraStreamError,
  RunInfraStreamIncompleteError,
  RunInfraTimeoutError,
  type ChatCompletionMessageToolCall,
  type ChatCompletionRequest,
  type ChatCompletionStreamEvent,
  type ChatCompletionStreamToolCallDelta,
  type ChatMessage,
  type ChatToolMessage,
  type RunInfraStream,
} from "../../src/index";

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

/** One tool-calling loop: ask, run the calls the model names, send their answers back, read the final content. */
export async function toolCallRoundTrip(client: RunInfra): Promise<string | null> {
  const messages: ChatMessage[] = [{ role: "user", content: "What is the weather in Paris?" }];
  for (let turnsLeft = 3; turnsLeft > 0; turnsLeft -= 1) {
    const response = await client.chat.completions.create({
      model: "made-up-model",
      messages,
      tools: [weatherTool],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning_effort: "low",
      prompt_cache_key: "made-up-session",
      top_k: 40,
    });
    const message = response.choices?.[0]?.message;
    if (!message) return null;
    // The whole assistant message goes back, tool calls and all.
    messages.push(message);

    const calls: ChatCompletionMessageToolCall[] | undefined = message.tool_calls;
    if (!calls?.length) {
      const content: string | Array<Record<string, unknown>> | null | undefined = message.content;
      const reasoning: string | null | undefined = message.reasoning;
      return typeof content === "string" ? content : reasoning ?? null;
    }
    for (const call of calls) {
      const callId: string = call.id;
      const name: string = call.function.name;
      const args: unknown = JSON.parse(call.function.arguments);
      const answer: ChatToolMessage = {
        role: "tool",
        tool_call_id: callId,
        content: JSON.stringify({ name, args }),
      };
      messages.push(answer);
    }
  }
  return null;
}

/** A streamed tool call: its pieces share `index`, and the arguments arrive as pieces of one JSON string. */
export async function streamedToolCall(
  stream: RunInfraStream<ChatCompletionStreamEvent>,
): Promise<{ id: string; name: string; argumentsText: string; reasoning: string; finishReason: string | null }> {
  let id = "";
  let name = "";
  let argumentsText = "";
  let reasoning = "";
  let finishReason: string | null = null;
  try {
    for await (const event of stream) {
      const choice = event.choices?.[0];
      const delta = choice?.delta;
      const thinking: string | null | undefined = delta?.reasoning;
      const text: string | null | undefined = delta?.content;
      reasoning += thinking ?? "";
      void text;
      const pieces: ChatCompletionStreamToolCallDelta[] = delta?.tool_calls ?? [];
      for (const piece of pieces) {
        const index: number = piece.index;
        if (index !== 0) continue;
        id ||= piece.id ?? "";
        name += piece.function?.name ?? "";
        argumentsText += piece.function?.arguments ?? "";
      }
      finishReason = choice?.finish_reason ?? finishReason;
    }
  } catch (error) {
    if (error instanceof RunInfraStreamError) {
      const retryable: boolean | undefined = error.retryable;
      const code: string | undefined = error.code;
      void retryable;
      void code;
    } else if (error instanceof RunInfraStreamIncompleteError) {
      const requestId: string | undefined = error.requestId;
      void requestId;
    } else if (error instanceof RunInfraTimeoutError) {
      const clientRequestId: string | undefined = error.clientRequestId;
      void clientRequestId;
    } else if (error instanceof RunInfraError) {
      const retryAfterMs: number | undefined = error.retryAfterMs;
      void retryAfterMs;
    }
    throw error;
  }
  return { id, name, argumentsText, reasoning, finishReason };
}

// An assistant message may carry only tool calls, with its content null or left out.
export const assistantWithNullContent: ChatMessage = {
  role: "assistant",
  content: null,
  tool_calls: [{ id: "call_made_up", type: "function", function: { name: "get_weather", arguments: "{}" } }],
};
export const assistantWithoutContent: ChatMessage = {
  role: "assistant",
  tool_calls: [{ id: "call_made_up", type: "function", function: { name: "get_weather", arguments: "{}" } }],
};
export const developerMessage: ChatMessage = { role: "developer", content: "Answer in one sentence." };

// The request fields typed since 0.3.1 are members of the request type.
export const requestWithNewFields: ChatCompletionRequest = {
  model: "made-up-model",
  messages: [assistantWithNullContent],
  top_k: 40,
  min_p: 0.05,
  repetition_penalty: 1.1,
  n: 2,
  best_of: 2,
  logit_bias: { "1234": -5 },
  parallel_tool_calls: false,
  reasoning_effort: "none",
  reasoning: { effort: "low", enabled: true, exclude: false },
  include_reasoning: false,
  prompt_cache_key: "made-up-session",
  service_tier: "default",
  store: false,
  safety_identifier: "made-up-user",
  modalities: ["text"],
  audio: { voice: "made-up-voice" },
  prediction: { type: "content", content: "made up" },
  verbosity: "low",
  web_search_options: {},
  moderation: { made_up: true },
  functions: [{ name: "made_up_function" }],
  function_call: "auto",
};

// @ts-expect-error A tool message must name the call it answers.
export const toolMessageWithoutCallId: ChatToolMessage = { role: "tool", content: "{}" };

export const callWithObjectArguments: ChatCompletionMessageToolCall = {
  id: "call_made_up",
  type: "function",
  // @ts-expect-error A call's arguments are a JSON string, not an object.
  function: { name: "get_weather", arguments: { city: "Paris" } },
};

export const requestWithUnknownField: ChatCompletionRequest = {
  model: "made-up-model",
  messages: [],
  // @ts-expect-error The request type stays closed: a field it does not name is refused.
  made_up_field: true,
};

export const requestWithWrongFieldType: ChatCompletionRequest = {
  model: "made-up-model",
  messages: [],
  // @ts-expect-error parallel_tool_calls is a boolean.
  parallel_tool_calls: "no",
};
