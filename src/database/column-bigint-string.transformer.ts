/**
 * TypeORM transformer for uint256-shaped DECIMAL(78, 0) columns.
 *
 * Postgres NUMERIC values are returned by pg as JS strings. Round-tripping
 * them through `parseFloat` (see ColumnNumericTransformer) silently truncates
 * anything above Number.MAX_SAFE_INTEGER (2^53 - 1) — a very real footgun for
 * wei / VT base units.
 *
 * This transformer keeps values as strings across the entire DB boundary.
 * Services that need to do math should convert with `BigInt(value)` locally.
 * Never coerce back to `Number`.
 *
 * `to()` accepts bigint / number / string and normalizes to a base-10 string
 * so callers don't have to remember the exact form. For the `number` case we
 * refuse anything that isn't a *safe* integer — anything larger has already
 * lost precision by the time it reaches us, so accepting it would silently
 * store the wrong value. Callers holding large values must pass a `bigint`
 * or a decimal string instead.
 *
 * Values are also validated as unsigned and bounded by uint256 (2^256 − 1).
 */

// 2^256 - 1
const MAX_UINT256 = (1n << 256n) - 1n;

export class ColumnBigintStringTransformer {
  to(value: bigint | number | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;

    let asBigInt: bigint;

    if (typeof value === 'bigint') {
      asBigInt = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error(`Non-finite number cannot be stored as uint256: ${value}`);
      }
      if (!Number.isInteger(value)) {
        throw new Error(`Non-integer number cannot be stored as uint256 (would lose precision): ${value}`);
      }
      if (!Number.isSafeInteger(value)) {
        // Beyond 2^53 the number itself is imprecise — refuse to persist an
        // approximate value. Callers with large amounts must pass bigint/string.
        throw new Error(`Unsafe integer cannot be stored as uint256 (pass bigint or decimal string instead): ${value}`);
      }
      asBigInt = BigInt(value);
    } else {
      // string — validate it parses as a base-10 integer and normalize.
      const trimmed = value.trim();
      if (trimmed === '') return null;
      // BigInt throws on invalid input (e.g. "1.5", "1e3", "0xff").
      asBigInt = BigInt(trimmed);
    }

    if (asBigInt < 0n) {
      throw new Error(`Negative value cannot be stored as uint256: ${asBigInt.toString(10)}`);
    }
    if (asBigInt > MAX_UINT256) {
      throw new Error(`Value exceeds uint256 max (2^256 - 1): ${asBigInt.toString(10)}`);
    }

    return asBigInt.toString(10);
  }

  from(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return value;
  }
}
