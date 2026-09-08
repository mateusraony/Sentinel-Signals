// docs/known-risks.md item 136 — real Firestore (client AND admin SDK,
// neither configured with ignoreUndefinedProperties) rejects ANY field with
// a literal `undefined` value on write. A 2-week production outage
// (buildTradeOpData writing `entry_candle_time_4h: undefined` on every
// normal op) happened because nothing else in the write path enforced this
// — this guard existed only inside the test fake
// (src/lib/__fixtures__/fakeBackend.js) until then, so no test could ever
// have caught it. Promoted to a shared module (not test-only) so a future
// Postgres-backed adapter — whose JSONB column silently DROPS `undefined`
// keys instead of throwing — can call the SAME guard before any
// INSERT/UPDATE, closing the same class of bug for a storage engine with
// the opposite default behavior.
// Throws with the same wording Firestore itself uses, so a failure here
// reads the same as a real production crash would.
// Recursive (Codex review, PR #266): Firestore rejects `undefined` at ANY
// depth, not just top-level fields — a nested object (e.g. SystemLog.details)
// or array element with `undefined` inside it crashes the real write exactly
// like a top-level one does. `walk` tracks a dotted/bracketed path so the
// thrown field name still points at the actual offending key, not just the
// top-level container.
export function assertNoUndefinedFields(data, collectionName) {
  function walk(value, path) {
    if (value === undefined) {
      throw new Error(
        `Value for argument "data" is not a valid Firestore document. Cannot use "undefined" as a Firestore value (found in field "${path}"). ` +
        `[collection ${collectionName}] If you want to ignore undefined values, enable \`ignoreUndefinedProperties\`.`
      );
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      for (const [key, nested] of Object.entries(value)) {
        walk(nested, path ? `${path}.${key}` : key);
      }
    }
  }
  for (const [field, value] of Object.entries(data)) {
    walk(value, field);
  }
}
