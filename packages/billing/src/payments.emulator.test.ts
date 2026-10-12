// Runs against the Firestore emulator (`pnpm test`). Stripe is a stand-in: the SDK's real signature
// check, and PaymentIntents the test holds in memory.
import { randomUUID } from "node:crypto";
import { firestore as adminFirestore, tenantRef } from "@cordwood/firebase";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { AlreadyPaid, createBilling, type BillingConfig } from "./index.js";

if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("the Firestore emulator is not running: use `pnpm test`");

const db = adminFirestore();
const SECRET = "whsec_test_secret";
const sdk = new Stripe("sk_test_offline");
const id = () => randomUUID().replaceAll("-", "").slice(0, 20);

type Intent = Stripe.PaymentIntent;
type Calls = { name: string; args: unknown[] }[];

/** A Stripe that keeps the intents it is asked to make, each a Pix code open for an hour. */
function fakeStripe(tenantOfCustomer: (customerId: string) => string | null = (c) => c.replace("cus_", "")) {
  const calls: Calls = [];
  const intents: Record<string, Intent> = {};
  let made = 0;
  const stripe = {
    webhooks: sdk.webhooks,
    customers: {
      retrieve: async (customerId: string) => ({ id: customerId, metadata: { tenant: tenantOfCustomer(customerId) } }),
      create: async (params: { metadata: { tenant: string } }) => ({ id: `cus_${params.metadata.tenant}` }),
    },
    paymentIntents: {
      create: async (params: Stripe.PaymentIntentCreateParams, options: { idempotencyKey: string }) => {
        calls.push({ name: "paymentIntents.create", args: [params, options] });
        made += 1;
        const intent = {
          id: `pi_${made}_${id()}`,
          status: "requires_action",
          amount: params.amount,
          currency: params.currency,
          customer: params.customer,
          metadata: params.metadata,
          next_action: {
            type: "pix_display_qr_code",
            pix_display_qr_code: {
              data: `00020126-code-${made}`,
              image_url_png: `https://stripe.test/qr-${made}.png`,
              image_url_svg: `https://stripe.test/qr-${made}.svg`,
              hosted_instructions_url: `https://stripe.test/pix-${made}`,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        } as unknown as Intent;
        intents[intent.id] = intent;
        return intent;
      },
      retrieve: async (intentId: string, params?: { expand?: string[] }) => {
        calls.push({ name: "paymentIntents.retrieve", args: [intentId] });
        const found = intents[intentId];
        if (!found) throw Object.assign(new Error("no such"), { code: "resource_missing" });
        if (!params?.expand?.includes("customer")) return found;
        const customerId = found.customer as string;
        return { ...found, customer: { id: customerId, metadata: { tenant: tenantOfCustomer(customerId) } } };
      },
      cancel: async (intentId: string) => {
        calls.push({ name: "paymentIntents.cancel", args: [intentId] });
        const found = intents[intentId]!;
        if (found.status === "succeeded") throw Object.assign(new Error("paid"), { code: "payment_intent_unexpected_state" });
        intents[intentId] = { ...found, status: "canceled", next_action: null };
        return intents[intentId];
      },
    },
  };
  const pay = (intentId: string) => {
    intents[intentId] = { ...intents[intentId]!, status: "succeeded", next_action: null };
  };
  /** What Stripe does to a Pix code nobody paid in time. */
  const expire = (intentId: string) => {
    intents[intentId] = { ...intents[intentId]!, status: "requires_payment_method", next_action: null };
  };
  return { stripe: stripe as unknown as BillingConfig["stripe"], calls, intents, pay, expire };
}

async function setup(fake = fakeStripe()) {
  const tenantId = id();
  await tenantRef(db, tenantId).set({ name: "Tenant" });
  const lines: string[] = [];
  const billing = createBilling({
    stripe: fake.stripe,
    firestore: db,
    origin: "https://app.example.com",
    webhookSecret: SECRET,
    log: (line) => lines.push(line),
  });
  return { tenantId, billing, lines, ...fake };
}

function delivery(type: string, object: unknown) {
  const payload = JSON.stringify({ id: `evt_${id()}`, object: "event", type, data: { object } });
  return { payload, signature: sdk.webhooks.generateTestHeaderString({ payload, secret: SECRET }) };
}

const created = (calls: Calls) => calls.filter((call) => call.name === "paymentIntents.create");

describe("a one-off Pix charge", () => {
  it("issues a code on Stripe, by Pix only, naming the tenant and what is paid for", async () => {
    const { tenantId, billing, calls } = await setup();
    const payment = await billing.charge({
      tenantId,
      reference: "order1",
      amount: 14900,
      email: "ana@example.org",
      description: "Order 1",
      expiresInSeconds: 3600,
    });
    expect(payment).toMatchObject({ status: "pending", amount: 14900, currency: "brl", paidAt: null });
    expect(payment.pix).toMatchObject({ code: "00020126-code-1", qrPng: "https://stripe.test/qr-1.png" });
    expect(payment.pix!.expiresAt).toBeInstanceOf(Date);
    const [params, options] = created(calls)[0]!.args as [Stripe.PaymentIntentCreateParams, { idempotencyKey: string }];
    expect(params).toMatchObject({
      amount: 14900,
      currency: "brl",
      confirm: true,
      customer: `cus_${tenantId}`,
      allowed_payment_method_types: ["pix"],
      payment_method_data: { type: "pix", billing_details: { email: "ana@example.org" } },
      payment_method_options: { pix: { expires_after_seconds: 3600 } },
      metadata: { tenant: tenantId, reference: "order1" },
    });
    expect(options.idempotencyKey).toContain(tenantId);
    expect(await billing.payment(tenantId, "order1")).toMatchObject({ status: "pending", intentId: payment.intentId });
  });

  it("answers the same code while it is open, so a reloaded page makes no second one", async () => {
    const { tenantId, billing, calls } = await setup();
    const first = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    const second = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    expect(second.intentId).toBe(first.intentId);
    expect(second.pix?.code).toBe(first.pix?.code);
    expect(created(calls)).toHaveLength(1);
  });

  it("replaces a code when the amount changes, and cancels the old one", async () => {
    const { tenantId, billing, calls, intents } = await setup();
    const first = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    const second = await billing.charge({ tenantId, reference: "order1", amount: 11990 });
    expect(second.intentId).not.toBe(first.intentId);
    expect(second.amount).toBe(11990);
    expect(intents[first.intentId]!.status).toBe("canceled");
    expect(created(calls)).toHaveLength(2);
    expect(await billing.payment(tenantId, "order1")).toMatchObject({ intentId: second.intentId, status: "pending" });
  });

  it("issues a new code after the old one ran out", async () => {
    const { tenantId, billing, expire } = await setup();
    const first = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    expire(first.intentId);
    expect(await billing.syncPayment(tenantId, "order1")).toMatchObject({ status: "expired", pix: null });
    const second = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    expect(second.intentId).not.toBe(first.intentId);
    expect(second.status).toBe("pending");
  });

  it("throws AlreadyPaid once the money arrived, even before any webhook", async () => {
    const { tenantId, billing, pay, calls } = await setup();
    const first = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    pay(first.intentId);
    await expect(billing.charge({ tenantId, reference: "order1", amount: 5990 })).rejects.toBeInstanceOf(AlreadyPaid);
    expect(created(calls)).toHaveLength(1);
    expect(await billing.payment(tenantId, "order1")).toMatchObject({ status: "paid" });
  });

  it("refuses a reference that is a path, and an amount that is not whole centavos", async () => {
    const { tenantId, billing } = await setup();
    await expect(billing.charge({ tenantId, reference: "a/b", amount: 100 })).rejects.toThrow("document id");
    await expect(billing.charge({ tenantId, reference: "order1", amount: 59.9 })).rejects.toThrow("whole number");
    await expect(billing.charge({ tenantId, reference: "order1", amount: 0 })).rejects.toThrow("whole number");
  });

  it("reads Stripe on syncPayment, which is how a paid code shows where no webhook reaches", async () => {
    const { tenantId, billing, pay } = await setup();
    expect(await billing.syncPayment(tenantId, "order1")).toBeNull();
    const first = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    expect(await billing.syncPayment(tenantId, "order1")).toMatchObject({ status: "pending" });
    pay(first.intentId);
    const paid = await billing.syncPayment(tenantId, "order1");
    expect(paid).toMatchObject({ status: "paid", pix: null });
    expect(paid!.paidAt).toBeInstanceOf(Date);
  });
});

describe("a webhook delivery about a payment", () => {
  it("marks the payment paid from what Stripe holds, and tells the app which one", async () => {
    const { tenantId, billing, pay } = await setup();
    const { intentId } = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    pay(intentId);
    const { payload, signature } = delivery("payment_intent.succeeded", {
      id: intentId,
      // The payload lies about the state: only its id and its metadata's presence are used.
      status: "requires_action",
      metadata: { tenant: tenantId, reference: "order1" },
    });
    expect(await billing.handleWebhook(payload, signature)).toEqual({
      status: 200,
      result: "written",
      payment: { tenantId, reference: "order1", status: "paid" },
    });
    expect(await billing.payment(tenantId, "order1")).toMatchObject({ status: "paid" });
  });

  it("answers a second delivery of a paid payment `stale`, still naming it paid", async () => {
    const { tenantId, billing, pay } = await setup();
    const { intentId } = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    pay(intentId);
    const object = { id: intentId, metadata: { tenant: tenantId, reference: "order1" } };
    const first = delivery("payment_intent.succeeded", object);
    await billing.handleWebhook(first.payload, first.signature);
    const again = delivery("payment_intent.succeeded", object);
    expect(await billing.handleWebhook(again.payload, again.signature)).toEqual({
      status: 200,
      result: "stale",
      payment: { tenantId, reference: "order1", status: "paid" },
    });
  });

  it("marks a code that ran out expired", async () => {
    const { tenantId, billing, expire } = await setup();
    const { intentId } = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    expire(intentId);
    const { payload, signature } = delivery("payment_intent.payment_failed", {
      id: intentId,
      metadata: { tenant: tenantId, reference: "order1" },
    });
    expect(await billing.handleWebhook(payload, signature)).toMatchObject({
      result: "written",
      payment: { status: "expired" },
    });
  });

  it("keeps the newer code when an older one only ran out, and takes the older one's money when it was paid", async () => {
    const { tenantId, billing, pay, intents } = await setup();
    const old = await billing.charge({ tenantId, reference: "order1", amount: 5990 });
    const next = await billing.charge({ tenantId, reference: "order1", amount: 11990 });
    const object = { id: old.intentId, metadata: { tenant: tenantId, reference: "order1" } };
    const late = delivery("payment_intent.canceled", object);
    expect(await billing.handleWebhook(late.payload, late.signature)).toMatchObject({
      result: "stale",
      payment: { status: "pending" },
    });
    expect(await billing.payment(tenantId, "order1")).toMatchObject({ intentId: next.intentId });

    // The payer's bank settled the old code in the instant it was being replaced.
    intents[old.intentId] = { ...intents[old.intentId]!, status: "succeeded" };
    pay(old.intentId);
    const paid = delivery("payment_intent.succeeded", object);
    expect(await billing.handleWebhook(paid.payload, paid.signature)).toMatchObject({
      result: "written",
      payment: { status: "paid" },
    });
    expect(await billing.payment(tenantId, "order1")).toMatchObject({ intentId: old.intentId, status: "paid" });
  });

  it("writes nothing when the customer is another tenant's", async () => {
    const { tenantId, billing, lines, intents } = await setup(fakeStripe(() => "someone-else"));
    const reference = "order1";
    intents.pi_x = {
      id: "pi_x",
      status: "succeeded",
      amount: 100,
      currency: "brl",
      customer: "cus_x",
      metadata: { tenant: tenantId, reference },
      next_action: null,
    } as unknown as Intent;
    const { payload, signature } = delivery("payment_intent.succeeded", { id: "pi_x", metadata: { tenant: tenantId, reference } });
    expect(await billing.handleWebhook(payload, signature)).toEqual({ status: 200, result: "owner_mismatch" });
    expect(await billing.payment(tenantId, reference)).toBeNull();
    expect(lines.join("\n")).toContain("owner_mismatch");
    expect(lines.join("\n")).not.toContain(tenantId);
  });

  it("writes nothing for a tenant id nobody has", async () => {
    const ghost = id();
    const fake = fakeStripe(() => ghost);
    const { billing } = await setup(fake);
    fake.intents.pi_g = {
      id: "pi_g",
      status: "succeeded",
      amount: 100,
      currency: "brl",
      customer: "cus_g",
      metadata: { tenant: ghost, reference: "order1" },
      next_action: null,
    } as unknown as Intent;
    const { payload, signature } = delivery("payment_intent.succeeded", { id: "pi_g", metadata: { tenant: ghost, reference: "order1" } });
    expect(await billing.handleWebhook(payload, signature)).toEqual({ status: 200, result: "unknown_tenant" });
    expect((await tenantRef(db, ghost).collection("billing_payments").doc("order1").get()).exists).toBe(false);
  });

  it("ignores an intent this package did not make, without a call to Stripe", async () => {
    const { billing, calls } = await setup();
    const { payload, signature } = delivery("payment_intent.succeeded", { id: "pi_other", metadata: {} });
    expect(await billing.handleWebhook(payload, signature)).toEqual({ status: 200, result: "ignored" });
    expect(calls).toEqual([]);
  });
});
