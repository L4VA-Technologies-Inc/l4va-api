import { aiEditableFieldNames } from './resolve-spec';
import { ResolvedVaultCreationSpec, VaultFieldSpec } from './spec.types';

interface JsonSchemaProperty {
  type: string[] | string;
  description: string;
  enum?: (string | null)[];
  items?: { type: string; enum?: readonly string[] };
}

/** Human-readable bounds appended to each property description (JSON Schema numeric
 * keywords are not supported by OpenAI structured outputs, so bounds live in prose). */
export function describeFieldConstraints(field: VaultFieldSpec): string {
  const parts: string[] = [];
  if (field.unit) parts.push(`unit: ${field.unit}`);
  if (field.min !== undefined) parts.push(`min: ${field.min}`);
  if (field.max !== undefined) parts.push(`max: ${field.max}`);
  if (field.minLength !== undefined) parts.push(`min length: ${field.minLength}`);
  if (field.maxLength !== undefined) parts.push(`max length: ${field.maxLength}`);
  if (field.pattern) parts.push(`pattern: ${field.pattern}`);
  if (field.default !== undefined) parts.push(`default: ${String(field.default)}`);
  if (field.required) parts.push('required');
  if (field.requiredWhen) parts.push(`required when ${field.requiredWhen}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function jsonTypeFor(field: VaultFieldSpec): string {
  switch (field.type) {
    case 'integer':
      return 'integer';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enumArray':
      return 'array';
    default:
      return 'string';
  }
}

/**
 * Strict JSON schema for the vault draft the model returns.
 *
 * Structured outputs require every property to be listed in `required`, so optional fields
 * are expressed as nullable and a `null` value means "not decided yet".
 */
export function buildVaultDraftJsonSchema(
  spec: ResolvedVaultCreationSpec,
  options: { presetIds?: string[] } = {}
): Record<string, unknown> {
  const properties: Record<string, JsonSchemaProperty> = {};
  const names = aiEditableFieldNames(spec);

  for (const name of names) {
    const field = spec.fields[name];
    const description = `${field.description}${describeFieldConstraints(field)}`;

    if (field.type === 'enumArray') {
      properties[name] = {
        type: ['array', 'null'],
        description,
        items: { type: 'string', enum: field.values ?? [] },
      };
      continue;
    }

    const enumValues =
      name === 'preset_id' && options.presetIds?.length ? options.presetIds : (field.values as string[] | undefined);

    properties[name] = {
      type: [jsonTypeFor(field), 'null'],
      description,
      ...(enumValues ? { enum: [...enumValues, null] } : {}),
    };
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: ['message', 'status', 'missingFields', 'vaultDraft', 'resetDraft'],
    properties: {
      message: {
        type: 'string',
        description: 'Reply shown to the user in the chat. Ask for whatever is still missing.',
      },
      status: {
        type: 'string',
        enum: ['gathering', 'ready'],
        description: '"ready" only when every required field has a value and the user confirmed the summary.',
      },
      missingFields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names of required fields still without a value.',
      },
      resetDraft: {
        type: 'boolean',
        description:
          'Set to true only when the user explicitly asks to clear/reset/start over the draft. When true, vaultDraft is applied to a blank draft instead of merged onto the existing one.',
      },
      vaultDraft: {
        type: 'object',
        additionalProperties: false,
        required: names,
        properties,
      },
    },
  };
}
