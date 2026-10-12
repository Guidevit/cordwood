"use client"

import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/** The fields of @cordwood/billing's subscription mirror that the card reads. */
export type SubscriptionSummary = {
  status: string
  currentPeriodEnd: Date | null
  trialEnd: Date | null
  cancelAtPeriodEnd: boolean
  cancelAt: Date | null
  openInvoiceUrl: string | null
}

export type SubscriptionCardLabels = {
  title: string
  /** Shown while the tenant has no subscription. */
  none: string
  /** Each Stripe status in your reader's words, such as `{ active: "Active", past_due: "Payment late" }`. */
  statuses: Readonly<Record<string, string>>
  /** Each takes the date already formatted, such as `(date) => \`Renews on ${date}\``. */
  renewsOn: (date: string) => string
  endsOn: (date: string) => string
  trialEndsOn: (date: string) => string
  subscribe: string
  manage: string
  payInvoice: string
}

// A subscription Stripe still counts as existing: the tenant manages it instead of buying another.
const LIVE = new Set(["trialing", "active", "past_due", "unpaid", "incomplete", "paused"])
// The statuses that need the person to act.
const TROUBLED = new Set(["past_due", "unpaid", "incomplete"])

function when(subscription: SubscriptionSummary, labels: SubscriptionCardLabels, format: (date: Date) => string) {
  if (subscription.cancelAt) return labels.endsOn(format(subscription.cancelAt))
  if (subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd)
    return labels.endsOn(format(subscription.currentPeriodEnd))
  if (subscription.status === "trialing" && subscription.trialEnd)
    return labels.trialEndsOn(format(subscription.trialEnd))
  if (subscription.status === "active" && subscription.currentPeriodEnd)
    return labels.renewsOn(format(subscription.currentPeriodEnd))
  return null
}

/**
 * A tenant's subscription from @cordwood/billing: its status, its next date, and the way to Checkout
 * or to the customer portal. `onSubscribe` and `onManage` call your routes and send the browser on.
 */
function SubscriptionCard({
  subscription,
  labels,
  onSubscribe,
  onManage,
  formatDate = (date) => date.toLocaleDateString(),
  className,
}: {
  subscription: SubscriptionSummary | null
  labels: SubscriptionCardLabels
  onSubscribe: () => void | Promise<void>
  onManage: () => void | Promise<void>
  formatDate?: (date: Date) => string
  className?: string
}) {
  const [busy, setBusy] = React.useState(false)
  const live = subscription !== null && LIVE.has(subscription.status)
  const date = subscription && live ? when(subscription, labels, formatDate) : null

  async function go(action: () => void | Promise<void>) {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-slot="subscription-card" className={className}>
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        {live ? null : <CardDescription className="text-pretty">{labels.none}</CardDescription>}
      </CardHeader>
      {live ? (
        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Badge variant={TROUBLED.has(subscription.status) ? "destructive" : "secondary"}>
            {labels.statuses[subscription.status] ?? subscription.status}
          </Badge>
          {date ? <span className="text-muted-foreground tabular-nums">{date}</span> : null}
        </CardContent>
      ) : null}
      <CardFooter className="flex flex-wrap gap-2">
        {live ? (
          <Button variant="outline" disabled={busy} aria-busy={busy} onClick={() => go(onManage)}>
            {labels.manage}
          </Button>
        ) : (
          <Button disabled={busy} aria-busy={busy} onClick={() => go(onSubscribe)}>
            {labels.subscribe}
          </Button>
        )}
        {live && subscription.openInvoiceUrl ? (
          <Button asChild>
            <a href={subscription.openInvoiceUrl}>{labels.payInvoice}</a>
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  )
}

export { SubscriptionCard }
