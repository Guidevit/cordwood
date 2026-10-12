// @vitest-environment jsdom
import { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ChangelogDialog } from "./changelog-dialog"
import { MembersTable, type MemberRow } from "./members-table"
import { SubscriptionCard, type SubscriptionSummary } from "./subscription-card"
import { SurveyPrompt } from "./survey-prompt"
import { button, click, render } from "./test-utils"
import { UnsubscribeCard } from "./unsubscribe-card"

const text = () => document.body.textContent ?? ""
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)))

describe("the survey prompt", () => {
  const LABELS = {
    question: "How likely are you to recommend us?",
    low: "Not likely",
    high: "Very likely",
    comment: "What is the main reason?",
    submit: "Send",
    dismiss: "Not now",
  }
  const radios = () => [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')]

  it.each([
    ["nps", 11, "0", "10"],
    ["csat", 5, "1", "5"],
    ["ces", 7, "1", "7"],
  ] as const)("offers the scale of %s", async (kind, count, first, last) => {
    await render(<SurveyPrompt kind={kind} labels={LABELS} onAnswer={vi.fn()} onDismiss={vi.fn()} />)
    expect(radios().map((radio) => radio.value)).toEqual(
      Array.from({ length: count }, (_, i) => String(Number(first) + i)),
    )
    expect(radios().at(-1)!.value).toBe(last)
    expect(document.querySelector("legend")!.textContent).toBe(LABELS.question)
  })

  it("asks for the comment and offers to send only once a score is chosen", async () => {
    await render(<SurveyPrompt kind="nps" labels={LABELS} onAnswer={vi.fn()} onDismiss={vi.fn()} />)
    expect(button("Send")).toBeNull()
    expect(document.querySelector("textarea")).toBeNull()
    await click(radios()[9])
    expect(button("Send")).not.toBeNull()
    expect(document.querySelector("textarea")!.maxLength).toBe(500)
  })

  it("sends the score alone when nothing was written", async () => {
    const onAnswer = vi.fn()
    await render(<SurveyPrompt kind="csat" labels={LABELS} onAnswer={onAnswer} onDismiss={vi.fn()} />)
    await click(radios()[3])
    await click(button("Send"))
    expect(onAnswer).toHaveBeenCalledWith({ kind: "csat", score: 4 })
  })

  it("sends once while the answer is on its way", async () => {
    let finish!: () => void
    const onAnswer = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    await render(<SurveyPrompt kind="ces" labels={LABELS} onAnswer={onAnswer} onDismiss={vi.fn()} />)
    await click(radios()[0])
    await click(button("Send"))
    expect(button("Send")!.disabled).toBe(true)
    expect(document.querySelector("form")!.getAttribute("aria-busy")).toBe("true")
    await click(button("Send"))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(button("Send")!.disabled).toBe(false)
  })

  it("is dismissed without an answer", async () => {
    const onDismiss = vi.fn()
    const onAnswer = vi.fn()
    await render(<SurveyPrompt kind="nps" labels={LABELS} onAnswer={onAnswer} onDismiss={onDismiss} />)
    await click(button("Not now"))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onAnswer).not.toHaveBeenCalled()
  })
})

