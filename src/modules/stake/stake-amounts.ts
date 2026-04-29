export function toHumanAmountString(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const absoluteRaw = negative ? -raw : raw;

  if (decimals === 0) {
    return `${negative ? '-' : ''}${absoluteRaw.toString()}`;
  }

  const scale = 10n ** BigInt(decimals);
  const whole = absoluteRaw / scale;
  const fraction = absoluteRaw % scale;
  const fractionString = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');

  if (fractionString.length === 0) {
    return `${negative ? '-' : ''}${whole.toString()}`;
  }

  return `${negative ? '-' : ''}${whole.toString()}.${fractionString}`;
}

export function toHumanAmountNumber(raw: bigint, decimals: number): number {
  const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafeInteger = BigInt(Number.MIN_SAFE_INTEGER);
  if (raw > maxSafeInteger || raw < minSafeInteger) {
    throw new RangeError('Cannot convert bigint to number without losing precision');
  }

  return Number(raw) / Math.pow(10, decimals);
}
