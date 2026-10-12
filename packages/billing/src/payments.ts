// One-off payments: a charge for something a tenant buys once, paid by Pix, and its mirror in Firestore.
import { isDocumentId, tenantRef } from "@cordwood/firebase";
import { Timestamp, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import type Stripe from "stripe";
import { customerOf } from "./customer.js";
import { tenantExists, type MirrorWrite } from "./mirror.js";

export type ChargeStripe = Pick<Stripe, "customers" | "paymentIntents">;

/** Each payment's mirror: tenants/{tenantId}/billing_payments/{reference}. */
export const PAYMENTS = "billing_payments";

/**
 * `pending`: the code was issued and nobody has paid it yet. `paid`: the money arrived. `expired`: the
 * code can no longer be paid (it ran out, or it was replaced), so the next `charge` issues another.
 */
export type PaymentStatus = "pending" | "paid" | "expired";

/** What the payer needs while a Pix charge is pending. */
export type PixCode = {
  /** The "copia e cola" text, which is also what the QR code holds. */
  code: string;
  /** Stripe's own image of the QR code. Null when Stripe sent none: draw one from `code`. */
  qrPng: string | null;
  qrSvg: string | null;
  expiresAt: Date | null;
  /** Stripe's hosted page with the same code. */
  instructionsUrl: string | null;
};

export type PaymentMirror = {
  /** The Stripe PaymentIntent. */
  intentId: string;
  status: PaymentStatus;
  /** In the currency's smallest unit: centavos for BRL. */
  amount: number;
  currency: string;
  paidAt: Date | null;
  /** Set only while `status` is `pending`. */
  pix: PixCode | null;
  readAt: Date;
};

export type ChargeInput = {
  /** From the verified session, never from the request. */
  tenantId: string;
  /**
   * What is being paid for, as a document id of the app's own: an order's id, an event's id. One
   * reference is paid once.
   */
  reference: string;
  /** In the currency's smallest unit: 14900 is R$ 149,00. */
  amount: number;
  /** Default `brl`, the one currency Pix takes. */
  currency?: string;
  /** The payer's e-mail: on the customer when it is created, and on the payment's billing details. */
  email?: string | null;
  /**
   * The payer's name and CPF or CNPJ. A Stripe account in Brazil needs neither. An account outside
   * Latin America selling to Brazil must send the tax id.
   */
  payerName?: string;
  payerTaxId?: string;
  /** Shown on Stripe's dashboard and on its hosted page. */
  description?: string;
  /** How long the code can be paid, up to 14 days. Default: Stripe's own. */
  expiresInSeconds?: number;
};

/** The reference is already paid: answer 409, and show what was bought. */
export class AlreadyPaid extends Error {
  override name = "AlreadyPaid";
  constructor(reference: string) {
    super(`${reference} is already paid`);
  }
}

export function paymentRef(db: Firestore, tenantId: string, reference: string): DocumentReference {
  return tenantRef(db, tenantId).collection(PAYMENTS).doc(reference);
}

const date = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000) : null);

/** A PaymentIntent as the mirror keeps it. `now` decides whether a code still unpaid has run out. */
export function paymentOf(intent: Stripe.PaymentIntent, readAt: Date): PaymentMirror {
  const shown = intent.next_action?.pix_display_qr_code;
  const expiresAt = date(shown?.expires_at);
  const open =
    (intent.status === "requires_action" || intent.status === "processing") &&
    (expiresAt === null || expiresAt > readAt);
  const status: PaymentStatus = intent.status === "succeeded" ? "paid" : open ? "pending" : "expired";
  return {
    intentId: intent.id,
    status,
    amount: intent.amount,
    currency: intent.currency,
    paidAt: null,
    pix:
      status === "pending" && shown?.data
        ? {
            code: shown.data,
            qrPng: shown.image_url_png ?? null,
            qrSvg: shown.image_url_svg ?? null,
            expiresAt,
            instructionsUrl: shown.hosted_instructions_url ?? null,
          }
        : null,
    readAt,
  };
}

type Stored = {
  intentId?: string;
  status?: PaymentStatus;
  amount?: number;
  currency?: string;
  paidAt?: Timestamp | null;
  pix?: (Omit<PixCode, "expiresAt"> & { expiresAt: Timestamp | null }) | null;
  readAt?: Timestamp;
};

