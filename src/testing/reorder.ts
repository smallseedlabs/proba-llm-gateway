/** Rebuilds an object with keys in reverse order at every depth, like a JSONB round trip can. */
export function reverseKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeysDeep) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      out[key] = reverseKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}
