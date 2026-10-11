# @cordwood/firebase

The server's way into Firebase through firebase-admin, in 5 functions. Every other cordwood package that stores data builds on it.

```bash
pnpm add @cordwood/firebase firebase-admin
```

Node 22 or later, `firebase-admin` 13 or later. Server only.

## The app

```ts
import { auth, firestore } from "@cordwood/firebase";

const db = firestore();
const users = auth();
```

`adminApp()` returns the app already initialised in the process, or initialises one from the environment. Credentials are Application Default Credentials. With `FIRESTORE_EMULATOR_HOST` or `FIREBASE_AUTH_EMULATOR_HOST` set, the same calls reach the emulators.

## The tenant

Everything a tenant owns lives under `tenants/{tenantId}`.

```ts
import { firestore, tenantRef } from "@cordwood/firebase";

const tenant = tenantRef(firestore(), session.tenantId);
const invoices = tenant.collection("invoices");
```

Take `tenantId` from a verified session and from nowhere else. An id read from a request's body lets one tenant name another.

`tenantRef` throws on an id that is not a single document id. `isDocumentId(value)` runs the same check on any id that arrives in a URL: 1 to 128 characters of letters, digits, `-` and `_`, and never Firestore's reserved `__name__` shape. Without it, `doc("a/b/c")` reaches into a subcollection.

## Rules

This package assumes the browser never opens Firestore. Deploy rules that deny every client read and write:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```
