---
"@cordwood/billing": minor
---

One-off payments by Pix: `billing.charge` issues the code for something a tenant buys once, `billing.payment` and `billing.syncPayment` read it, and `handleWebhook` now says which payment a `payment_intent.*` delivery was about. The Stripe client passed to `createBilling` must also have `paymentIntents`, which a full client does.
