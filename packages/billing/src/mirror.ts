// A tenant's Stripe subscription mirrored in Firestore, at tenants/{tenantId}/billing/subscription.
//
// The app reads the mirror, never Stripe, to decide what a tenant may do. Only the webhook writes it,
// always from a subscription read from Stripe at that moment and never from an event's payload.
import { tenantRef } from "@cordwood/firebase";
import {
  FieldValue,
  type DocumentReference,
  type Firestore,
  Timestamp,
} from "firebase-admin/firestore";
import type Stripe from "stripe";

export const BILLING = "billing";
export const SUBSCRIPTION = "subscription";

/** A subscription the tenant is being served for: paid, in its trial, or waiting on a retried charge. */
export const PAYING_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
]);

/** A subscription that still exists for the customer: a second Checkout is refused while one does. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
]);

export type SubscriptionMirror = {
  customerId: string;
  subscriptionId: string;
  status: Stripe.Subscription.Status;
  /** The first item's price: its id, its lookup key when it has one, and how often it bills. */
  priceId: string | null;
  priceLookupKey: string | null;
  interval: Stripe.Price.Recurring.Interval | null;
  quantity: number | null;
  /** When the period being served ends, which is the next charge unless the subscription is ending. */
  currentPeriodEnd: Date | null;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** When the subscription ends, once a cancellation is set. */
  cancelAt: Date | null;
  /** The latest invoice while it is unpaid: where the customer pays it. */
  openInvoiceUrl: string | null;
  /** The Stripe event whose delivery wrote this. */
  lastEventId: string;
  /** When the subscription was read from Stripe. */
  readAt: Date;
};

/**
 * `written`: the mirror now holds this state. `stale`: a later read, or a paying subscription, is
 * already stored and stays. `duplicate`: the tenant already pays through another subscription.
 * `owner_mismatch`: a deleted customer's subscription that is not the one this tenant's mirror holds.
 * `unknown_tenant`: no tenant has this id.
 */
export type MirrorWrite =
  | "written"
  | "stale"
  | "duplicate"
  | "owner_mismatch"
  | "unknown_tenant";

const idOf = (value: string | { id: string }) =>
  typeof value === "string" ? value : value.id;

const date = (seconds: number | null | undefined) =>
  seconds ? new Date(seconds * 1000) : null;

function openInvoiceUrl(subscription: Stripe.Subscription): string | null {
  const invoice = subscription.latest_invoice;
  if (!invoice || typeof invoice === "string" || invoice.status !== "open")
    return null;
  return invoice.hosted_invoice_url ?? null;
}

