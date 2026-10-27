import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model; callers must parse defensively. */
  arguments: string;
}

/** One completed assistant turn: either content, tool calls, or (rarely) both. */
export interface ChatTurn {
  content: string | null;
  toolCalls: ChatToolCall[];
}

export interface ChatTurnParams {
  messages: ChatMessage[];
  /** Constrains `content` to this schema via strict structured outputs. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  tools?: ChatTool[];
  toolChoice?: 'auto' | 'none';
}

export type ChatStreamEvent =
  | { type: 'content'; delta: string }
  /** Emitted as soon as the model starts requesting a tool, before any arguments have arrived. */
  | { type: 'tool_call_started'; name: string }
  | { type: 'turn'; turn: ChatTurn };

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Thin wrapper over the OpenAI Chat Completions API.
 *
 * Deliberately domain-agnostic: it knows about structured output and tool calls, not about vaults.
 * Orchestration (which tools exist, what to do with a tool call) lives in the calling service.
 */
@Injectable()
export class OpenAiClient {
  private readonly logger = new Logger(OpenAiClient.name);
  private readonly client: OpenAI | null;
  private readonly chatModel: string;
  private readonly imageModel: string;
  private readonly maxOutputTokens: number;

  constructor(configService: ConfigService) {
    const apiKey = configService.get<string>('OPENAI_API_KEY');
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.chatModel = configService.get<string>('OPENAI_CHAT_MODEL') || 'gpt-4o-mini';
    this.imageModel = configService.get<string>('OPENAI_IMAGE_MODEL') || 'gpt-image-1';
    this.maxOutputTokens = Number(configService.get<string>('OPENAI_MAX_OUTPUT_TOKENS') || '2000');

    if (!this.client) {
      this.logger.warn('OPENAI_API_KEY is not set — AI vault assistant endpoints will return 503');
    }
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  private require(): OpenAI {
    if (!this.client) {
      throw new ServiceUnavailableException('AI assistant is not configured');
    }
    return this.client;
  }

  // Return type is inferred on purpose: the object must stay assignable to both the streaming and
  // non-streaming create() overloads, which no single named SDK type covers.
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  private completionParams(params: ChatTurnParams) {
    return {
      model: this.chatModel,
      max_completion_tokens: this.maxOutputTokens,
      messages: params.messages,
      ...(params.jsonSchema
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: { name: params.jsonSchema.name, schema: params.jsonSchema.schema, strict: true },
            },
          }
        : {}),
      ...(params.tools?.length ? { tools: params.tools, tool_choice: params.toolChoice ?? 'auto' } : {}),
    };
  }

  /** One non-streamed assistant turn. */
  async createChatTurn(params: ChatTurnParams): Promise<ChatTurn> {
    const completion = await this.require().chat.completions.create(this.completionParams(params));

    const choice = completion.choices[0];
    if (choice?.finish_reason === 'length') {
      throw new Error('AI response was truncated before it could be parsed');
    }
    if (choice?.message?.refusal) {
      throw new Error(choice.message.refusal);
    }

    const toolCalls = (choice?.message?.tool_calls ?? []).flatMap(call =>
      call.type === 'function' ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }] : []
    );

    return { content: choice?.message?.content ?? null, toolCalls };
  }

  /**
   * Streams one assistant turn: content deltas as they arrive, then a final `turn` event with the
   * fully assembled content and tool calls (tool-call arguments stream in fragments and are only
   * usable once complete, so they are never yielded incrementally).
   */
  async *streamChatTurn(params: ChatTurnParams): AsyncGenerator<ChatStreamEvent> {
    const stream = await this.require().chat.completions.create({
      ...this.completionParams(params),
      stream: true,
    });

    let content = '';
    const toolCalls = new Map<number, ToolCallAccumulator>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.finish_reason === 'length') {
        throw new Error('AI response was truncated before it could be parsed');
      }
      if (choice?.delta?.refusal) {
        throw new Error(choice.delta.refusal);
      }

      const delta = choice?.delta?.content;
      if (delta) {
        content += delta;
        yield { type: 'content', delta };
      }

      for (const call of choice?.delta?.tool_calls ?? []) {
        const existing = toolCalls.get(call.index);
        if (!existing) {
          const started: ToolCallAccumulator = {
            id: call.id ?? '',
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '',
          };
          toolCalls.set(call.index, started);
          yield { type: 'tool_call_started', name: started.name };
          continue;
        }
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name = call.function.name;
        if (call.function?.arguments) existing.arguments += call.function.arguments;
      }
    }

    yield {
      type: 'turn',
      turn: {
        content: content || null,
        toolCalls: [...toolCalls.values()].filter(call => call.name),
      },
    };
  }

  /** Returns the raw image bytes for `prompt`. */
  async generateImage(prompt: string): Promise<Buffer> {
    const result = await this.require().images.generate({
      model: this.imageModel,
      prompt,
      n: 1,
      size: '1024x1024',
    });

    const encoded = result.data?.[0]?.b64_json;
    if (!encoded) {
      throw new Error('Image generation returned no data');
    }
    return Buffer.from(encoded, 'base64');
  }
}
