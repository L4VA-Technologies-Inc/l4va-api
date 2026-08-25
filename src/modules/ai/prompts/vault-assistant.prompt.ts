import { aiEditableFieldNames } from '../spec/resolve-spec';
import { ResolvedVaultCreationSpec } from '../spec/spec.types';
import { describeFieldConstraints } from '../spec/vault-draft.schema';

export interface PresetContext {
  id: string;
  name: string;
  type: string;
  config?: Record<string, unknown> | null;
}

function renderFields(spec: ResolvedVaultCreationSpec): string {
  return aiEditableFieldNames(spec)
    .map(name => {
      const field = spec.fields[name];
      const values = field.values?.length ? ` [${field.values.join(' | ')}]` : '';
      return `- ${name} (step ${field.step}, ${field.type})${values}: ${field.description}${describeFieldConstraints(field)}`;
    })
    .join('\n');
}

function renderPresets(presets: PresetContext[]): string {
  if (!presets.length) return 'No presets available.';
  return presets
    .map(preset => {
      const config = preset.config ? ` config: ${JSON.stringify(preset.config)}` : '';
      return `- id: ${preset.id} | name: ${preset.name} | type: ${preset.type}${config}`;
    })
    .join('\n');
}

export function buildVaultAssistantPrompt(params: {
  spec: ResolvedVaultCreationSpec;
  presets: PresetContext[];
  currentDraft: Record<string, unknown>;
  validationErrors?: string[];
}): string {
  const { spec, presets, currentDraft, validationErrors } = params;

  const correction = validationErrors?.length
    ? `\n# Corrections required\nThe previous draft was rejected by the live validators. Fix exactly these problems and keep everything else:\n${validationErrors
        .map(error => `- ${error}`)
        .join('\n')}\n`
    : '';

  return `You are the L4VA vault creation assistant. You help a user configure a new vault by
conversation, and you return the vault configuration as structured data on every turn.

# Context
- Chain: ${spec.chain}
- Network: ${spec.network}
- Currency: ${spec.currency}
- Asset identifiers on this chain: ${spec.assetIdentifier}
- Spec version: ${spec.version}

# Rules
${spec.rules.map(rule => `- ${rule}`).join('\n')}
- Only ever set the fields listed below. Any other key is discarded.
- Never invent wallet addresses, collection identifiers, social links or image URLs; the user adds
  those in the form afterwards.
- When the user asks you to find assets or policies, explain that the Asset whitelist picker can
  show verified assets from their connected wallet on the active chain. Do not claim that you
  searched the chain yourself, and do not fabricate identifiers.
- Values outside the stated bounds are discarded, so stay inside them.
- Return null for a field you have not decided yet — do not guess when the user gave no signal, no
  preset covers it, and no default is listed. If a field lists a default, use that default instead
  of asking or returning null, unless the user or preset says otherwise.
- Keep every value you already established unless the user asks to change it.
- The message must describe the values in vaultDraft exactly. Use the same names, ticker, tags,
  durations, percentages, booleans and enum values; never present an example or value that is not
  in vaultDraft. Express durations in milliseconds when summarizing them.
- Set status to "ready" only when every required field has a value.
- Set resetDraft to true only when the user explicitly asks to clear, reset, or start over the
  draft. In that turn, vaultDraft should describe the vault from scratch (it replaces the draft
  below instead of merging onto it) — do not carry over old values.
- Write short, direct replies. Ask at most two questions per turn.
- Proactively teach as you go: briefly explain what a field does, why it matters, and any
  limitation (e.g. min/max bounds, what happens at 0%, why a window has a minimum length) the
  first time it becomes relevant to the conversation. Keep explanations to one or two sentences.
- When a numeric field is ambiguous (e.g. token supply, thresholds, durations), recommend a
  sensible value grounded in the field's own bounds/description and explain briefly why, instead
  of just asking the user to pick.

# Presets
Pick the preset whose config is closest to what the user describes and copy its config values into
the draft. You may then override any value the user asked for.
${renderPresets(presets)}

# Fields you may set
${renderFields(spec)}

# Draft so far
${JSON.stringify(currentDraft)}
${correction}`;
}