describe("the changelog dialog", () => {
  const LABELS = { open: "What's new", unread: "New release", title: "Release notes", empty: "No release yet." }
  const NOTES = [
    { version: "2.10.0", title: "Saved filters", date: "Oct 11", body: "Keep a filter for later." },
    { version: "2.9.0", title: "Dark theme" },
  ]
  const trigger = () => [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("What's new"))

  it("marks the button while something is unread, for the eye and for a screen reader", async () => {
    const rerender = await render(<ChangelogDialog notes={NOTES} unread onRead={vi.fn()} labels={LABELS} />)
    expect(document.querySelector('[data-slot="changelog-unread"]')!.getAttribute("aria-hidden")).toBe("true")
    expect(trigger()!.textContent).toBe("What's newNew release")
    await rerender(<ChangelogDialog notes={NOTES} unread={false} onRead={vi.fn()} labels={LABELS} />)
    expect(document.querySelector('[data-slot="changelog-unread"]')).toBeNull()
    expect(trigger()!.textContent).toBe("What's new")
  })

  it("lists the releases and reports the read when it opens with something unread", async () => {
    const onRead = vi.fn()
    await render(<ChangelogDialog notes={NOTES} unread onRead={onRead} labels={LABELS} />)
    await click(trigger())
    expect(onRead).toHaveBeenCalledTimes(1)
    const items = [...document.querySelectorAll('[role="dialog"] li')]
    expect(items.map((item) => item.querySelector("h3")!.textContent)).toEqual(["Saved filters", "Dark theme"])
    expect(items[0]!.textContent).toContain("2.10.0 · Oct 11")
    expect(items[0]!.textContent).toContain("Keep a filter for later.")
  })

  it("reports no read when nothing was unread", async () => {
    const onRead = vi.fn()
    await render(<ChangelogDialog notes={NOTES} unread={false} onRead={onRead} labels={LABELS} />)
    await click(trigger())
    expect(onRead).not.toHaveBeenCalled()
  })

  it("says so before the first release", async () => {
    await render(<ChangelogDialog notes={[]} unread={false} onRead={vi.fn()} labels={LABELS} />)
    await click(trigger())
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("No release yet.")
  })

  it("carries the e-mail switch, named by its label and described by its hint", async () => {
    const onChange = vi.fn()
    await render(
      <ChangelogDialog
        notes={NOTES}
        unread={false}
        onRead={vi.fn()}
        labels={LABELS}
        email={{ on: false, label: "Send me these by e-mail", hint: "One message per release.", onChange }}
      />,
    )
    await click(trigger())
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(document.querySelector(`label[for="${toggle.id}"]`)!.textContent).toBe("Send me these by e-mail")
    expect(document.getElementById(toggle.getAttribute("aria-describedby")!)!.textContent).toBe(
      "One message per release.",
    )
    await click(toggle)
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe("the unsubscribe card", () => {
  const LABELS = {
    title: "Stop these e-mails",
    text: "You will stop receiving our release notes.",
    confirm: "Unsubscribe",
    done: "Done. No more release notes by e-mail.",
    failed: "That did not go through. Try again.",
    missing: "This link is incomplete.",
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    window.location.hash = ""
  })

  it("posts the code after # to the route when the person confirms", async () => {
    const fetched = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetched)
    window.location.hash = `#token=${"c".repeat(43)}`
    await render(<UnsubscribeCard endpoint="/api/changelog/unsubscribe-page" labels={LABELS} />)
    expect(fetched).not.toHaveBeenCalled()
    expect(text()).toContain(LABELS.text)
    await click(button("Unsubscribe"))
    await settle()
    expect(fetched).toHaveBeenCalledWith(
      "/api/changelog/unsubscribe-page",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "c".repeat(43) }) }),
    )
    expect(document.querySelector('[role="status"]')!.textContent).toBe(LABELS.done)
    expect(button("Unsubscribe")).toBeNull()
  })

  it.each([
    ["the route refuses", async () => new Response(null, { status: 500 })],
    ["the network fails", async () => Promise.reject(new Error("offline"))],
  ])("says it failed and offers to try again when %s", async (_case, answer) => {
    vi.stubGlobal("fetch", vi.fn(answer))
    window.location.hash = "#token=abc"
    await render(<UnsubscribeCard endpoint="/x" labels={LABELS} />)
    await click(button("Unsubscribe"))
    await settle()
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(LABELS.failed)
    expect(button("Unsubscribe")!.disabled).toBe(false)
  })

  it("offers nothing to confirm for a link with no code", async () => {
    await render(<UnsubscribeCard endpoint="/x" labels={LABELS} />)
    expect(text()).toContain(LABELS.missing)
    expect(button("Unsubscribe")).toBeNull()
  })
})

