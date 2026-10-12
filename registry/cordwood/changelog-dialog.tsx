"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

/** One release as the dialog shows it. Pass the notes you gave @cordwood/changelog, newest first. */
export type ChangelogNote = {
  version: string
  title: string
  /** The release's day, already written the way your reader reads dates. */
  date?: string
  body?: React.ReactNode
}

export type ChangelogDialogLabels = {
  /** The button's text, such as "What's new". */
  open: string
  /** Read by a screen reader beside the button while there is something unread. */
  unread: string
  title: string
  description?: string
  /** Shown before the first release. */
  empty: string
}

/** The switch for receiving the notes by e-mail, wired to `subscription` and `subscribe`. */
export type ChangelogEmail = {
  on: boolean
  label: string
  hint?: string
  onChange: (on: boolean) => void | Promise<void>
}

/**
 * The release notes behind a button. The button carries a dot while `unread` is true, and opening the
 * dialog calls `onRead`, which is where you call `markRead`.
 */
function ChangelogDialog({
  notes,
  unread,
  onRead,
  labels,
  email,
  className,
}: {
  notes: readonly ChangelogNote[]
  unread: boolean
  onRead: () => void
  labels: ChangelogDialogLabels
  email?: ChangelogEmail
  className?: string
}) {
  const id = React.useId()
  const [saving, setSaving] = React.useState(false)

  async function change(on: boolean) {
    if (!email || saving) return
    setSaving(true)
    try {
      await email.onChange(on)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open && unread) onRead()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className={cn("relative", className)}>
          {labels.open}
          {unread ? (
            <>
              <span
                aria-hidden="true"
                data-slot="changelog-unread"
                className="size-2 rounded-full bg-primary"
              />
              <span className="sr-only">{labels.unread}</span>
            </>
          ) : null}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          {labels.description ? (
            <DialogDescription>{labels.description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        ) : (
          <ul className="-mx-1 flex max-h-[60vh] flex-col gap-5 overflow-y-auto px-1">
            {notes.map((note) => (
              <li key={note.version} className="flex flex-col gap-1 text-sm">
                <p className="text-xs text-muted-foreground tabular-nums">
                  {note.date ? `${note.version} · ${note.date}` : note.version}
                </p>
                <h3 className="font-medium text-balance">{note.title}</h3>
                {note.body ? (
                  <div className="text-pretty text-muted-foreground">{note.body}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {email ? (
          <DialogFooter className="sm:justify-start">
            <div className="flex items-start gap-3">
              <Switch
                id={`${id}-email`}
                checked={email.on}
                disabled={saving}
                aria-describedby={email.hint ? `${id}-hint` : undefined}
                onCheckedChange={change}
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={`${id}-email`}>{email.label}</Label>
                {email.hint ? (
                  <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                    {email.hint}
                  </p>
                ) : null}
              </div>
            </div>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

export { ChangelogDialog }
