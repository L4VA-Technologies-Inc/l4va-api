import type OpenAI from 'openai';

import { VaultAssistantAction } from '../dto/vault-assistant-action';
import { ResolvedVaultCreationSpec, SpecChain, SpecNetwork } from '../spec/spec.types';

/** Everything a tool is allowed to know about the turn it runs in. */
export interface VaultAiToolContext {
  userId: string;
  chain: SpecChain;
  network: SpecNetwork;
  /** The client draft as received this turn, before any AI proposal for this turn is merged. */
  draft: Record<string, unknown>;
  spec: ResolvedVaultCreationSpec;
}

export interface VaultAiToolOutcome {
  /** JSON-safe payload handed back to the model as the tool result. */
  result: Record<string, unknown>;
  /** UI action surfaced to the frontend. Only set when the tool succeeded. */
  action?: VaultAssistantAction;
}

/**
 * A backend capability the model may ask for by name.
 *
 * The model only ever *requests* a tool: the tool itself re-checks the request against server state
 * and decides what actually happens. Keeping that rule inside `execute` is what lets these tools be
 * exposed over another protocol (e.g. MCP) later without moving any business logic.
 */
export interface VaultAiTool {
  readonly name: string;
  readonly definition: OpenAI.Chat.Completions.ChatCompletionTool;
  execute(context: VaultAiToolContext, args: Record<string, unknown>): Promise<VaultAiToolOutcome>;
}

/** DI token for the array of tools the assistant may use. */
export const VAULT_AI_TOOLS = Symbol('VAULT_AI_TOOLS');
