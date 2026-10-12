"use client"

import * as React from "react"
import {
  CARD_ATTRIBUTE,
  focusTarget,
  otherDialogOpen,
  useTargetBox,
  useTourAnchor,
  type Step,
  type Tour,
} from "@cordwood/tour/react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover"

/** A step the card can show: where it points, and what it says. */
export type TourCardStep = Step & { title: string; text: string }

export type TourCardLabels = {
  skip: string
  back: string
  next: string
  done: string
  /** The step's position, such as "2 of 4". */
  position: (current: number, total: number) => string
}

// The gap between the target and the card, and how far the card keeps from the screen's edges. The
// anchor and the popover must agree on both.
const GAP = 4
const MARGIN = 16
// How far the ring stands off the target.
const RING = 4

/** The ring around the target and the veil over the rest, as one box: a shadow the size of the screen. */
function TourRing({ target }: { target: HTMLElement }) {
  const box = useTargetBox(target)
  if (!box) return null
  return (
    <div
      aria-hidden="true"
      data-slot="tour-ring"
      className="pointer-events-none fixed z-40 rounded-md shadow-[0_0_0_9999px_oklch(0_0_0/0.4)] ring-2 ring-primary"
      style={{
        top: box.top - RING,
        left: box.left - RING,
        width: box.width + RING * 2,
        height: box.height + RING * 2,
      }}
    />
  )
}

/**
 * The card of a tour from `useTour`. It points at the current step's element, rings it, and carries
 * the buttons. Escape skips the tour.
 */
function TourCard<S extends TourCardStep>({
  tour,
  labels,
  className,
}: {
  tour: Tour<S>
  labels: TourCardLabels
  className?: string
}) {
  const card = React.useRef<HTMLDivElement>(null)
  const anchor = useTourAnchor(tour.target, card, { gap: GAP, margin: MARGIN })
  // The last element a step pointed at: where the focus goes when the card closes.
  const last = React.useRef<HTMLElement | null>(null)
  React.useEffect(() => {
    if (tour.target) last.current = tour.target
  }, [tour.target])

  return (
    <Popover
      open={tour.open}
      modal
      onOpenChange={(open) => {
        if (!open) tour.skip()
      }}
    >
      {anchor ? <PopoverAnchor virtualRef={anchor} /> : null}
      {tour.open && tour.target ? <TourRing target={tour.target} /> : null}
      {tour.step ? (
        <PopoverContent
          ref={card}
          tabIndex={-1}
          side="bottom"
          align="start"
          sideOffset={GAP}
          collisionPadding={MARGIN}
          {...{ [CARD_ATTRIBUTE]: "" }}
          className={cn("w-80 gap-3 p-4 motion-reduce:animate-none", className)}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            card.current?.focus()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            // A dialog that opened over the tour keeps the focus it took.
            if (!otherDialogOpen()) focusTarget(last.current)
          }}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <PopoverHeader>
            <p className="text-xs text-muted-foreground tabular-nums">
              {labels.position(tour.index + 1, tour.count)}
            </p>
            <PopoverTitle className="text-balance">{tour.step.title}</PopoverTitle>
            <PopoverDescription className="text-pretty">
              {tour.step.text}
            </PopoverDescription>
          </PopoverHeader>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto"
              onClick={tour.skip}
            >
              {labels.skip}
            </Button>
            {tour.index > 0 ? (
              <Button variant="outline" size="sm" onClick={tour.back}>
                {labels.back}
              </Button>
            ) : null}
            <Button size="sm" onClick={tour.next}>
              {tour.isLast ? labels.done : labels.next}
            </Button>
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}

export { TourCard, TourRing }
