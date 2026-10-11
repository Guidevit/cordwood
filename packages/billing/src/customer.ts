// A tenant's one Stripe customer: found, checked to be this tenant's, or made.
import type { Firestore } from "firebase-admin/firestore";
import type Stripe from "stripe";
import { subscriptionRef } from "./mirror.js";

/** The kept customer belongs to another tenant on Stripe: nothing is opened for it. */
export class OwnerMismatch extends Error {
  override name = "OwnerMismatch";
  readonly customerId: string;
  constructor(customerId: string) {
    super(`customer ${customerId} belongs to another tenant`);
    this.customerId = customerId;
  }
}

/** The customer id kept beside the mirror: a merge, so the mirror's own fields stay. */
export async function storedCustomerId(db: Firestore, tenantId: string): Promise<string | null> {
  const id: unknown = (await subscriptionRef(db, tenantId).get()).get("customerId");
  return typeof id === "string" ? id : null;
}

/**
 * The kept customer as Stripe holds it now: its id when it exists and Stripe says it is this tenant's
 * (`metadata.tenant`), null when it was deleted. Another tenant's throws `OwnerMismatch`.
 */
export async function verifiedCustomer(
  stripe: Pick<Stripe, "customers">,
  tenantId: string,
  stored: string,
): Promise<string | null> {
  const customer = await stripe.customers.retrieve(stored);
  if (customer.deleted) return null;
  if (customer.metadata?.tenant !== tenantId) throw new OwnerMismatch(customer.id);
  return customer.id;
}

/**
 * The tenant's one customer. A kept one is used only when Stripe says it is this tenant's. A deleted
 * one is replaced. A new one is made under a key of the tenant's own, so two clicks at once make one.
 */
export async function customerOf(
  stripe: Pick<Stripe, "customers">,
  db: Firestore,
  tenantId: string,
  email: string | null | undefined,
): Promise<string> {
  const stored = await storedCustomerId(db, tenantId);
  const verified = stored && (await verifiedCustomer(stripe, tenantId, stored));
  if (verified) return verified;
  const created = await stripe.customers.create(
    { ...(email ? { email } : {}), metadata: { tenant: tenantId } },
    {
      idempotencyKey: stored
        ? `cordwood-customer-${tenantId}-after-${stored}`
        : `cordwood-customer-${tenantId}`,
    },
  );
  await subscriptionRef(db, tenantId).set({ customerId: created.id }, { merge: true });
  return created.id;
}
