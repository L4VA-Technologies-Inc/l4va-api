/**
 * Reads a JSON string property from an incomplete JSON document while it streams.
 * Returns the decoded value so far, or null if the property has not started yet.
 */
export function extractPartialJsonString(jsonSoFar: string, property: string): string | null {
  const marker = `"${property}"`;
  const markerIndex = jsonSoFar.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  let index = jsonSoFar.indexOf(':', markerIndex + marker.length);
  if (index === -1) {
    return null;
  }

  index += 1;
  while (index < jsonSoFar.length && /\s/.test(jsonSoFar[index])) {
    index += 1;
  }

  if (jsonSoFar[index] !== '"') {
    return null;
  }
  index += 1;

  let result = '';
  while (index < jsonSoFar.length) {
    const char = jsonSoFar[index];
    if (char === '\\') {
      if (index + 1 >= jsonSoFar.length) {
        break;
      }
      const next = jsonSoFar[index + 1];
      if (next === 'n') {
        result += '\n';
      } else if (next === 't') {
        result += '\t';
      } else if (next === 'r') {
        result += '\r';
      } else if (next === '"' || next === '\\' || next === '/') {
        result += next;
      } else if (next === 'u') {
        if (index + 5 >= jsonSoFar.length) {
          break;
        }
        result += String.fromCharCode(Number.parseInt(jsonSoFar.slice(index + 2, index + 6), 16));
        index += 6;
        continue;
      } else {
        result += next;
      }
      index += 2;
      continue;
    }
    if (char === '"') {
      break;
    }
    result += char;
    index += 1;
  }

  return result;
}
