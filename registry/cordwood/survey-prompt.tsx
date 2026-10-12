"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

export type SurveyKind = "nps" | "csat" | "ces"

export type SurveyAnswer = { kind: SurveyKind; score: number; comment?: string }

export type SurveyPromptLabels = {
  /** The question, such as "How likely are you to recommend us?". */
  question: string
  /** What the lowest and the highest score mean, such as "Not likely" and "Very likely". */
  low: string
  high: string
  /** The label of the optional comment. */
  comment: string
  submit: string
  dismiss: string
}

// The scale each survey is answered on, as @cordwood/surveys checks it.
const SCALES: Record<SurveyKind, { from: number; to: number }> = {
  nps: { from: 0, to: 10 },
  csat: { from: 1, to: 5 },
  ces: { from: 1, to: 7 },
}
const COMMENT_MAX = 500

/**
 * One survey question from @cordwood/surveys. Render it with the kind `ask` answered, send what
 * `onAnswer` receives to the route that calls `answer`, and unmount it in `onDismiss`.
 */
function SurveyPrompt({
  kind,
  labels,
  onAnswer,
  onDismiss,
  className,
}: {
  kind: SurveyKind
  labels: SurveyPromptLabels
  onAnswer: (answer: SurveyAnswer) => void | Promise<void>
  onDismiss: () => void
  className?: string
}) {
  const id = React.useId()
  const [score, setScore] = React.useState<number | null>(null)
  const [comment, setComment] = React.useState("")
  const [sending, setSending] = React.useState(false)
  const { from, to } = SCALES[kind]
  const scores = Array.from({ length: to - from + 1 }, (_, i) => from + i)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (score === null || sending) return
    setSending(true)
    try {
      const text = comment.trim()
      await onAnswer({ kind, score, ...(text ? { comment: text } : {}) })
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      data-slot="survey-prompt"
      onSubmit={submit}
      aria-busy={sending}
      className={cn(
        "flex w-full max-w-md flex-col gap-3 rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10",
        className
      )}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-medium text-balance">{labels.question}</legend>
        <div className="flex flex-wrap gap-1">
          {scores.map((value) => (
            <div key={value} className="min-w-10 flex-1">
              <input
                type="radio"
                id={`${id}-${value}`}
                name={`${id}-score`}
                value={value}
                checked={score === value}
                onChange={() => setScore(value)}
                className="peer sr-only"
              />
              <label
                htmlFor={`${id}-${value}`}
                className="flex h-10 cursor-pointer items-center justify-center rounded-md border border-border tabular-nums transition-[color,background-color,border-color,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] select-none peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 hover:bg-muted active:scale-[0.96] peer-checked:hover:bg-primary motion-reduce:transition-none"
              >
                {value}
              </label>
            </div>
          ))}
        </div>
        <div className="flex justify-between gap-4 text-xs text-muted-foreground">
          <span>{labels.low}</span>
          <span className="text-right">{labels.high}</span>
        </div>
      </fieldset>
      {score !== null ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-comment`}>{labels.comment}</Label>
          <Textarea
            id={`${id}-comment`}
            value={comment}
            maxLength={COMMENT_MAX}
            rows={3}
            onChange={(event) => setComment(event.target.value)}
          />
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {labels.dismiss}
        </Button>
        {score !== null ? (
          <Button type="submit" size="sm" disabled={sending}>
            {labels.submit}
          </Button>
        ) : null}
      </div>
    </form>
  )
}

export { SurveyPrompt }
