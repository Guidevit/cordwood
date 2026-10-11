// How a Stripe webhook delivery is verified, which subscription it names, and what Stripe is answered.
import { isDocumentId } from "@cordwood/firebase";
import type { Firestore } from "firebase-admin/firestore";
import type Stripe from "stripe";
import { mirrorOf, writeMirror, type MirrorWrite } from "./mirror.js";

export type WebhookStripe = Pick<Stripe, "webhooks" | "subscriptions">;

/**
 * What a delivery did. `ignored`: the event names no subscription (a one-off payment, a customer).
 * `no_tenant`: the subscription's `metadata.tenant` is missing or is no document id, so it was not
 * created by this package. The rest are the mirror's own answers.
 */
export type WebhookResult = MirrorWrite | "ignored" | "no_tenant";

export type WebhookResponse =
  | { status: 200; result: WebhookResult }
  | { status: 400; error: "invalid_signature" }
  | { status: 500; error: "not_configured" | "not_written" };

type EventObject = {
  id?: string;
  subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription: string | { id: string } } | null } | null;
};

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : (value?.id ?? null);

/** Where each family of events names its subscription. */
const SUBSCRIPTION_BY_FAMILY: [string, (o: EventObject) => string | null][] = [
  ["customer.subscription.", (o) => o.id ?? null],
  ["checkout.session.", (o) => idOf(o.subscription)],
  ["invoice.", (o) => idOf(o.parent?.subscription_details?.subscription)],
  ["subscription_schedule.", (o) => idOf(o.subscription)],
];

/** The subscription an event is about, or null for an event that names none. */
export function subscriptionOfEvent(event: Stripe.Event): string | null {
  const family = SUBSCRIPTION_BY_FAMILY.find(([prefix]) => event.type.startsWith(prefix));
  return family ? family[1](event.data.object as EventObject) : null;
}

/** The tenant the customer belongs to, or null when it names none. */
function ownerOf(customer: Stripe.Customer): string | null {
  return customer.metadata?.tenant ?? null;
}

/**
 * One event: the subscription it names, read from Stripe now (the payload may be days old and
 * delivered out of order), its tenant from `metadata.tenant` checked against the customer's, and the
 * mirror rewritten. A mismatch writes nothing and logs Stripe's ids only, never a tenant's.
 */
export async function processEvent(
  stripe: WebhookStripe,
  db: Firestore,
  event: Stripe.Event,
  log: (line: string) => void,
): Promise<WebhookResult> {
  const id = subscriptionOfEvent(event);
  if (!id) return "ignored";
  // The clock is read before Stripe is, so a read that started later is never stamped earlier.
  const readAt = new Date();
  const subscription = await stripe.subscriptions.retrieve(id, {
    expand: ["customer", "latest_invoice"],
  });
  const tenantId = subscription.metadata?.tenant ?? "";
  if (!isDocumentId(tenantId)) return "no_tenant";
  const mirror = mirrorOf(subscription, event.id, readAt);
  const customer = subscription.customer;
  let written: MirrorWrite;
  if (typeof customer !== "string" && customer.deleted) {
    // Deleting a customer cancels its subscriptions at once, and a deleted customer carries no
    // metadata to check.
    written = await writeMirror(db, tenantId, mirror, { onlyForStoredCustomer: true });
  } else if (typeof customer === "string" || ownerOf(customer) !== tenantId) {
    written = "owner_mismatch";
  } else {
    written = await writeMirror(db, tenantId, mirror);
  }
  // Stripe's ids only: the line a person reads to fix the metadata or cancel the duplicate there.
  if (written === "owner_mismatch" || written === "unknown_tenant" || written === "duplicate")
    log(
      `[billing] ${written}: event ${event.id}, subscription ${mirror.subscriptionId}, customer ${mirror.customerId}; nothing written`,
    );
  return written;
}

export type WebhookConfig = {
  stripe: WebhookStripe;
  firestore: Firestore;
  /** The endpoint's signing secret (`whsec_...`). */
  webhookSecret: string | undefined;
  log: (line: string) => void;
};

/**
 * A delivery from Stripe: 400 for a missing or invalid signature, 500 when reading Stripe or writing
 * Firestore failed, 200 for everything else, an event with no tenant included. Stripe retries any
 * answer that is not 2xx for up to three days. The signature over the raw body is the authentication:
 * this path has no session and reads no cookie.
 */
export async function receiveWebhook(
  config: WebhookConfig,
  rawBody: string | Buffer,
  signature: string | null,
): Promise<WebhookResponse> {
  const { stripe, log } = config;
  const secret = config.webhookSecret?.trim();
  if (!secret) {
    log("[billing] no webhook secret: no Stripe event is accepted without one");
    return { status: 500, error: "not_configured" };
  }
  if (!signature) {
    // Almost always a scanner.
    log("[billing] webhook refused: no stripe-signature header");
    return { status: 400, error: "invalid_signature" };
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    // What a rolled or re-created endpoint secret looks like. Without this line it shows only in
    // Stripe's delivery list.
    log("[billing] webhook refused: the signature does not match the secret (rolled on Stripe?)");
    return { status: 400, error: "invalid_signature" };
  }
  try {
    return { status: 200, result: await processEvent(stripe, config.firestore, event, log) };
  } catch (error) {
    // A Stripe or Firestore code, else the error's name: never its message, which can echo a key.
    const e = error as { code?: unknown; type?: unknown; name?: unknown } | null;
    log(`[billing] event ${event.id} not written: ${String(e?.code ?? e?.type ?? e?.name ?? "no code")}`);
    return { status: 500, error: "not_written" };
  }
}
