# @cordwood/firebase

The server's way into Firebase through firebase-admin: one app, the document each tenant's data lives under, a bucket for its files, and a command that collects the Firestore indexes your packages need.

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

## Files

```ts
import { bucket } from "@cordwood/firebase";

const files = bucket(process.env.FIREBASE_STORAGE_BUCKET);
await files.file(`tenants/${tenantId}/photos/${id}.jpg`).save(bytes, { contentType: "image/jpeg", resumable: false });
const [bytes] = await files.file(path).download();
```

`bucket(name)` is a Cloud Storage bucket through firebase-admin. Name it from the deployment's configuration. With `FIREBASE_STORAGE_EMULATOR_HOST` set, the same calls reach the emulator.

Keep a tenant's files under `tenants/{tenantId}/`, as its documents are. The browser never opens the bucket: deploy Storage rules that deny everything, and let each file leave through a route that checks who is asking.

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

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

## Indexes

Firestore keeps every index of a project in one file, `firestore.indexes.json`. A cordwood package that queries ships the indexes it needs, and this command merges them into your file:

```bash
pnpm exec cordwood-firebase indexes
firebase deploy --only firestore:indexes
```

It reads the packages in your `dependencies` and `devDependencies`. Your own indexes stay first and untouched, and running it twice changes nothing.

Add `--check` in CI. It writes nothing and exits 1 when the file is out of date, so an index a new package needs cannot be forgotten before a deploy.

A package opts in with one field in its `package.json`:

```json
{ "cordwood": { "firestoreIndexes": "./firestore.indexes.json" } }
```
