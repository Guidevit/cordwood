// How a tenant's Checkout Session and customer portal session are opened.
import type { Firestore } from "firebase-admin/firestore";
import type Stripe from "stripe";
import { customerOf, storedCustomerId, verifiedCustomer } from "./customer.js";
import { LIVE_STATUSES } from "./mirror.js";

export type CheckoutStripe = Pick<Stripe, "customers" | "subscriptions" | "prices" | "checkout">;
export type PortalStripe = Pick<Stripe, "customers" | "subscriptions" | "billingPortal">;

/** The tenant already has a live subscription: answer 409 and send them to the portal. */
export class LiveSubscription extends Error {
  override name = "LiveSubscription";
}

/** No active price has this lookup key on the Stripe account. */
export class PriceNotFound extends Error {
  override name = "PriceNotFound";
  constructor(lookupKey: string) {
    super(`no active price with lookup key ${lookupKey}`);
  }
}

/** The fields of a Checkout Session this package sets itself. Everything else may be passed through. */
type Reserved =
  | "mode"
  | "customer"
  | "customer_email"
  | "client_reference_id"
  | "line_items"
  | "success_url"
  | "cancel_url"
  | "metadata"
  | "subscription_data";

export type CheckoutInput = {
  /** From the verified session, never from the request. */
  tenantId: string;
  /** The price's lookup key on Stripe. */
  price: string;
  /** Default 1. */
  quantity?: number;
  /** Where Stripe sends receipts, used only when the customer is created. */
  email?: string | null;
  /** The first charge waits for this moment. Stripe takes a trial end at least 48 hours away. */
  trialEnd?: Date | null;
  /** Paths on the app's own origin, each starting with `/`. */
  successPath: string;
  cancelPath: string;
  /** Any other Checkout Session parameter: `locale`, `tax_id_collection`, `allow_promotion_codes`. */
  session?: Omit<Stripe.Checkout.SessionCreateParams, Reserved>;
  now?: Date;
};

export type PortalInput = {
  tenantId: string;
  /** A path on the app's own origin, starting with `/`. */
  returnPath: string;
  /** A portal configuration id. Default: the account's default configuration. */
  configuration?: string;
  locale?: Stripe.BillingPortal.SessionCreateParams.Locale;
};

// Stripe refuses a trial that ends sooner.
const MIN_TRIAL_MS = 48 * 60 * 60 * 1000;

function pathOn(origin: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("a return path must start with one /");
  return `${origin}${path}`;
}

async function hasLiveSubscription(
  stripe: Pick<Stripe, "subscriptions">,
  customer: string,
): Promise<boolean> {
  const { data } = await stripe.subscriptions.list({ customer, status: "all", limit: 100 });
  return data.some((s) => LIVE_STATUSES.has(s.status));
}

/** A session left open by an earlier click is expired, so at most one Checkout of the tenant can be paid. */
async function expireOpenSessions(stripe: CheckoutStripe, customer: string): Promise<void> {
  const { data } = await stripe.checkout.sessions.list({ customer, status: "open", limit: 100 });
  for (const session of data) await stripe.checkout.sessions.expire(session.id);
}

async function priceId(stripe: Pick<Stripe, "prices">, lookupKey: string): Promise<string> {
  const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (!data[0]) throw new PriceNotFound(lookupKey);
  return data[0].id;
}

/**
 * The address of a Checkout page for the tenant. Throws `LiveSubscription`, `PriceNotFound` or
 * `OwnerMismatch`. The tenant id rides in the subscription's metadata, which is what the webhook reads
 * to know whose subscription an event is about.
 */
export async function openCheckout(
  stripe: CheckoutStripe,
  db: Firestore,
  origin: string,
  input: CheckoutInput,
): Promise<string> {
  const success = pathOn(origin, input.successPath);
  const cancel = pathOn(origin, input.cancelPath);
  const customer = await customerOf(stripe, db, input.tenantId, input.email);
  if (await hasLiveSubscription(stripe, customer)) throw new LiveSubscription();
  const [price] = await Promise.all([
    priceId(stripe, input.price),
    expireOpenSessions(stripe, customer),
  ]);
  const now = input.now ?? new Date();
  const trialEnd =
    input.trialEnd && input.trialEnd.getTime() - now.getTime() >= MIN_TRIAL_MS
      ? Math.floor(input.trialEnd.getTime() / 1000)
      : undefined;
  const session = await stripe.checkout.sessions.create({
    ...input.session,
    mode: "subscription",
    customer,
    client_reference_id: input.tenantId,
    line_items: [{ price, quantity: input.quantity ?? 1 }],
    metadata: { tenant: input.tenantId },
    subscription_data: {
      metadata: { tenant: input.tenantId },
      ...(trialEnd === undefined ? {} : { trial_end: trialEnd }),
    },
    success_url: success,
    cancel_url: cancel,
  });
  if (!session.url) throw new Error("the Checkout Session has no address");
  return session.url;
}

/**
 * The address of a customer portal session for the tenant, where they change the card, see invoices
 * and cancel. Null when there is nothing for the portal to serve: the tenant never subscribed, never
 * paid a Checkout, or its subscription ended. Throws `OwnerMismatch`.
 */
export async function openPortal(
  stripe: PortalStripe,
  db: Firestore,
  origin: string,
  input: PortalInput,
): Promise<string | null> {
  const returnUrl = pathOn(origin, input.returnPath);
  const stored = await storedCustomerId(db, input.tenantId);
  const customer = stored && (await verifiedCustomer(stripe, input.tenantId, stored));
  if (!customer || !(await hasLiveSubscription(stripe, customer))) return null;
  const session = await stripe.billingPortal.sessions.create({
    customer,
    return_url: returnUrl,
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
  });
  return session.url;
}
