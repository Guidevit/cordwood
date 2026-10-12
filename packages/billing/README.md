# @cordwood/billing

Stripe for a tenant: subscriptions in 4 calls (open Checkout, open the customer portal, handle the webhook, read the subscription), and one-off charges by Pix. The webhook keeps a copy of each tenant's subscription in Firestore, so your app never calls Stripe to decide what a tenant may do.

```bash
pnpm add @cordwood/billing @cordwood/firebase firebase-admin stripe
```

Node 22 or later, `stripe` 23 or later. Server only.

## Set up

```ts
import { STRIPE_CLIENT_OPTIONS, createBilling } from "@cordwood/billing";
import { firestore } from "@cordwood/firebase";
import Stripe from "stripe";

export const billing = createBilling({
  stripe: new Stripe(process.env.STRIPE_SECRET_KEY!, STRIPE_CLIENT_OPTIONS),
  firestore: firestore(),
  origin: process.env.APP_ORIGIN!, // https://app.example.com
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  log: console.error,
});
```

`origin` is where Stripe sends people back. Set it from your deployment's configuration. A request's Host header is written by whoever sends the request.

`STRIPE_CLIENT_OPTIONS` turns retries off and sets a 5 second timeout, so a hung Stripe fails your page in seconds.

Create your products and prices on Stripe, and give each price a lookup key. This package finds a price by that key and creates none.

## Subscribe

```ts
const url = await billing.checkout({
  tenantId: access.tenantId,
  price: "pro_monthly",
  quantity: 5,
  email: access.email,
  successPath: "/billing?checkout=done",
  cancelPath: "/billing",
  session: { locale: "pt-BR", allow_promotion_codes: true },
});
return Response.redirect(url, 303);
```

Each tenant gets one Stripe customer, made on the first Checkout and reused after. `session` passes any other Checkout Session parameter through.

| Throws | When | Answer with |
|---|---|---|
| `LiveSubscription` | The tenant already has a subscription that is not ended. | 409, and a link to the portal |
| `PriceNotFound` | No active price has that lookup key. | 500 |
| `OwnerMismatch` | The customer kept for this tenant belongs to another on Stripe. | 500 |

A second click expires the session the first one opened, so a tenant can pay for one Checkout only.

`trialEnd` delays the first charge to a date. Stripe needs it 48 hours away or more, and a nearer date charges at once.

## Manage

```ts
const url = await billing.portal({ tenantId: access.tenantId, returnPath: "/billing" });
if (!url) return Response.json({ error: "no_subscription" }, { status: 409 });
return Response.redirect(url, 303);
```

The portal is Stripe's own page for changing the card, reading invoices and cancelling. `portal` answers null when the tenant has no subscription to manage.

## Webhook

Point a Stripe webhook endpoint at this route and send it the `customer.subscription.*`, `checkout.session.completed` and `invoice.*` events.

```ts
export async function POST(request: Request) {
  const response = await billing.handleWebhook(
    Buffer.from(await request.arrayBuffer()),
    request.headers.get("stripe-signature"),
  );
  return Response.json(response, { status: response.status });
}
```

Pass the body exactly as it arrived. A parsed and re-serialised body does not verify.

| Status | Meaning |
|---|---|
| 200 | The event was applied, or it needed nothing. `result` says which. |
| 400 | The signature is missing or does not match the secret. |
| 500 | The secret is not set, or Stripe or Firestore failed. Stripe delivers again for up to 3 days. |

An event only says which subscription changed. The package then reads that subscription from Stripe and writes what it finds, since a payload can be days old and arrive out of order.

It writes nothing in these cases, and `result` names the case.

| `result` | Why nothing was written |
|---|---|
| `ignored` | The event names no subscription. |
| `no_tenant` | The subscription was not created through this package. |
| `owner_mismatch` | The subscription and its customer name different tenants. |
| `unknown_tenant` | No tenant has that id, which a typo in Stripe's dashboard causes. |
| `stale` | A newer read, or a paying subscription, is already stored. |
| `duplicate` | The tenant already pays through another subscription. Cancel this one on Stripe. |

