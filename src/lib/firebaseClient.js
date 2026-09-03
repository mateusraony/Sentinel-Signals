import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);
// Realtime Database complement (docs/known-risks.md item 152) — read-only
// mirror for the dashboard's polling reads, never for TradeOperation
// mutation. Undefined/empty databaseURL (RTDB not provisioned yet in this
// environment) leaves rtdb as null instead of throwing — src/api/entities.js
// and src/api/rtdbEntities.js both guard on this, so the app keeps working
// 100% on Firestore until the Realtime Database is created and the env var
// is set (see .claude/rules/firestore-concurrency.md).
export const rtdb = firebaseConfig.databaseURL ? getDatabase(app) : null;
export default app;
