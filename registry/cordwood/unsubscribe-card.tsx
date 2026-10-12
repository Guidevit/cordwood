"use client"

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export type UnsubscribeCardLabels = {
  title: string
  /** What confirming does, such as "You will stop receiving our release notes by e-mail." */
  text: string
  confirm: string
  /** Shown after the request was sent. The same whether or not the link named anyone. */
  done: string
  /** Shown when the request could not be sent. */
  failed: string
  /** Shown when the link carries no code. */
  missing: string
}

type State = "loading" | "missing" | "ready" | "sending" | "done" | "failed"

/**
 * The page a message's unsubscribe link opens. It reads the code after `#` in the address and posts it
 * as `{ token }` to `endpoint`, the route that calls `unsubscribe`. The person confirms with a click,
 * so a mail scanner that only opens the link changes nothing.
 */
function UnsubscribeCard({
  endpoint,
  labels,
  className,
}: {
  endpoint: string
  labels: UnsubscribeCardLabels
  className?: string
}) {
  const [state, setState] = React.useState<State>("loading")
  const token = React.useRef<string | null>(null)

  // The address is only known in the browser.
  React.useEffect(() => {
    token.current = new URLSearchParams(window.location.hash.slice(1)).get("token")
    setState(token.current ? "ready" : "missing")
  }, [])

  async function confirm() {
    setState("sending")
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.current }),
      })
      setState(response.ok ? "done" : "failed")
    } catch {
      setState("failed")
    }
  }

  const message =
    state === "done" ? labels.done : state === "missing" ? labels.missing : labels.text

  return (
    <Card data-slot="unsubscribe-card" className={className}>
      <CardHeader>
        <CardTitle className="text-balance">{labels.title}</CardTitle>
        {state === "loading" ? null : (
          <CardDescription role="status" className="text-pretty">
            {message}
          </CardDescription>
        )}
      </CardHeader>
      {state === "failed" ? (
        <CardContent>
          <p role="alert" className="text-sm text-destructive">
            {labels.failed}
          </p>
        </CardContent>
      ) : null}
      {state === "ready" || state === "sending" || state === "failed" ? (
        <CardFooter>
          <Button onClick={confirm} disabled={state === "sending"} aria-busy={state === "sending"}>
            {labels.confirm}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  )
}

export { UnsubscribeCard }