function mirrorOfStored(stored: Stored | undefined): PaymentMirror | null {
  if (!stored?.intentId || !stored.status || !stored.readAt) return null;
  return {
    intentId: stored.intentId,
    status: stored.status,
    amount: stored.amount ?? 0,
    currency: stored.currency ?? "",
    paidAt: stored.paidAt?.toDate() ?? null,
    pix: stored.pix ? { ...stored.pix, expiresAt: stored.pix.expiresAt?.toDate() ?? null } : null,
    readAt: stored.readAt.toDate(),
  };
}

export async function readPayment(db: Firestore, tenantId: string, reference: string): Promise<PaymentMirror | null> {
  if (!isDocumentId(reference)) return null;
  return mirrorOfStored((await paymentRef(db, tenantId, reference).get()).data() as Stored | undefined);
}

/**
 * Rewrites a payment's mirror. A paid mirror is never replaced by anything else, a state read from
 * Stripe earlier never replaces one read later, and an older code that only ran out never replaces
 * the code issued after it. An older code that was paid does: the money arrived.
 */
export async function writePayment(
  db: Firestore,
  tenantId: string,
  reference: string,
  mirror: PaymentMirror,
): Promise<MirrorWrite> {
  const tenant = tenantRef(db, tenantId);
  const ref = tenant.collection(PAYMENTS).doc(reference);
  return db.runTransaction(async (tx) => {
    const stored = (await tx.get(ref)).data() as Stored | undefined;
    if (stored === undefined && !(await tenantExists(tenant))) return "unknown_tenant";
    if (stored?.status === "paid") return stored.intentId === mirror.intentId ? "stale" : "duplicate";
    const sameIntent = stored?.intentId === undefined || stored.intentId === mirror.intentId;
    if (!sameIntent && mirror.status !== "paid") return "stale";
    if (sameIntent && stored?.readAt !== undefined && stored.readAt.toMillis() > mirror.readAt.getTime())
      return "stale";
    tx.set(ref, {
      intentId: mirror.intentId,
      status: mirror.status,
      amount: mirror.amount,
      currency: mirror.currency,
      paidAt: mirror.status === "paid" ? Timestamp.fromDate(mirror.readAt) : null,
      pix: mirror.pix
        ? { ...mirror.pix, expiresAt: mirror.pix.expiresAt ? Timestamp.fromDate(mirror.pix.expiresAt) : null }
        : null,
      readAt: Timestamp.fromDate(mirror.readAt),
    });
    return "written";
  });
}

/** Whether the intent was made by this package for this tenant and reference. */
const belongs = (intent: Stripe.PaymentIntent, tenantId: string, reference: string) =>
  intent.metadata?.tenant === tenantId && intent.metadata?.reference === reference;

/**
 * The payment's state as Stripe holds it now, written to the mirror and answered. Null when nothing
 * was ever charged under the reference. This is what a "I have paid" button calls, and what makes a
 * payment visible on a machine no webhook reaches.
 */
export async function syncPayment(
  stripe: ChargeStripe,
  db: Firestore,
  tenantId: string,
  reference: string,
): Promise<PaymentMirror | null> {
  const stored = await readPayment(db, tenantId, reference);
  if (!stored || stored.status === "paid") return stored;
  const readAt = new Date();
  const intent = await stripe.paymentIntents.retrieve(stored.intentId);
  if (!belongs(intent, tenantId, reference)) return stored;
  await writePayment(db, tenantId, reference, paymentOf(intent, readAt));
  return readPayment(db, tenantId, reference);
}

/**
 * A Pix charge for `reference`. A code still open for the same amount is answered again, so a page
 * reloaded shows the same QR code and one purchase has one code. A code that ran out, or one for
 * another amount, is cancelled and replaced. Throws `AlreadyPaid` once the money arrived.
 */
