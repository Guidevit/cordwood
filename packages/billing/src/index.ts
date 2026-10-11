import type { Firestore } from "firebase-admin/firestore";
import type Stripe from "stripe";
import {
  openCheckout,
  openPortal,
  type CheckoutInput,
  type CheckoutStripe,
  type PortalInput,
  type PortalStripe,
} from "./checkout.js";
import { readMirror, type SubscriptionMirror } from "./mirror.js";
import { receiveWebhook, type WebhookResponse, type WebhookStripe } from "./webhook.js";

export type BillingConfig = {
  /** The app's Stripe client, built with its secret key and the API version it pins. */
  stripe: CheckoutStripe & PortalStripe & WebhookStripe;
  firestore: Firestore;
  /**
   * The app's own origin, such as `https://app.example.com`, for the addresses Stripe returns to. From
   * the deployment's configuration, never from a request's Host header, which the caller writes.
   */
  origin: string;
  /** The webhook endpoint's signing secret (`whsec_...`). Without it every delivery is answered 500. */
  webhookSecret?: string;
  /** Receives one line per refusal or failure: Stripe's ids and error codes, never a key or a tenant's data. */
  log?: (line: string) => void;
};

export type Billing = {
  /** The address of a Checkout page where the tenant subscribes. */
  checkout(input: CheckoutInput): Promise<string>;
  /** The address of the customer portal, or null when the tenant has no live subscription. */
  portal(input: PortalInput): Promise<string | null>;
  /** The tenant's subscription as last mirrored from Stripe, or null when it never had one. */
  subscription(tenantId: string): Promise<SubscriptionMirror | null>;
  /** Verifies and applies one webhook delivery. Pass the body exactly as it arrived. */
  handleWebhook(rawBody: string | Buffer, signature: string | null): Promise<WebhookResponse>;
};

function originOf(value: string): string {
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {}
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:"))
    throw new Error("origin must be an http(s) origin");
  return url.origin;
}

export function createBilling(config: BillingConfig): Billing {
  const { stripe, firestore } = config;
  const origin = originOf(config.origin);
  const log = config.log ?? (() => {});
  return {
    checkout: (input) => openCheckout(stripe, firestore, origin, input),
    portal: (input) => openPortal(stripe, firestore, origin, input),
    subscription: (tenantId) => readMirror(firestore, tenantId),
    handleWebhook: (rawBody, signature) =>
      receiveWebhook(
        { stripe, firestore, webhookSecret: config.webhookSecret, log },
        rawBody,
        signature,
      ),
  };
}

/** The options a server's Stripe client is best built with: a hung Stripe answers in seconds, not minutes. */
export const STRIPE_CLIENT_OPTIONS = {
  maxNetworkRetries: 0,
  timeout: 5000,
} as const satisfies Stripe.StripeConfig;

export { LiveSubscription, PriceNotFound, type CheckoutInput, type PortalInput } from "./checkout.js";
export { OwnerMismatch } from "./customer.js";
export {
  LIVE_STATUSES,
  PAYING_STATUSES,
  type MirrorWrite,
  type SubscriptionMirror,
} from "./mirror.js";
export {
  subscriptionOfEvent,
  type WebhookResponse,
  type WebhookResult,
} from "./webhook.js";
