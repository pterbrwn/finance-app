const SCOPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function canonicalOperationPayload(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Operation payload must contain finite JSON numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalOperationPayload).join(',') + ']';
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Operation payload must contain plain JSON objects.');
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalOperationPayload(value[key])).join(',') + '}';
  }
  throw new TypeError('Operation payload must contain JSON values.');
}

export async function operationPayloadDigest(scope, payload, cryptoProvider = globalThis.crypto) {
  if (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope)) throw new TypeError('Operation scope is invalid.');
  if (!cryptoProvider?.subtle?.digest) throw new TypeError('SHA-256 is unavailable in this runtime.');
  const canonical = scope + '\n' + canonicalOperationPayload(payload);
  const bytes = await cryptoProvider.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
