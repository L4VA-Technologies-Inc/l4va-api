import { Inject, Injectable, Logger } from '@nestjs/common';
import type OpenAI from 'openai';

import { VAULT_AI_TOOLS, VaultAiTool, VaultAiToolContext, VaultAiToolOutcome } from './vault-ai-tool.types';

/**
 * Name → tool lookup plus the safe execution path around it.
 *
 * A new capability is added by writing a `VaultAiTool` and listing it in the module providers; no
 * orchestration code changes.
 */
@Injectable()
export class VaultAiToolRegistry {
  private readonly logger = new Logger(VaultAiToolRegistry.name);
  private readonly tools = new Map<string, VaultAiTool>();

  constructor(@Inject(VAULT_AI_TOOLS) tools: VaultAiTool[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  get definitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return [...this.tools.values()].map(tool => tool.definition);
  }

  /**
   * Runs the requested tool. Never throws: an unknown name, unparseable arguments or a failing tool
   * all come back as a result the model can read and react to, so one bad call cannot kill the turn.
   */
  async execute(name: string, context: VaultAiToolContext, rawArguments: string): Promise<VaultAiToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      this.logger.warn(`Model requested unknown tool "${name}"`);
      return { result: { ok: false, reason: 'unknown_tool', name } };
    }

    let args: Record<string, unknown>;
    try {
      const parsed = rawArguments?.trim() ? JSON.parse(rawArguments) : {};
      args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return { result: { ok: false, reason: 'invalid_arguments', name } };
    }

    try {
      return await tool.execute(context, args);
    } catch (error) {
      this.logger.error(`Tool "${name}" failed: ${(error as Error).message}`);
      return { result: { ok: false, reason: 'tool_error', name } };
    }
  }
}
