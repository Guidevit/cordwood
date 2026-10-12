# @cordwood/billing

## 0.2.0

### Minor Changes

- 12f4290: One-off payments by Pix: `billing.charge` issues the code for something a tenant buys once, `billing.payment` and `billing.syncPayment` read it, and `handleWebhook` now says which payment a `payment_intent.*` delivery was about. The Stripe client passed to `createBilling` must also have `paymentIntents`, which a full client does.

### Patch Changes

- Updated dependencies [12f4290]
  - @cordwood/firebase@0.2.0

## 0.1.1

### Patch Changes

- eee2257: Published from GitHub Actions through npm trusted publishing. No change to the code.
- Updated dependencies [eee2257]
  - @cordwood/firebase@0.1.1