/** The mirror of a subscription read from Stripe at `readAt`. */
export function mirrorOf(
  subscription: Stripe.Subscription,
  eventId: string,
  readAt: Date,
): SubscriptionMirror {
  const item = subscription.items.data[0];
  const periodEnd = date(item?.current_period_end);
  return {
    customerId: idOf(subscription.customer),
    subscriptionId: subscription.id,
    status: subscription.status,
    priceId: item?.price.id ?? null,
    priceLookupKey: item?.price.lookup_key ?? null,
    interval: item?.price.recurring?.interval ?? null,
    quantity: item?.quantity ?? null,
    currentPeriodEnd: periodEnd,
    trialEnd: date(subscription.trial_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: date(subscription.cancel_at) ?? (subscription.cancel_at_period_end ? periodEnd : null),
    openInvoiceUrl: openInvoiceUrl(subscription),
    lastEventId: eventId,
    readAt,
  };
}

type Stored = { subscriptionId?: string; status?: string; customerId?: string; readAt?: Timestamp };

const paying = (status: string | undefined) =>
  status !== undefined && PAYING_STATUSES.has(status);

const another = (stored: Stored | undefined, next: SubscriptionMirror) =>
  stored?.subscriptionId !== undefined && stored.subscriptionId !== next.subscriptionId;

/**
 * A tenant exists once anything of it is stored under tenants/{id}. `metadata.tenant` is free text in
 * Stripe's dashboard, so a typo copied to the customer passes every other check, and the mirror would
 * create a phantom tenant while the real one, paying, is never marked as paying.
 */
export async function tenantExists(tenant: DocumentReference): Promise<boolean> {
  if ((await tenant.get()).exists) return true;
  return (await tenant.listCollections()).length > 0;
}

export function subscriptionRef(db: Firestore, tenantId: string): DocumentReference {
  return tenantRef(db, tenantId).collection(BILLING).doc(SUBSCRIPTION);
}

export type WriteCondition = {
  /**
   * A subscription whose customer was deleted carries no `metadata.tenant` to check, so it writes only
   * when its customer is the one this tenant's mirror already holds, a value written from an earlier
   * verified event.
   */
  onlyForStoredCustomer?: boolean;
};

/**
 * Rewrites the tenant's mirror. The comparison and the write commit together, so two deliveries at
 * once cannot both see the old state. A failed write throws: the webhook answers 500 and Stripe
 * delivers again.
 */
export async function writeMirror(
  db: Firestore,
  tenantId: string,
  mirror: SubscriptionMirror,
  { onlyForStoredCustomer = false }: WriteCondition = {},
): Promise<MirrorWrite> {
  const tenant = tenantRef(db, tenantId);
  const ref = tenant.collection(BILLING).doc(SUBSCRIPTION);
  return db.runTransaction(async (tx) => {
    const stored = (await tx.get(ref)).data() as Stored | undefined;
    if (onlyForStoredCustomer && stored?.customerId !== mirror.customerId)
      return "owner_mismatch";
    // Only the first write pays this read: a stored document is a tenant this server already wrote for.
    if (stored === undefined && !(await tenantExists(tenant))) return "unknown_tenant";
    // A state read from Stripe before the stored one: its delivery only committed last.
    if (stored?.readAt !== undefined && stored.readAt.toMillis() > mirror.readAt.getTime())
      return "stale";
    if (another(stored, mirror) && paying(stored?.status)) {
      // A late event of an ended subscription must not replace the paying one: Stripe redelivers for
      // three days, and a tenant that subscribed again after a cancellation has a new subscription id.
      // A second paying one is a double Checkout: the first keeps the mirror, so cancelling the
      // duplicate never cuts off a tenant that still pays.
      return paying(mirror.status) ? "duplicate" : "stale";
    }
    // Only the mirror's own fields: the customer id is kept on this document too, and an app may keep
    // its own fields beside them. Every field of the mirror is required, so the list names all of them.
    const fields = { ...mirror, updatedAt: FieldValue.serverTimestamp() };
    tx.set(ref, fields, { mergeFields: Object.keys(fields) });
    return "written";
  });
}

const asDate = (value: unknown): Date | null =>
  value instanceof Timestamp ? value.toDate() : null;

/** The tenant's mirror, or null when no subscription was ever written for it. */
export async function readMirror(
  db: Firestore,
  tenantId: string,
): Promise<SubscriptionMirror | null> {
  const data = (await subscriptionRef(db, tenantId).get()).data();
  if (!data || typeof data.subscriptionId !== "string") return null;
  return {
    customerId: data.customerId,
    subscriptionId: data.subscriptionId,
    status: data.status,
    priceId: data.priceId ?? null,
    priceLookupKey: data.priceLookupKey ?? null,
    interval: data.interval ?? null,
    quantity: data.quantity ?? null,
    currentPeriodEnd: asDate(data.currentPeriodEnd),
    trialEnd: asDate(data.trialEnd),
    cancelAtPeriodEnd: data.cancelAtPeriodEnd === true,
    cancelAt: asDate(data.cancelAt),
    openInvoiceUrl: data.openInvoiceUrl ?? null,
    lastEventId: data.lastEventId,
    readAt: asDate(data.readAt) ?? new Date(0),
  };
}
