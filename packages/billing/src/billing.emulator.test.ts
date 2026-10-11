// Runs against the Firestore emulator (`pnpm test`). Stripe is a stand-in here: the real signature
// check of the SDK, and canned answers for the calls that would reach the network.
import { randomUUID } from "node:crypto";
import { firestore as adminFirestore, tenantRef } from "@cordwood/firebase";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import {
  LiveSubscription,
  OwnerMismatch,
  PriceNotFound,
  createBilling,
  subscriptionOfEvent,
  type BillingConfig,
} from "./index.js";

if (!process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("the Firestore emulator is not running: use `pnpm test`");

const db = adminFirestore();
const SECRET = "whsec_test_secret";
// Built with a key that reaches nothing: only its offline signature helpers are used.
const sdk = new Stripe("sk_test_offline");
const id = () => randomUUID().replaceAll("-", "").slice(0, 20);
const T0 = 1_800_000_000;

type Sub = Stripe.Subscription;

function subscription(overrides: {
  id?: string;
  tenant?: string | null;
  customer?: unknown;
  status?: Stripe.Subscription.Status;
  quantity?: number;
  cancelAtPeriodEnd?: boolean;
  trialEnd?: number | null;
  invoice?: unknown;
}): Sub {
  const tenant = overrides.tenant === undefined ? "none" : overrides.tenant;
  return {
    id: overrides.id ?? `sub_${id()}`,
    status: overrides.status ?? "active",
    metadata: tenant === null ? {} : { tenant },
    customer:
      overrides.customer ??
      ({ id: `cus_${tenant}`, metadata: tenant === null ? {} : { tenant } } as unknown),
    items: {
      data: [
        {
          quantity: overrides.quantity ?? 1,
          current_period_end: T0 + 30 * 86400,
          price: { id: "price_pro", lookup_key: "pro_monthly", recurring: { interval: "month" } },
        },
      ],
    },
    cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    trial_end: overrides.trialEnd ?? null,
    latest_invoice: overrides.invoice ?? null,
  } as unknown as Sub;
}

type Calls = { name: string; args: unknown[] }[];

/** A Stripe whose answers the test sets, recording every call. */
function fakeStripe(state: {
  subscriptions?: Record<string, Sub>;
  customers?: Record<string, unknown>;
  prices?: Record<string, string>;
  openSessions?: string[];
  retrieveFails?: boolean;
}) {
  const calls: Calls = [];
  const record =
    <A extends unknown[], T>(name: string, fn: (...args: A) => T) =>
    async (...args: A) => {
      calls.push({ name, args });
      return fn(...args);
    };
  const customers = state.customers ?? {};
  const stripe = {
    webhooks: sdk.webhooks,
    subscriptions: {
      retrieve: record("subscriptions.retrieve", (subId: string) => {
        if (state.retrieveFails)
          throw Object.assign(new Error("boom sk_live_secret"), { type: "StripeConnectionError" });
        const found = state.subscriptions?.[subId];
        if (!found) throw Object.assign(new Error("no such"), { code: "resource_missing" });
        return found;
      }),
      list: record("subscriptions.list", ({ customer }: { customer: string }) => ({
        data: Object.values(state.subscriptions ?? {}).filter(
          (s) => (s.customer as { id: string }).id === customer,
        ),
      })),
    },
    customers: {
      retrieve: record("customers.retrieve", (cusId: string) => customers[cusId]),
      create: record("customers.create", (params: { metadata: { tenant: string } }) => {
        const created = { id: `cus_new_${id()}`, metadata: params.metadata };
        customers[created.id] = created;
        return created;
      }),
    },
    prices: {
      list: record("prices.list", ({ lookup_keys }: { lookup_keys: string[] }) => ({
        data: lookup_keys.flatMap((k) => (state.prices?.[k] ? [{ id: state.prices[k] }] : [])),
      })),
    },
    checkout: {
      sessions: {
        list: record("checkout.sessions.list", () => ({
          data: (state.openSessions ?? []).map((sid) => ({ id: sid })),
        })),
        expire: record("checkout.sessions.expire", () => ({})),
        create: record("checkout.sessions.create", () => ({
          url: "https://checkout.stripe.com/c/pay/cs_test_1",
        })),
      },
    },
    billingPortal: {
      sessions: {
        create: record("billingPortal.sessions.create", () => ({
          url: "https://billing.stripe.com/p/session/1",
        })),
      },
    },
  };
  return { stripe: stripe as unknown as BillingConfig["stripe"], calls };
}

function billingWith(state: Parameters<typeof fakeStripe>[0], secret: string | undefined = SECRET) {
  const lines: string[] = [];
  const { stripe, calls } = fakeStripe(state);
  const billing = createBilling({
    stripe,
    firestore: db,
    origin: "https://app.example.com",
    webhookSecret: secret,
    log: (line) => lines.push(line),
  });
  return { billing, calls, lines };
}

/** A tenant that exists: something of it is stored. */
async function tenant(): Promise<string> {
  const tenantId = id();
  await tenantRef(db, tenantId).collection("members").doc("someone").set({ role: "admin" });
  return tenantId;
}

/** A delivery signed the way Stripe signs it. */
function delivery(type: string, object: unknown, eventId = `evt_${id()}`) {
  const payload = JSON.stringify({ id: eventId, object: "event", type, data: { object } });
  const signature = sdk.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return { payload, signature, eventId };
}

const stored = async (tenantId: string) =>
  (await tenantRef(db, tenantId).collection("billing").doc("subscription").get()).data();

describe("the subscription an event names", () => {
  const event = (type: string, object: unknown) =>
    ({ type, data: { object } }) as unknown as Stripe.Event;

  it.each([
    ["customer.subscription.updated", { id: "sub_1" }],
    ["checkout.session.completed", { id: "cs_1", subscription: "sub_1" }],
    ["checkout.session.completed", { id: "cs_1", subscription: { id: "sub_1" } }],
    ["invoice.paid", { id: "in_1", parent: { subscription_details: { subscription: "sub_1" } } }],
    ["subscription_schedule.updated", { id: "sched_1", subscription: "sub_1" }],
  ])("is read from %s", (type, object) => {
    expect(subscriptionOfEvent(event(type, object))).toBe("sub_1");
  });

  it.each([
    ["a one-off checkout", "checkout.session.completed", { id: "cs_1", subscription: null }],
    ["an invoice of no subscription", "invoice.paid", { id: "in_1", parent: null }],
    ["a customer event", "customer.updated", { id: "cus_1" }],
    ["a payment", "payment_intent.succeeded", { id: "pi_1" }],
  ])("is none for %s", (_case, type, object) => {
    expect(subscriptionOfEvent(event(type, object))).toBeNull();
  });
});

describe("a webhook delivery", () => {
  it("mirrors the subscription read from Stripe, not the payload", async () => {
    const tenantId = await tenant();
    const sub = subscription({ id: "sub_a", tenant: tenantId, quantity: 3, trialEnd: T0 + 86400 });
    const { billing, calls } = billingWith({ subscriptions: { sub_a: sub } });
    // The payload says canceled: what counts is what Stripe answers now.
    const { payload, signature, eventId } = delivery("customer.subscription.updated", {
      id: "sub_a",
      status: "canceled",
    });
    const before = Date.now();
    expect(await billing.handleWebhook(payload, signature)).toEqual({
      status: 200,
      result: "written",
    });
    expect(calls[0]).toEqual({
      name: "subscriptions.retrieve",
      args: ["sub_a", { expand: ["customer", "latest_invoice"] }],
    });
    const mirror = await billing.subscription(tenantId);
    expect(mirror).toMatchObject({
      customerId: `cus_${tenantId}`,
      subscriptionId: "sub_a",
      status: "active",
      priceId: "price_pro",
      priceLookupKey: "pro_monthly",
      interval: "month",
      quantity: 3,
      currentPeriodEnd: new Date((T0 + 30 * 86400) * 1000),
      trialEnd: new Date((T0 + 86400) * 1000),
      cancelAtPeriodEnd: false,
      cancelAt: null,
      openInvoiceUrl: null,
      lastEventId: eventId,
    });
    expect(mirror!.readAt.getTime()).toBeGreaterThanOrEqual(before - 1);
  });

  it("takes the body as a Buffer too", async () => {
    const tenantId = await tenant();
    const { billing } = billingWith({
      subscriptions: { sub_b: subscription({ id: "sub_b", tenant: tenantId }) },
    });
    const { payload, signature } = delivery("invoice.paid", {
      id: "in_1",
      parent: { subscription_details: { subscription: "sub_b" } },
    });
    expect(await billing.handleWebhook(Buffer.from(payload), signature)).toEqual({
      status: 200,
      result: "written",
    });
  });

  it("says when the period's end is the subscription's end, and where an open invoice is paid", async () => {
    const tenantId = await tenant();
    const sub = subscription({
      id: "sub_c",
      tenant: tenantId,
      status: "past_due",
      cancelAtPeriodEnd: true,
      invoice: { status: "open", hosted_invoice_url: "https://invoice.stripe.com/i/1" },
    });
    const { billing } = billingWith({ subscriptions: { sub_c: sub } });
    const { payload, signature } = delivery("customer.subscription.updated", { id: "sub_c" });
    await billing.handleWebhook(payload, signature);
    expect(await billing.subscription(tenantId)).toMatchObject({
      status: "past_due",
      cancelAtPeriodEnd: true,
      cancelAt: new Date((T0 + 30 * 86400) * 1000),
      openInvoiceUrl: "https://invoice.stripe.com/i/1",
    });
  });

  it("keeps the fields an app stores beside the mirror", async () => {
    const tenantId = await tenant();
    await tenantRef(db, tenantId)
      .collection("billing")
      .doc("subscription")
      .set({ customerId: `cus_${tenantId}`, seatsInUse: 7 });
    const { billing } = billingWith({
      subscriptions: { sub_d: subscription({ id: "sub_d", tenant: tenantId }) },
    });
    const { payload, signature } = delivery("customer.subscription.created", { id: "sub_d" });
    await billing.handleWebhook(payload, signature);
    expect(await stored(tenantId)).toMatchObject({ seatsInUse: 7, subscriptionId: "sub_d" });
  });

  it("is 400 with no signature, and with one that does not match", async () => {
    const { billing, lines, calls } = billingWith({});
    const { payload, signature } = delivery("customer.subscription.updated", { id: "sub_x" });
    expect(await billing.handleWebhook(payload, null)).toEqual({
      status: 400,
      error: "invalid_signature",
    });
    expect(await billing.handleWebhook(`${payload} `, signature)).toEqual({
      status: 400,
      error: "invalid_signature",
    });
    expect(calls).toEqual([]);
    expect(lines).toEqual([
      "[billing] webhook refused: no stripe-signature header",
      "[billing] webhook refused: the signature does not match the secret (rolled on Stripe?)",
    ]);
  });

  it("is 500 without a webhook secret, and says so once per delivery", async () => {
    const { billing, lines } = billingWith({}, "");
    const { payload, signature } = delivery("customer.subscription.updated", { id: "sub_x" });
    expect(await billing.handleWebhook(payload, signature)).toEqual({
      status: 500,
      error: "not_configured",
    });
    expect(lines).toEqual([
      "[billing] no webhook secret: no Stripe event is accepted without one",
    ]);
  });

  it("is 500 when Stripe cannot be read, and logs the error's code, never its message", async () => {
    const { billing, lines } = billingWith({ retrieveFails: true });
    const { payload, signature, eventId } = delivery("customer.subscription.updated", {
      id: "sub_x",
    });
    expect(await billing.handleWebhook(payload, signature)).toEqual({
      status: 500,
      error: "not_written",
    });
    expect(lines).toEqual([`[billing] event ${eventId} not written: StripeConnectionError`]);
    expect(lines.join()).not.toContain("sk_live");
  });

  it("answers 200 `ignored` for an event that names no subscription", async () => {
    const { billing, calls } = billingWith({});
    const { payload, signature } = delivery("payment_intent.succeeded", { id: "pi_1" });
    expect(await billing.handleWebhook(payload, signature)).toEqual({
      status: 200,
      result: "ignored",
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ["no tenant in its metadata", null],
    ["a tenant that is a path", "a/b/c"],
  ])("answers `no_tenant` for a subscription with %s", async (_case, tenantValue) => {
    const { billing } = billingWith({
      subscriptions: { sub_e: subscription({ id: "sub_e", tenant: tenantValue }) },
    });
    const { payload, signature } = delivery("customer.subscription.updated", { id: "sub_e" });
    expect(await billing.handleWebhook(payload, signature)).toEqual({
      status: 200,
      result: "no_tenant",
    });
  });

  it("writes nothing when the customer is another tenant's", async () => {
    const ours = await tenant();
    const sub = subscription({
      id: "sub_f",
      tenant: ours,
      customer: { id: "cus_theirs", metadata: { tenant: "someone-else" } },
    });
    const { billing, lines } = billingWith({ subscriptions: { sub_f: sub } });
    const { payload, signature, eventId } = delivery("customer.subscription.updated", {
      id: "sub_f",
    });
    expect(await billing.handleWebhook(payload, signature)).toEqual({
      status: 200,
      result: "owner_mismatch",
    });
    expect(await billing.subscription(ours)).toBeNull();
    expect(lines).toEqual([
      `[billing] owner_mismatch: event ${eventId}, subscription sub_f, customer cus_theirs; nothing written`,
    ]);
    expect(lines.join()).not.toContain(ours);
  });

  it("writes nothing for a tenant id nobody has", async () => {
    const phantom = id();
    const { billing } = billingWith({
      subscriptions: { sub_g: subscription({ id: "sub_g", tenant: phantom }) },
    });
    const { payload, signature } = delivery("customer.subscription.created", { id: "sub_g" });
    expect(await billing.handleWebhook(payload, signature)).toEqual({
      status: 200,
      result: "unknown_tenant",
    });
    expect(await stored(phantom)).toBeUndefined();
  });

  it("keeps the paying subscription when a late event of an ended one arrives", async () => {
    const tenantId = await tenant();
    const state = {
      subscriptions: {
        sub_new: subscription({ id: "sub_new", tenant: tenantId, status: "active" }),
        sub_old: subscription({ id: "sub_old", tenant: tenantId, status: "canceled" }),
      },
    };
    const { billing } = billingWith(state);
    const first = delivery("customer.subscription.created", { id: "sub_new" });
    await billing.handleWebhook(first.payload, first.signature);
    const late = delivery("customer.subscription.deleted", { id: "sub_old" });
    expect(await billing.handleWebhook(late.payload, late.signature)).toEqual({
      status: 200,
      result: "stale",
    });
    expect(await billing.subscription(tenantId)).toMatchObject({
      subscriptionId: "sub_new",
      status: "active",
    });
  });

  it("keeps the first of two paying subscriptions, and names the duplicate to cancel", async () => {
    const tenantId = await tenant();
    const { billing, lines } = billingWith({
      subscriptions: {
        sub_one: subscription({ id: "sub_one", tenant: tenantId }),
        sub_two: subscription({ id: "sub_two", tenant: tenantId }),
      },
    });
    const one = delivery("customer.subscription.created", { id: "sub_one" });
    const two = delivery("customer.subscription.created", { id: "sub_two" });
    await billing.handleWebhook(one.payload, one.signature);
    expect(await billing.handleWebhook(two.payload, two.signature)).toEqual({
      status: 200,
      result: "duplicate",
    });
    expect(await billing.subscription(tenantId)).toMatchObject({ subscriptionId: "sub_one" });
    expect(lines[0]).toContain("duplicate");
    expect(lines[0]).toContain("sub_two");
  });

  it("lets a new subscription take over once the stored one ended", async () => {
    const tenantId = await tenant();
    const state = {
      subscriptions: {
        sub_1: subscription({ id: "sub_1", tenant: tenantId, status: "canceled" }),
        sub_2: subscription({ id: "sub_2", tenant: tenantId, status: "active" }),
      },
    };
    const { billing } = billingWith(state);
    const ended = delivery("customer.subscription.deleted", { id: "sub_1" });
    const again = delivery("customer.subscription.created", { id: "sub_2" });
    await billing.handleWebhook(ended.payload, ended.signature);
    expect(await billing.handleWebhook(again.payload, again.signature)).toEqual({
      status: 200,
      result: "written",
    });
    expect(await billing.subscription(tenantId)).toMatchObject({ subscriptionId: "sub_2" });
  });

  it("does not let an earlier read replace a later one", async () => {
    const tenantId = await tenant();
    const { billing } = billingWith({
      subscriptions: { sub_h: subscription({ id: "sub_h", tenant: tenantId, status: "active" }) },
    });
    // A mirror whose read is stamped in the future: every delivery now read Stripe before it.
    await tenantRef(db, tenantId)
      .collection("billing")
      .doc("subscription")
      .set({
        customerId: `cus_${tenantId}`,
        subscriptionId: "sub_h",
        status: "canceled",
        lastEventId: "evt_later",
        readAt: new Date(Date.now() + 60_000),
      });
    const { payload, signature } = delivery("customer.subscription.updated", { id: "sub_h" });
    expect(await billing.handleWebhook(payload, signature)).toEqual({
      status: 200,
      result: "stale",
    });
    expect(await stored(tenantId)).toMatchObject({ status: "canceled", lastEventId: "evt_later" });
  });

  it("mirrors a deleted customer's subscription only on the tenant that held that customer", async () => {
    const holder = await tenant();
    const stranger = await tenant();
    await tenantRef(db, holder)
      .collection("billing")
      .doc("subscription")
      .set({ customerId: "cus_gone" });
    const gone = { id: "cus_gone", deleted: true };
    const { billing } = billingWith({
      subscriptions: {
        sub_i: subscription({ id: "sub_i", tenant: holder, customer: gone, status: "canceled" }),
        sub_j: subscription({ id: "sub_j", tenant: stranger, customer: gone, status: "canceled" }),
      },
    });
    const ours = delivery("customer.subscription.deleted", { id: "sub_i" });
    const theirs = delivery("customer.subscription.deleted", { id: "sub_j" });
    expect(await billing.handleWebhook(ours.payload, ours.signature)).toMatchObject({
      result: "written",
    });
    expect(await billing.handleWebhook(theirs.payload, theirs.signature)).toMatchObject({
      result: "owner_mismatch",
    });
    expect(await billing.subscription(holder)).toMatchObject({ status: "canceled" });
    expect(await billing.subscription(stranger)).toBeNull();
  });
});

describe("a tenant's subscription", () => {
  it("is null before any was mirrored, even with a customer kept", async () => {
    const tenantId = await tenant();
    const { billing } = billingWith({});
    expect(await billing.subscription(tenantId)).toBeNull();
    await tenantRef(db, tenantId)
      .collection("billing")
      .doc("subscription")
      .set({ customerId: "cus_1" });
    expect(await billing.subscription(tenantId)).toBeNull();
  });
});

describe("opening Checkout", () => {
  const input = (tenantId: string) => ({
    tenantId,
    price: "pro_monthly",
    email: "owner@example.org",
    successPath: "/billing?checkout=done",
    cancelPath: "/billing",
  });

  it("makes the tenant's customer once, keeps its id and opens the session", async () => {
    const tenantId = await tenant();
    const { billing, calls } = billingWith({ prices: { pro_monthly: "price_pro" } });
    expect(await billing.checkout({ ...input(tenantId), quantity: 4 })).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_1",
    );
    const created = calls.find((c) => c.name === "customers.create")!;
    expect(created.args).toEqual([
      { email: "owner@example.org", metadata: { tenant: tenantId } },
      { idempotencyKey: `cordwood-customer-${tenantId}` },
    ]);
    const customerId = (await stored(tenantId))!.customerId as string;
    expect(customerId).toMatch(/^cus_new_/);
    const session = calls.find((c) => c.name === "checkout.sessions.create")!.args[0];
    expect(session).toEqual({
      mode: "subscription",
      customer: customerId,
      client_reference_id: tenantId,
      line_items: [{ price: "price_pro", quantity: 4 }],
      metadata: { tenant: tenantId },
      subscription_data: { metadata: { tenant: tenantId } },
      success_url: "https://app.example.com/billing?checkout=done",
      cancel_url: "https://app.example.com/billing",
    });

    // A second click reuses the customer Stripe confirms is this tenant's.
    await billing.checkout(input(tenantId));
    expect(calls.filter((c) => c.name === "customers.create")).toHaveLength(1);
  });

  it("passes other session parameters through, and never lets them replace its own", async () => {
    const tenantId = await tenant();
    const { billing, calls } = billingWith({ prices: { pro_monthly: "price_pro" } });
    await billing.checkout({
      ...input(tenantId),
      session: {
        locale: "pt-BR",
        allow_promotion_codes: true,
        ...({ mode: "payment", metadata: { tenant: "someone-else" } } as object),
      },
    });
    expect(calls.find((c) => c.name === "checkout.sessions.create")!.args[0]).toMatchObject({
      locale: "pt-BR",
      allow_promotion_codes: true,
      mode: "subscription",
      metadata: { tenant: tenantId },
    });
  });

  it("sets a trial end at least 48 hours away, and charges at once for a nearer one", async () => {
    const tenantId = await tenant();
    const { billing, calls } = billingWith({ prices: { pro_monthly: "price_pro" } });
    const now = new Date("2026-10-11T12:00:00Z");
    const far = new Date("2026-10-13T12:00:00Z");
    const near = new Date("2026-10-13T11:59:59Z");
    await billing.checkout({ ...input(tenantId), now, trialEnd: far });
    await billing.checkout({ ...input(tenantId), now, trialEnd: near });
    const [first, second] = calls
      .filter((c) => c.name === "checkout.sessions.create")
      .map((c) => (c.args[0] as { subscription_data: object }).subscription_data);
    expect(first).toEqual({ metadata: { tenant: tenantId }, trial_end: far.getTime() / 1000 });
    expect(second).toEqual({ metadata: { tenant: tenantId } });
  });

  it("expires the sessions an earlier click left open", async () => {
    const tenantId = await tenant();
    const { billing, calls } = billingWith({
      prices: { pro_monthly: "price_pro" },
      openSessions: ["cs_old_1", "cs_old_2"],
    });
    await billing.checkout(input(tenantId));
    expect(calls.filter((c) => c.name === "checkout.sessions.expire").map((c) => c.args[0])).toEqual(
      ["cs_old_1", "cs_old_2"],
    );
  });

  it("refuses while the tenant has a live subscription", async () => {
    const tenantId = await tenant();
    const customer = { id: "cus_live", metadata: { tenant: tenantId } };
    await tenantRef(db, tenantId)
      .collection("billing")
      .doc("subscription")
      .set({ customerId: "cus_live" });
    const { billing, calls } = billingWith({
      prices: { pro_monthly: "price_pro" },
      customers: { cus_live: customer },
      subscriptions: {
        sub_live: subscription({ id: "sub_live", tenant: tenantId, customer, status: "past_due" }),
      },
    });
    await expect(billing.checkout(input(tenantId))).rejects.toBeInstanceOf(LiveSubscription);
    expect(calls.some((c) => c.name === "checkout.sessions.create")).toBe(false);
  });

  it("refuses a kept customer that Stripe says is another tenant's", async () => {
    const tenantId = await tenant();
    await tenantRef(db, tenantId)
      .collection("billing")
      .doc("subscription")
      .set({ customerId: "cus_theirs" });
    const { billing, calls } = billingWith({
      prices: { pro_monthly: "price_pro" },
      customers: { cus_theirs: { id: "cus_theirs", metadata: { tenant: "someone-else" } } },
    });
    await expect(billing.checkout(input(tenantId))).rejects.toBeInstanceOf(OwnerMismatch);
    expect(calls.some((c) => c.name === "customers.create")).toBe(false);
  });

  it("replaces a kept customer that was deleted on Stripe", async () => {
    const tenantId = await tenant();
    await tenantRef(db, tenantId)
      .collection("billing")
      .doc("subscription")
      .set({ customerId: "cus_gone" });
    const { billing, calls } = billingWith({
      prices: { pro_monthly: "price_pro" },
      customers: { cus_gone: { id: "cus_gone", deleted: true } },
    });
    await billing.checkout(input(tenantId));
    expect(calls.find((c) => c.name === "customers.create")!.args[1]).toEqual({
      idempotencyKey: `cordwood-customer-${tenantId}-after-cus_gone`,
    });
    expect((await stored(tenantId))!.customerId).toMatch(/^cus_new_/);
  });

  it("throws when no active price has the lookup key", async () => {
    const tenantId = await tenant();
    const { billing } = billingWith({ prices: {} });
    await expect(billing.checkout(input(tenantId))).rejects.toBeInstanceOf(PriceNotFound);
  });

  it.each(["billing", "//evil.example.net/x", "https://evil.example.net"])(
    "refuses the return path %j before anything reaches Stripe",
    async (path) => {
      const tenantId = await tenant();
      const { billing, calls } = billingWith({ prices: { pro_monthly: "price_pro" } });
      await expect(billing.checkout({ ...input(tenantId), successPath: path })).rejects.toThrow(
        "must start with one /",
      );
      expect(calls).toEqual([]);
    },
  );
});

describe("opening the customer portal", () => {
  it("opens it for the tenant's checked customer with a live subscription", async () => {
    const tenantId = await tenant();
    const customer = { id: "cus_p", metadata: { tenant: tenantId } };
    await tenantRef(db, tenantId)
      .collection("billing")
      .doc("subscription")
      .set({ customerId: "cus_p" });
    const { billing, calls } = billingWith({
      customers: { cus_p: customer },
      subscriptions: { sub_p: subscription({ id: "sub_p", tenant: tenantId, customer }) },
    });
    expect(
      await billing.portal({ tenantId, returnPath: "/billing", configuration: "bpc_1", locale: "pt-BR" }),
    ).toBe("https://billing.stripe.com/p/session/1");
    expect(calls.find((c) => c.name === "billingPortal.sessions.create")!.args[0]).toEqual({
      customer: "cus_p",
      return_url: "https://app.example.com/billing",
      configuration: "bpc_1",
      locale: "pt-BR",
    });
  });

  it("is null for a tenant that never subscribed", async () => {
    const tenantId = await tenant();
    const { billing, calls } = billingWith({});
    expect(await billing.portal({ tenantId, returnPath: "/billing" })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("is null once the subscription ended", async () => {
    const tenantId = await tenant();
    const customer = { id: "cus_q", metadata: { tenant: tenantId } };
    await tenantRef(db, tenantId)
      .collection("billing")
      .doc("subscription")
      .set({ customerId: "cus_q" });
    const { billing } = billingWith({
      customers: { cus_q: customer },
      subscriptions: {
        sub_q: subscription({ id: "sub_q", tenant: tenantId, customer, status: "canceled" }),
      },
    });
    expect(await billing.portal({ tenantId, returnPath: "/billing" })).toBeNull();
  });

  it("refuses a kept customer that is another tenant's", async () => {
    const tenantId = await tenant();
    await tenantRef(db, tenantId)
      .collection("billing")
      .doc("subscription")
      .set({ customerId: "cus_r" });
    const { billing } = billingWith({
      customers: { cus_r: { id: "cus_r", metadata: { tenant: "someone-else" } } },
    });
    await expect(billing.portal({ tenantId, returnPath: "/billing" })).rejects.toBeInstanceOf(
      OwnerMismatch,
    );
  });
});

describe("the app's origin", () => {
  it.each(["app.example.com", "ftp://app.example.com", ""])("is refused as %j", (origin) => {
    const { stripe } = fakeStripe({});
    expect(() => createBilling({ stripe, firestore: db, origin })).toThrow("http(s) origin");
  });

  it("drops a path it was given", async () => {
    const tenantId = await tenant();
    const { stripe, calls } = fakeStripe({ prices: { pro_monthly: "price_pro" } });
    const billing = createBilling({
      stripe,
      firestore: db,
      origin: "https://app.example.com/some/page",
    });
    await billing.checkout({
      tenantId,
      price: "pro_monthly",
      successPath: "/ok",
      cancelPath: "/no",
    });
    expect(calls.find((c) => c.name === "checkout.sessions.create")!.args[0]).toMatchObject({
      success_url: "https://app.example.com/ok",
    });
  });
});
