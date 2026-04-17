/**
 * Normalizes errors thrown by Lucid / cardano-cli submit/build into a user-friendly message.
 *
 * The error often arrives as:
 * - a plain object: `{ Complete: "failed script execution ..." }`
 * - an Error whose `.message` is a JSON string (sometimes prefixed with "Error: " or truncated)
 *
 * This helper is intentionally regex-first to stay resilient even when the JSON is not valid.
 */
export function normalizeLucidCardanoError(error: unknown, fallback: string): string {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null
          ? // Lucid can throw plain objects (e.g. { Complete: "..." })
            JSON.stringify(error)
          : '';

  const objComplete =
    typeof error === 'object' && error !== null
      ? ((error as any).Complete ?? (error as any).complete ?? (error as any).message ?? null)
      : null;

  const text = (typeof objComplete === 'string' && objComplete.length > 0 ? objComplete : raw).trim();
  if (!text) return fallback;

  // Common mempool/submit failure: inputs already spent / tx already included.
  if (/All inputs are spent/i.test(text)) {
    return 'Transaction already submitted or inputs already spent. Please rebuild and try again.';
  }

  // Extract quoted inner reason when present (works even if the surrounding JSON is truncated).
  const conwayMatch =
    text.match(/ConwayMempoolFailure\s+\\?"([^"]+)\\?"/) || text.match(/ConwayMempoolFailure\s+([^,}]+)/);
  if (conwayMatch?.[1]) {
    const inner = conwayMatch[1].trim();
    if (/All inputs are spent/i.test(inner)) {
      return 'Transaction already submitted or inputs already spent. Please rebuild and try again.';
    }
    return inner;
  }

  // Build/complete-time script validation failures.
  if (/failed script execution/i.test(text) || /validator crashed/i.test(text) || /exited prematurely/i.test(text)) {
    return 'Transaction failed script validation. Please double-check selected UTxOs and try again.';
  }

  // Fallback: try to extract first string inside `"error":[ "..."]` if present.
  const errorArrayFirst = text.match(/"error"\s*:\s*\[\s*"([^"]+)"/);
  if (errorArrayFirst?.[1]) {
    const inner = errorArrayFirst[1];
    if (/All inputs are spent/i.test(inner)) {
      return 'Transaction already submitted or inputs already spent. Please rebuild and try again.';
    }
    return inner;
  }

  // As last resort, return the original message if it isn't an unreadable blob.
  // Avoid returning megabytes; keep it short-ish.
  const short = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return short || fallback;
}
