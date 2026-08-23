export function indexById<T extends { id: string }>(items: T[]): ReadonlyMap<string, T> {
  if (items.length === 0) throw new Error("Adapter registry cannot be empty.");

  const entries = new Map<string, T>();
  for (const item of items) {
    if (!item.id || entries.has(item.id)) {
      throw new Error(`Adapter registry contains an empty or duplicate id: ${item.id}`);
    }
    entries.set(item.id, item);
  }
  return entries;
}