describe("the subscription card", () => {
  const LABELS = {
    title: "Plan",
    none: "No plan yet.",
    statuses: { active: "Active", trialing: "Trial", past_due: "Payment late" },
    renewsOn: (date: string) => `Renews on ${date}`,
    endsOn: (date: string) => `Ends on ${date}`,
    trialEndsOn: (date: string) => `Trial ends on ${date}`,
    subscribe: "Subscribe",
    manage: "Manage plan",
    payInvoice: "Pay invoice",
  }
  const day = (date: Date) => date.toISOString().slice(0, 10)
  const base: SubscriptionSummary = {
    status: "active",
    currentPeriodEnd: new Date("2026-11-11T00:00:00Z"),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    openInvoiceUrl: null,
  }
  const show = (subscription: SubscriptionSummary | null, on = { onSubscribe: vi.fn(), onManage: vi.fn() }) =>
    render(<SubscriptionCard subscription={subscription} labels={LABELS} formatDate={day} {...on} />)

  it.each([
    ["an active one renews", base, "Active", "Renews on 2026-11-11"],
    ["one set to cancel ends with its period", { ...base, cancelAtPeriodEnd: true }, "Active", "Ends on 2026-11-11"],
    ["one with an end date ends on it", { ...base, cancelAt: new Date("2026-12-01T00:00:00Z") }, "Active", "Ends on 2026-12-01"],
    ["a trial ends", { ...base, status: "trialing", trialEnd: new Date("2026-10-20T00:00:00Z") }, "Trial", "Trial ends on 2026-10-20"],
    ["a status with no label shows as Stripe names it", { ...base, status: "paused" }, "paused", ""],
  ])("%s", async (_case, subscription, status, date) => {
    await show(subscription)
    expect(document.querySelector('[data-slot="badge"]')!.textContent).toBe(status)
    expect(text()).toContain(date)
    expect(button("Manage plan")).not.toBeNull()
    expect(button("Subscribe")).toBeNull()
  })

  it.each([
    ["no subscription", null],
    ["a canceled one", { ...base, status: "canceled" }],
  ])("offers to subscribe with %s", async (_case, subscription) => {
    const on = { onSubscribe: vi.fn(), onManage: vi.fn() }
    await show(subscription, on)
    expect(text()).toContain("No plan yet.")
    await click(button("Subscribe"))
    expect(on.onSubscribe).toHaveBeenCalledTimes(1)
    expect(button("Manage plan")).toBeNull()
  })

  it("links to the open invoice of a late payment", async () => {
    await show({ ...base, status: "past_due", openInvoiceUrl: "https://invoice.stripe.com/i/abc" })
    const link = [...document.querySelectorAll("a")].find((a) => a.textContent === "Pay invoice")!
    expect(link.getAttribute("href")).toBe("https://invoice.stripe.com/i/abc")
    expect(document.querySelector('[data-slot="badge"]')!.textContent).toBe("Payment late")
  })

  it("goes to the portal once while the first click is on its way", async () => {
    let finish!: () => void
    const on = { onSubscribe: vi.fn(), onManage: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))) }
    await show(base, on)
    await click(button("Manage plan"))
    expect(button("Manage plan")!.disabled).toBe(true)
    await click(button("Manage plan"))
    expect(on.onManage).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    expect(button("Manage plan")!.disabled).toBe(false)
  })
})

describe("the members table", () => {
  const LABELS = {
    member: "Member",
    role: "Role",
    actions: "Actions",
    roles: { admin: "Admin", member: "Member" },
    roleOf: (member: MemberRow) => `Role of ${member.email}`,
    remove: "Remove",
    removeTitle: (member: MemberRow) => `Remove ${member.email}?`,
    removeText: "They lose access at once.",
    cancel: "Cancel",
    empty: "Nobody else yet.",
  }
  const MEMBERS: MemberRow[] = [
    { uid: "u1", email: "ana@example.com", name: "Ana", role: "admin" },
    { uid: "u2", email: "bo@example.com", name: null, role: "member" },
  ]
  const show = (props: Partial<Parameters<typeof MembersTable>[0]> = {}) =>
    render(
      <MembersTable
        members={MEMBERS}
        labels={LABELS}
        canManage
        currentUid="u1"
        onChangeRole={vi.fn()}
        onRemove={vi.fn()}
        {...props}
      />,
    )
  const rows = () => [...document.querySelectorAll("tbody tr")]

  it("lists each member with a name, an address and a role", async () => {
    await show({ canManage: false })
    expect(rows().map((row) => row.textContent)).toEqual(["Anaana@example.comAdmin", "bo@example.comMember"])
    expect(document.querySelectorAll("th")).toHaveLength(2)
    expect(document.querySelector('[role="combobox"]')).toBeNull()
    expect(button("Remove")).toBeNull()
  })

  it("lets a manager change and remove everyone but themselves", async () => {
    await show()
    expect(rows()[0]!.querySelector('[role="combobox"]')).toBeNull()
    expect(rows()[0]!.querySelector("button")).toBeNull()
    const picker = rows()[1]!.querySelector('[role="combobox"]')!
    expect(picker.getAttribute("aria-label")).toBe("Role of bo@example.com")
    expect(picker.textContent).toBe("Member")
  })

  it("removes only after the confirmation", async () => {
    const onRemove = vi.fn()
    await show({ onRemove })
    await click(button("Remove"))
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain("Remove bo@example.com?")
    expect(dialog.textContent).toContain("They lose access at once.")
    expect(onRemove).not.toHaveBeenCalled()
    await click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Remove"))
    expect(onRemove).toHaveBeenCalledWith("u2")
  })

  it("removes nobody when the confirmation is cancelled", async () => {
    const onRemove = vi.fn()
    await show({ onRemove })
    await click(button("Remove"))
    await click(button("Cancel"))
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(onRemove).not.toHaveBeenCalled()
  })

  it("says so when there is nobody", async () => {
    await show({ members: [] })
    expect(text()).toBe("Nobody else yet.")
  })
})
