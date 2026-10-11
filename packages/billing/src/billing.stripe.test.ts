// Runs against a real Stripe sandbox and the Firestore emulator: `pnpm test:stripe`, with a test-mode
// key in `.env` as STRIPE_SECRET_KEY. Skipped everywhere else. It creates a product, a price, a
// customer and a trialing subscription, and deletes the customer when it ends.
import { randomUUID } from "node:crypto";
import { firestore as adminFirestore, tenantRef } from "@cordwood/firebase";
import Stripe from "stripe";
import { afterAll, describe, expect, it } from "vitest";
import { LiveSubscription, STRIPE_CLIENT_OPTIONS, createBilling } from "./index.js";

const KEY = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
// A live key never runs this: the suite writes to the account it is given.
const usable = /^(sk|rk)_test_/.test(KEY) && Boolean(process.env.FIRESTORE_EMULATOR_HOST);

const SECRET = "whsec_cordwood_local";
const LOOKUP_KEY = "cordwood_test_monthly";

describe.skipIf(!usable)("against a Stripe sandbox", () => {
  const stripe = new Stripe(KEY || "sk_test_unused", { ...STRIPE_CLIENT_OPTIONS, timeout: 20_000 });
  const db = adminFirestore();
  const tenantId = randomUUID().replaceAll("-", "").slice(0, 20);
  const lines: string[] = [];
  const billing = createBilling({
    stripe,
    firestore: db,
    origin: "https://app.example.com",
    webhookSecret: SECRET,
    log: (line) => lines.push(line),
  });
  const input = {
    tenantId,
    price: LOOKUP_KEY,
    email: "owner@example.org",
    successPath: "/billing?checkout=done",
    cancelPath: "/billing",
  };
  let customerId = "";
  let subscriptionId = "";

  const deliver = (type: string, object: unknown) => {
    const payload = JSON.stringify({
      id: `evt_${randomUUID()}`,
      object: "event",
      type,
      data: { object },
    });
    return billing.handleWebhook(
      payload,
      stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }),
    );
  };

  afterAll(async () => {
    // Deleting the customer cancels its subscriptions.
    if (customerId) await stripe.customers.del(customerId).catch(() => {});
  });

  it("finds the price by its lookup key and opens Checkout for a new customer", async () => {
    await tenantRef(db, tenantId).collection("members").doc("owner").set({ role: "admin" });
    const product = await stripe.products.create({ name: "cordwood test plan" });
    await stripe.prices.create({
      product: product.id,
      currency: "brl",
      unit_amount: 1000,
      recurring: { interval: "month" },
      lookup_key: LOOKUP_KEY,
      transfer_lookup_key: true,
    });

    const url = await billing.checkout(input);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const kept = (
      await tenantRef(db, tenantId).collection("billing").doc("subscription").get()
    ).get("customerId") as string;
    customerId = kept;
    const customer = await stripe.customers.retrieve(kept);
    expect(customer.deleted).toBeUndefined();
    expect((customer as Stripe.Customer).metadata).toEqual({ tenant: tenantId });
  });

  it("reuses the customer on a second click and leaves one session open", async () => {
    await billing.checkout(input);
    const open = await stripe.checkout.sessions.list({ customer: customerId, status: "open" });
    expect(open.data).toHaveLength(1);
    expect(open.data[0]!.metadata).toEqual({ tenant: tenantId });
    const customers = await stripe.customers.search({
      query: `metadata["tenant"]:"${tenantId}"`,
    }).catch(() => null);
    // Search is eventually consistent, so it only ever proves there is not a second customer.
    if (customers) expect(customers.data.length).toBeLessThanOrEqual(1);
  });

  it("mirrors the subscription Stripe holds when its event is delivered", async () => {
    const price = (await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], active: true })).data[0]!;
    const created = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: price.id, quantity: 2 }],
      trial_period_days: 7,
      metadata: { tenant: tenantId },
    });
    subscriptionId = created.id;

    expect(await deliver("customer.subscription.created", { id: created.id })).toEqual({
      status: 200,
      result: "written",
    });
    const mirror = await billing.subscription(tenantId);
    expect(mirror).toMatchObject({
      customerId,
      subscriptionId: created.id,
      status: "trialing",
      priceId: price.id,
      priceLookupKey: LOOKUP_KEY,
      interval: "month",
      quantity: 2,
      cancelAtPeriodEnd: false,
    });
    expect(mirror!.trialEnd).toBeInstanceOf(Date);
    expect(mirror!.currentPeriodEnd).toBeInstanceOf(Date);
  });

  it("refuses a second Checkout while the subscription lives", async () => {
    await expect(billing.checkout(input)).rejects.toBeInstanceOf(LiveSubscription);
  });

  it("opens the customer portal for that subscription", async () => {
    const configuration = await stripe.billingPortal.configurations.create({
      features: { invoice_history: { enabled: true } },
    });
    const url = await billing.portal({
      tenantId,
      returnPath: "/billing",
      configuration: configuration.id,
    });
    expect(url).toMatch(/^https:\/\/billing\.stripe\.com\//);
  });

  it("mirrors the cancellation", async () => {
    await stripe.subscriptions.cancel(subscriptionId);
    expect(await deliver("customer.subscription.deleted", { id: subscriptionId })).toEqual({
      status: 200,
      result: "written",
    });
    expect(await billing.subscription(tenantId)).toMatchObject({ status: "canceled" });
    expect(await billing.portal({ tenantId, returnPath: "/billing" })).toBeNull();
  });

  it("logged nothing along the way", () => {
    expect(lines).toEqual([]);
  });
});
