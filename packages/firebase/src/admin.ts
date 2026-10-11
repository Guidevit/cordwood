// How a server reaches Firebase through firebase-admin.
//
// Only the server holds firebase-admin: the browser never opens Firestore, and the client rules deny
// everything. Credentials come from Application Default Credentials, or from the emulators when
// FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are set.
import { type App, getApps, initializeApp } from "firebase-admin/app";
import { type Auth, getAuth } from "firebase-admin/auth";
import { type Firestore, getFirestore } from "firebase-admin/firestore";

/** The process's one app: the one already initialised, or a new one from the environment. */
export function adminApp(): App {
  return getApps()[0] ?? initializeApp();
}

export function firestore(): Firestore {
  return getFirestore(adminApp());
}

/** Firebase Auth as the server sees it: session cookies, custom claims, user management. */
export function auth(): Auth {
  return getAuth(adminApp());
}