## Read

```ts
const subscription = await billing.subscription(tenantId);
const paying = subscription !== null && PAYING_STATUSES.has(subscription.status);
```

The mirror lives at `tenants/{tenantId}/billing/subscription`.

| Field | Meaning |
|---|---|
| `status` | Stripe's own: `trialing`, `active`, `past_due`, `canceled` and the rest. |
| `priceLookupKey`, `priceId`, `interval`, `quantity` | What the tenant subscribed to. |
| `currentPeriodEnd` | When the period being served ends. |
| `trialEnd` | When the trial ends, if there is one. |
| `cancelAtPeriodEnd`, `cancelAt` | Whether a cancellation is set, and for when. |
| `openInvoiceUrl` | Where the tenant pays an unpaid invoice. |

`PAYING_STATUSES` holds `active`, `trialing` and `past_due`. Decide for yourself whether `past_due` keeps access in your app.

## Charge once, by Pix

For something a tenant buys once: an order, an event, a pack of credits. The payer scans a QR code or pastes its text into their bank's app, and the money arrives in seconds.

```ts
import { AlreadyPaid } from "@cordwood/billing";

const payment = await billing.charge({
  tenantId: access.tenantId,
  reference: order.id, // what is being paid for: a document id of your own
  amount: 14900, // centavos: R$ 149,00
  email: access.email,
  description: "Order 1042",
  expiresInSeconds: 3600,
});
// payment.pix.code      the "copia e cola" text
// payment.pix.qrPng     Stripe's image of the QR code
// payment.pix.expiresAt
```

One reference is paid once. While its code is open, `charge` answers the same code again, so a reloaded page shows the same QR. A code that ran out, or a new amount, cancels the old code and issues another. Once the money arrived, `charge` throws `AlreadyPaid`: answer 409 and show what was bought.

The amount is yours to compute on the server. Never take it from the request.

Stripe must have Pix turned on for the account (Settings, then Payment methods). For accounts in Brazil, Stripe offers Pix by invitation. A charge is from R$ 0,50 to R$ 3.000,00, in `brl` only. An account outside Latin America must also pass `payerTaxId`, the payer's CPF or CNPJ.

### Know when it is paid

Send the webhook endpoint the `payment_intent.*` events. `handleWebhook` then says which payment a delivery was about:

```ts
const response = await billing.handleWebhook(rawBody, signature);
if (response.status === 200 && response.payment?.status === "paid") {
  await openOrder(response.payment.tenantId, response.payment.reference);
}
return Response.json(response, { status: response.status });
```

Stripe delivers an event more than once, and `payment` comes back `paid` each time: make what you do with it safe to repeat.

```ts
const payment = await billing.payment(tenantId, order.id);     // the mirror, from Firestore
const fresh = await billing.syncPayment(tenantId, order.id);   // read from Stripe now, then mirrored
```

`payment` is what a page reads. `syncPayment` asks Stripe, which is what an "I have paid" button calls, and what shows a payment on a machine no webhook reaches, such as a laptop in development.

| `status` | Meaning |
|---|---|
| `pending` | The code was issued and is still open. `pix` holds it. |
| `paid` | The money arrived. `paidAt` says when the mirror learned it. |
| `expired` | The code ran out or was replaced. The next `charge` issues another. |

The mirror lives at `tenants/{tenantId}/billing_payments/{reference}`. A paid mirror is never replaced, and an older code that only ran out never replaces the one issued after it.

In test mode, Stripe settles a Pix code by the payer's e-mail: `succeed_immediately@example.com` pays in seconds, `expire_immediately@example.com` runs out in seconds, and any other address pays after about three minutes.

## Not in this version

One-off payments by card or boleto, refunds from your own UI, changing the quantity or the plan from your own UI, usage-based prices, and syncing a product catalogue to Stripe. The portal covers plan changes when you turn them on in its settings.
