// Where a tenant's data lives: everything a tenant owns is under `tenants/{tenantId}`.
import type { DocumentReference, Firestore } from "firebase-admin/firestore";

/** The root collection every tenant's document is in. */
export const TENANTS = "tenants";

// `doc("a/b/c")` is a valid path into a subcollection, so an id taken from a URL or a claim must be a
// single segment before it reaches Firestore. Firestore reserves `__.*__` and answers it with
// INVALID_ARGUMENT only after seconds of retries, which a route would serve as a slow 500.
const DOCUMENT_ID = /^(?!__.*__$)[A-Za-z0-9_-]{1,128}$/;

/** Whether `id` may be passed to `collection.doc()` as one document id. */
export function isDocumentId(id: unknown): id is string {
  return typeof id === "string" && DOCUMENT_ID.test(id);
}

/**
 * A tenant's root document. `tenantId` comes from a verified session and nowhere else: never from a
 * request's body, its query or the environment.
 */
export function tenantRef(db: Firestore, tenantId: string): DocumentReference {
  if (!isDocumentId(tenantId)) throw new Error("invalid tenant id");
  return db.collection(TENANTS).doc(tenantId);
}
