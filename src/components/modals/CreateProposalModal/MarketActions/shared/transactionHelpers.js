import { transactionOptionSchema, buyOptionSchema } from '@/components/vaults/constants/proposal.constants.js';

/**
 * Validates an array of transaction options against the appropriate schema
 * @param {Array} options - Array of transaction options to validate
 * @param {boolean} isBuyType - Whether these are buy options (true) or sell options (false)
 * @returns {boolean} - True if all options are valid, false otherwise
 */
export const validateOptions = (options, isBuyType = false) => {
  if (options.length === 0) return false;

  const schema = isBuyType ? buyOptionSchema : transactionOptionSchema;

  try {
    options.forEach(option => {
      schema.validateSync(option);
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Validates a single transaction option against the appropriate schema
 * @param {Object} option - Transaction option to validate
 * @param {boolean} isBuyType - Whether this is a buy option (true) or sell option (false)
 * @returns {boolean} - True if the option is valid, false otherwise
 */
export const validateOption = (option, isBuyType = false) => {
  if (!option) return false;

  const schema = isBuyType ? buyOptionSchema : transactionOptionSchema;

  try {
    schema.validateSync(option);
    return true;
  } catch {
    return false;
  }
};

/**
 * Formats and validates price input to ensure it's a valid decimal with max 2 decimal places
 * @param {string} value - The input value to format
 * @returns {string} - The formatted value
 */
export const formatPriceInput = value => {
  // Handle multiple decimal points
  let formattedValue = value;
  const parts = value.split('.');
  if (parts.length > 2) {
    formattedValue = parts[0] + '.' + parts.slice(1).join('');
  }

  // Limit to 2 decimal places
  if (formattedValue.includes('.')) {
    const [int, dec] = formattedValue.split('.');
    formattedValue = int + '.' + dec.slice(0, 2);
  }

  return formattedValue;
};

/**
 * Extracts policy id from a Cardano asset unit (first 56 hex chars)
 * @param {string} unit - Asset unit entered by the user
 * @returns {string} - Lowercased policy id or empty string when invalid
 */
export const extractPolicyIdFromUnit = unit => {
  if (!unit || typeof unit !== 'string') return '';

  const normalizedUnit = unit.trim();
  if (normalizedUnit.length < 56) return '';
  if (!/^[a-fA-F0-9]+$/.test(normalizedUnit)) return '';

  return normalizedUnit.substring(0, 56).toLowerCase();
};

/**
 * Checks whether a policy id exists in vault assets whitelist
 * @param {string} policyId - Extracted policy id
 * @param {Array} assetsWhitelist - Vault assetsWhitelist
 * @returns {boolean}
 */
export const isPolicyWhitelisted = (policyId, assetsWhitelist = []) => {
  if (!policyId || !Array.isArray(assetsWhitelist) || assetsWhitelist.length === 0) return false;

  return assetsWhitelist.some(item => (item?.policyId || '').toLowerCase() === policyId.toLowerCase());
};

/**
 * Validates a single buy option including whitelist policy check
 * @param {Object} option - Buy option
 * @param {Array} assetsWhitelist - Vault assetsWhitelist
 * @returns {boolean}
 */
export const validateBuyOptionWithWhitelist = (option, assetsWhitelist = []) => {
  if (!validateOption(option, true)) return false;

  const policyId = extractPolicyIdFromUnit(option?.assetId);
  return isPolicyWhitelisted(policyId, assetsWhitelist);
};

/**
 * Validates buy options including whitelist policy checks
 * @param {Array} options - Buy options
 * @param {Array} assetsWhitelist - Vault assetsWhitelist
 * @returns {boolean}
 */
export const validateBuyOptionsWithWhitelist = (options, assetsWhitelist = []) => {
  if (!validateOptions(options, true)) return false;

  return options.every(option => validateBuyOptionWithWhitelist(option, assetsWhitelist));
};
