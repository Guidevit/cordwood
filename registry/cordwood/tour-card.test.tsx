// @vitest-environment jsdom
import { act } from "react"
import type { Tour } from "@cordwood/tour/react"
import { describe, expect, it, vi } from "vitest"

import { button, click, render } from "./test-utils"
import { TourCard, type TourCardStep } from "./tour-card"

const LABELS = {
  skip: "Skip",
  back: "Back",
  next: "Next",
  done: "Done",
  position: (current: number, total: number) => `${current} of ${total}`,
}
const STEPS: TourCardStep[] = [
  { target: "list", title: "Your queue", text: "Every open item." },
  { target: "filters", title: "Filters", text: "Narrow the list." },
]

function tourAt(index: number, open = true): Tour<TourCardStep> {
  const target = document.createElement("section")
  target.setAttribute("data-tour", STEPS[index]!.target)
  document.body.append(target)
  return {
    open,
    step: open ? STEPS[index]! : null,
    target: open ? target : null,
    index,
    count: STEPS.length,
    isLast: index === STEPS.length - 1,
    available: true,
    next: vi.fn(),
    back: vi.fn(),
    skip: vi.fn(),
    complete: vi.fn(),
  }
}

const card = () => document.querySelector<HTMLElement>("[data-tour-card]")

describe("the tour card", () => {
  it("shows the step as a dialog named by its title, marked as the tour's own", async () => {
    await render(<TourCard tour={tourAt(0)} labels={LABELS} />)
    expect(card()!.getAttribute("role")).toBe("dialog")
    expect(card()!.textContent).toContain("1 of 2")
    expect(card()!.textContent).toContain("Your queue")
    expect(card()!.textContent).toContain("Every open item.")
    expect(document.activeElement).toBe(card())
  })

  it("offers skip and next on the first step, and no back", async () => {
    const tour = tourAt(0)
    await render(<TourCard tour={tour} labels={LABELS} />)
    expect(button("Back")).toBeNull()
    await click(button("Next"))
    expect(tour.next).toHaveBeenCalledTimes(1)
    await click(button("Skip"))
    expect(tour.skip).toHaveBeenCalledTimes(1)
  })

  it("offers back on a later step, and names the last button for finishing", async () => {
    const tour = tourAt(1)
    await render(<TourCard tour={tour} labels={LABELS} />)
    expect(button("Next")).toBeNull()
    await click(button("Back"))
    expect(tour.back).toHaveBeenCalledTimes(1)
    await click(button("Done"))
    expect(tour.next).toHaveBeenCalledTimes(1)
  })

  it("skips the tour on Escape", async () => {
    const tour = tourAt(0)
    await render(<TourCard tour={tour} labels={LABELS} />)
    await act(async () => {
      card()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    expect(tour.skip).toHaveBeenCalledTimes(1)
  })

  it("rings the target with a box no pointer and no screen reader meets", async () => {
    const tour = tourAt(0)
    tour.target!.getBoundingClientRect = () => new DOMRect(100, 200, 300, 40)
    await render(<TourCard tour={tour} labels={LABELS} />)
    const ring = document.querySelector<HTMLElement>('[data-slot="tour-ring"]')!
    expect(ring.getAttribute("aria-hidden")).toBe("true")
    expect(ring.className).toContain("pointer-events-none")
    expect(ring.style).toMatchObject({ top: "196px", left: "96px", width: "308px", height: "48px" })
  })

  it("renders nothing while the tour is closed", async () => {
    await render(<TourCard tour={tourAt(0, false)} labels={LABELS} />)
    expect(card()).toBeNull()
    expect(document.querySelector('[data-slot="tour-ring"]')).toBeNull()
  })

  it("gives the focus back to the last step's element when it closes", async () => {
    const tour = tourAt(0)
    const rerender = await render(<TourCard tour={tour} labels={LABELS} />)
    await rerender(
      <TourCard tour={{ ...tour, open: false, step: null, target: null }} labels={LABELS} />,
    )
    expect(card()).toBeNull()
    // Radix hands the focus back a moment after the card leaves.
    await vi.waitFor(() => expect(document.activeElement).toBe(tour.target))
  })
})