export async function openCharge(stripe: ChargeStripe, db: Firestore, input: ChargeInput): Promise<PaymentMirror> {
  const { tenantId, reference, amount } = input;
  const currency = (input.currency ?? "brl").toLowerCase();
  if (!isDocumentId(reference)) throw new Error("a payment's reference must be a document id");
  if (!Number.isSafeInteger(amount) || amount <= 0)
    throw new Error("an amount is a positive whole number of the currency's smallest unit");

  const current = await syncPayment(stripe, db, tenantId, reference);
  if (current?.status === "paid") throw new AlreadyPaid(reference);
  if (current?.status === "pending" && current.pix && current.amount === amount && current.currency === currency)
    return current;
  if (current) {
    // The old code must not be payable once another is on screen. A refusal here is a code already
    // paid or already closed: the read after it says which.
    try {
      await stripe.paymentIntents.cancel(current.intentId);
    } catch {
      const after = await syncPayment(stripe, db, tenantId, reference);
      if (after?.status === "paid") throw new AlreadyPaid(reference);
    }
  }

  const customer = await customerOf(stripe, db, tenantId, input.email);
  const readAt = new Date();
  const intent = await stripe.paymentIntents.create(
    {
      amount,
      currency,
      customer,
      confirm: true,
      allowed_payment_method_types: ["pix"],
      payment_method_data: {
        type: "pix",
        ...(input.email || input.payerName || input.payerTaxId
          ? {
              billing_details: {
                ...(input.email ? { email: input.email } : {}),
                ...(input.payerName ? { name: input.payerName } : {}),
                ...(input.payerTaxId ? { tax_id: input.payerTaxId } : {}),
              },
            }
          : {}),
      },
      ...(input.expiresInSeconds
        ? { payment_method_options: { pix: { expires_after_seconds: input.expiresInSeconds } } }
        : {}),
      ...(input.description ? { description: input.description } : {}),
      metadata: { tenant: tenantId, reference },
    },
    // Two clicks at once make one code. The key changes with the code it replaces and the amount.
    { idempotencyKey: `cordwood-payment-${tenantId}-${reference}-${amount}-after-${current?.intentId ?? "none"}` },
  );
  const mirror = paymentOf(intent, readAt);
  if (current) {
    // The mirror still names the code just cancelled: it gives way to the new one.
    await paymentRef(db, tenantId, reference).delete();
  }
  await writePayment(db, tenantId, reference, mirror);
  return mirror;
}

/** What a webhook delivery about a payment did, for the app to act on: open the order, send the receipt. */
export type PaymentNotice = { tenantId: string; reference: string; status: PaymentStatus };

/**
 * One `payment_intent.*` event. The intent is read from Stripe now, since the payload may be old, and
 * its tenant is checked against the customer's before anything is written. An intent this package
 * did not make (no `metadata.reference`) is ignored without a call to Stripe.
 */
export async function processPaymentEvent(
  stripe: ChargeStripe,
  db: Firestore,
  event: Stripe.Event,
  log: (line: string) => void,
): Promise<{ result: MirrorWrite | "ignored" | "no_tenant"; payment?: PaymentNotice }> {
  const payload = event.data.object as { id?: string; metadata?: Record<string, string> | null };
  if (!payload.id || payload.metadata?.reference === undefined) return { result: "ignored" };
  const readAt = new Date();
  const intent = await stripe.paymentIntents.retrieve(payload.id, { expand: ["customer"] });
  const tenantId = intent.metadata?.tenant ?? "";
  const reference = intent.metadata?.reference ?? "";
  if (!isDocumentId(tenantId) || !isDocumentId(reference)) return { result: "no_tenant" };
  const customer = intent.customer;
  if (!customer || typeof customer === "string" || customer.deleted || customer.metadata?.tenant !== tenantId) {
    log(`[billing] owner_mismatch: event ${event.id}, payment ${intent.id}; nothing written`);
    return { result: "owner_mismatch" };
  }
  const result = await writePayment(db, tenantId, reference, paymentOf(intent, readAt));
  if (result === "unknown_tenant" || result === "duplicate")
    log(`[billing] ${result}: event ${event.id}, payment ${intent.id}; nothing written`);
  if (result === "unknown_tenant") return { result };
  const stored = await readPayment(db, tenantId, reference);
  return stored ? { result, payment: { tenantId, reference, status: stored.status } } : { result };
}
