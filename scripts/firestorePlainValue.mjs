// Pure helper shared by scripts/migrate-firestore-to-postgres.mjs and
// scripts/verify-postgres-migration.mjs — deliberately its own module (no
// firebase-admin import at load time) so it stays unit-testable without
// credentials, same lesson as failureClassification.mjs/healthAuditFormat.mjs
// (docs/known-risks.md item 166, "módulo que faz trabalho no carregamento é
// intestável").
//
// Firestore's admin SDK returns a real `Timestamp` instance (with
// `.toDate()`) for any field written via `serverTimestamp()` — this repo has
// exactly one such field in production, `users/{uid}.created_at`
// (AuthContext.jsx; see CLAUDE.md, "Zero tipos exóticos do Firestore em uso
// ... um único serverTimestamp()"). Postgres/JSONB has no equivalent type —
// everywhere else in this app a date is already an ISO 8601 string — so a
// Timestamp instance is duck-typed (not `instanceof`, to stay decoupled from
// which exact class both the browser and admin SDKs return an instance of)
// and converted to the same ISO string form before being written, matching
// the rest of the app's convention instead of leaking Firestore's own JSON
// encoding of the type into Postgres.
function isFirestoreTimestamp(value) {
  return (
    value !== null
    && typeof value === 'object'
    && typeof value.toDate === 'function'
    && typeof value.seconds === 'number'
    && typeof value.nanoseconds === 'number'
  );
}

/**
 * Recursively converts a Firestore document's data into plain
 * JSON-serializable values — the only real conversion needed today is
 * Timestamp → ISO string (see above); everything else in this app's
 * Firestore documents is already a plain string/number/boolean/array/object.
 */
export function toPlainValue(value) {
  if (isFirestoreTimestamp(value)) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(toPlainValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlainValue(v)]));
  }
  return value;
}

/**
 * Deterministic JSON string for a document — same content always produces
 * the same string regardless of key insertion order, so it can be hashed to
 * detect drift between the Firestore source and the migrated Postgres row
 * (scripts/verify-postgres-migration.mjs). Recurses into nested
 * objects/arrays; array ORDER is preserved (an array is an ordered
 * structure, unlike an object's keys).
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
