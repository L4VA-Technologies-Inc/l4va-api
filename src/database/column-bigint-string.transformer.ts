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
 * so callers don't have to remember the exact form.
 */
export class ColumnBigintStringTransformer {
  to(value: bigint | number | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return value.toString(10);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(`Non-finite number cannot be stored as uint256: ${value}`);
      if (!Number.isInteger(value)) {
        throw new Error(`Non-integer number cannot be stored as uint256 (would lose precision): ${value}`);
      }
      return value.toString(10);
    }
    // string — validate it parses as a base-10 integer and normalize (drop leading zeros, sign).
    const trimmed = value.trim();
    if (trimmed === '') return null;
    // BigInt throws on invalid input.
    return BigInt(trimmed).toString(10);
  }

  from(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return value;
  }
}
