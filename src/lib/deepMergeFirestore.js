// docs/known-risks.md item 136 (Codex review, PR #267) — Firestore's
// `setDoc(ref, data, {merge:true})` recursively merges nested MAP fields (a
// sibling key under a nested object not mentioned in `data` survives); a
// plain top-level spread instead REPLACES the whole nested object, silently
// diverging from what real Firestore does. Arrays are never merged
// element-wise by Firestore even under `merge:true` — a provided array
// value always fully replaces the existing one, so this only recurses into
// plain objects, never arrays.
// Promoted from src/lib/__fixtures__/fakeBackend.js (test-only) to a shared
// module so a future Postgres-backed adapter can reproduce the SAME merge
// semantics — the JSONB `||` operator is a SHALLOW merge, not recursive,
// so StrategyConfig/TelegramFilters' `set(id, data)` would silently regress
// to "replace nested object" without this.
export function deepMergeFirestore(existing, incoming) {
  const result = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    const existingValue = existing?.[key];
    const bothPlainObjects =
      value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) &&
      existingValue !== null && typeof existingValue === 'object' && !Array.isArray(existingValue) && !(existingValue instanceof Date);
    result[key] = bothPlainObjects ? deepMergeFirestore(existingValue, value) : value;
  }
  return result;
}
