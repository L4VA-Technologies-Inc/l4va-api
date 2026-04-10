/** Normalizes Cardano asset image/logo field into URL or data URL usable by image pipeline. */
export function normalizeAssetImageSource(raw: string | null | undefined): string | null {
  const MAX_HEX_METADATA_CHARS = 64 * 1024; // 64KB hex text (~32KB decoded bytes)

  if (raw == null || typeof raw !== 'string') {
    return null;
  }

  let s = raw.trim();
  if (!s) {
    return null;
  }

  s = s.replace(/^ipfs:\/\/(ipfs\/)+/, 'ipfs://');
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('ipfs://') || s.startsWith('data:')) {
    return s;
  }

  // Hex-encoded values: Blockfrost sometimes returns on-chain metadata fields as CBOR byte strings
  // in hex form (e.g., "5835697066733a2f2f..." → CBOR prefix 58 35 + "ipfs://...").
  // Hex chars (0-9, a-f) are a strict subset of base64 chars, so we must detect this BEFORE
  // the base64 path to avoid wrapping a valid IPFS URL as a fake data:image/png.
  if (s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) {
    if (s.length > MAX_HEX_METADATA_CHARS) {
      return null;
    }
    try {
      const decoded = Buffer.from(s, 'hex').toString('utf8');
      const urlMatch = decoded.match(/(ipfs:\/\/\S+|https?:\/\/\S+)/i);
      if (urlMatch) {
        return normalizeAssetImageSource(urlMatch[1].trim());
      }
    } catch {
      // Treat undecodable hex-like payloads as invalid image source.
    }
    return null;
  }

  const b64 = s.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64) || b64.length < 32) {
    return null;
  }

  if (b64.startsWith('iVBOR')) {
    return `data:image/png;base64,${b64}`;
  }
  if (b64.startsWith('/9j/')) {
    return `data:image/jpeg;base64,${b64}`;
  }
  if (b64.startsWith('R0lGOD')) {
    return `data:image/gif;base64,${b64}`;
  }
  if (b64.startsWith('UklGR')) {
    return `data:image/webp;base64,${b64}`;
  }

  // SVG often starts with "<svg", but it can also start with an XML prolog / doctype.
  // Decode only a small prefix to avoid large allocations.
  try {
    const prefix = b64.slice(0, 2048);
    const padLen = (4 - (prefix.length % 4)) % 4;
    const paddedPrefix = prefix + '='.repeat(padLen);
    const asText = Buffer.from(paddedPrefix, 'base64').toString('utf8').trimStart().toLowerCase();
    if (asText.startsWith('<?xml') || asText.startsWith('<!doctype') || asText.includes('<svg')) {
      return `data:image/svg+xml;base64,${b64}`;
    }
  } catch {
    // ignore SVG detection failures; fall back to PNG
  }

  return `data:image/png;base64,${b64}`;
}
