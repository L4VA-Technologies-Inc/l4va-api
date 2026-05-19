/** Cardano CIP-20 / label-674 `msg` field: max 64 characters per chunk. */
export const CIP674_MAX_CHUNK_LENGTH = 64;

export type Cip674MetadataMessage = { msg: string[] };

/** Splits a string into ≤64-char chunks, preferring breaks at whitespace. */
export function chunkCip674Message(
  raw: string,
  options?: { maxChunkLength?: number; minSpaceBreakIndex?: number }
): string[] {
  const maxLen = options?.maxChunkLength ?? CIP674_MAX_CHUNK_LENGTH;
  const minSpaceBreak = options?.minSpaceBreakIndex ?? 40;

  const chunks: string[] = [];
  let remaining = raw;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = maxLen;
    const searchSpace = remaining.slice(0, maxLen + 1);
    const lastSpace = searchSpace.lastIndexOf(' ');
    if (lastSpace > minSpaceBreak) {
      breakPoint = lastSpace;
    }

    chunks.push(remaining.slice(0, breakPoint).trimEnd());
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

/** Builds `{ msg: string[] }` for `.attachMetadata(674, …)`. */
export function formatCip674MetadataMessage(raw: string): Cip674MetadataMessage {
  return { msg: chunkCip674Message(raw) };
}
