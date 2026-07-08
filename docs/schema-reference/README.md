# Schema reference

These `.jsonc` files are the original entity schema definitions exported from the
Base44 no-code builder that this project used to run on. They're kept here as a
historical reference for the Firestore data model — each file name maps to a
Firestore collection in `firestore.rules` / `src/api/entities.js` (e.g.
`MonitoredAsset.jsonc` → `monitoredAssets`). They are documentation only and are
not read by the app at runtime.
