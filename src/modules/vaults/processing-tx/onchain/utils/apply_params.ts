// @ts-nocheck
import { Buffer } from 'node:buffer';

import { applyParamsToScript } from '@blaze-cardano/uplc';
import { PlutusScript, EnterpriseAddress, ScriptHash, Credential } from '@emurgo/cardano-serialization-lib-nodejs';

const blueprint = require('./blueprint.json');

export function applyContributeParams(input: { vault_policy_id: string; vault_id: string }): {
  validator: any;
  address: EnterpriseAddress;
} {
  const contributeValidator = blueprint.validators.find(v => v.title === 'contribute.contribute');
  if (!contributeValidator) {
    throw new Error('Contribute validator not found');
  }
  const paramsSchemaItems: any[] = [];
  const parameters = contributeValidator.handlers[0].parameters;
  if (!parameters) {
    throw new Error('No parameters found');
  }
  for (let i = 0; i < parameters.length; i++) {
    const param = parameters[i];
    const shape = defineShape(param.schema, blueprint.definitions);

    paramsSchemaItems.push(shape);
  }

  const scriptHex = applyParamsToScript(contributeValidator.compiledCode, [input.vault_policy_id, input.vault_id], {
    dataType: 'list',
    items: paramsSchemaItems,
  }).toString();

  const scriptCsl = PlutusScript.new_v3(Buffer.from(scriptHex, 'hex'));
  const scriptHash = scriptCsl.hash().to_hex();

  const scriptAddress = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(scriptHash)));

  return {
    validator: {
      ...contributeValidator,
      hash: scriptHash,
      compiledCode: scriptHex,
    },
    address: scriptAddress,
  };
}

export function defineShape(schema: any, definitions: any) {
  if (!('$ref' in schema)) {
    return schema;
  }
  const refKey = schema.$ref.replaceAll('~1', '/').replace('#/definitions/', '');
  if (refKey in definitions) {
    return defineShape(definitions[refKey], definitions);
  }

  // Infer missing list item schema from list schema
  // @see https://github.com/aiken-lang/aiken/issues/1086
  // TODO Remove once aiken bug is fixed
  const associativeListKey = `List$${refKey}`;
  if (associativeListKey in definitions) {
    const shape = defineShape(definitions[associativeListKey], definitions);
    return {
      dataType: '#pair',
      left: shape.keys,
      right: shape.values,
    };
  }

  return new Error(`Unable to find definition for schema ${refKey}`);
}

export function toPreloadedScript({ definitions, ...preamble }: any, opts: any = {}) {
  const validators: any[] = [];
  for (const { handlers: validatorHandlers, ...validator } of opts.validators ?? []) {
    let handlers: any[] | undefined = undefined;
    if (Array.isArray(validatorHandlers)) {
      handlers = validatorHandlers;
    } else if (validatorHandlers) {
      handlers = Object.values(validatorHandlers);
    } else if (opts.handlers) {
      handlers = opts.handlers?.filter(h => h.validatorHash === validator.hash);
    }

    for (const handler of handlers ?? []) {
      validators.push({
        ...validator,
        title: `${validator.title}.${handler.purpose}`,
        datum: handler.datum,
        redeemer: handler.redeemer,
        parameters: handler.parameters,
      });
    }
  }

  const blueprint = {
    preamble,
    definitions: definitions,
    validators,
  };

  return {
    type: 'plutus',
    blueprint,
  };
}
