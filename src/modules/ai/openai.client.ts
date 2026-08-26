import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

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

  private structuredCompletionParams(params: {
    systemPrompt: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    schemaName: string;
    schema: Record<string, unknown>;
  }) {
    return {
      model: this.chatModel,
      max_completion_tokens: this.maxOutputTokens,
      messages: [{ role: 'system' as const, content: params.systemPrompt }, ...params.messages],
      response_format: {
        type: 'json_schema' as const,
        json_schema: { name: params.schemaName, schema: params.schema, strict: true },
      },
    };
  }

  /** Chat completion constrained to `schema` via strict structured outputs. */
  async createStructuredCompletion(params: {
    systemPrompt: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    schemaName: string;
    schema: Record<string, unknown>;
  }): Promise<unknown> {
    const completion = await this.require().chat.completions.create(this.structuredCompletionParams(params));

    const choice = completion.choices[0];
    if (choice?.finish_reason === 'length') {
      throw new Error('AI response was truncated before it could be parsed');
    }
    if (choice?.message?.refusal) {
      throw new Error(choice.message.refusal);
    }

    const content = choice?.message?.content;
    if (!content) {
      throw new Error('AI response was empty');
    }
    return JSON.parse(content);
  }

  /** Streams structured JSON content deltas (same schema as {@link createStructuredCompletion}). */
  async *createStructuredCompletionStream(params: {
    systemPrompt: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    schemaName: string;
    schema: Record<string, unknown>;
  }): AsyncGenerator<string> {
    const stream = await this.require().chat.completions.create({
      ...this.structuredCompletionParams(params),
      stream: true,
    });

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.finish_reason === 'length') {
        throw new Error('AI response was truncated before it could be parsed');
      }
      const delta = choice?.delta?.content;
      if (delta) {
        yield delta;
      }
    }
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
