"use client"

import * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/** A member as @cordwood/auth's `members.list` answers one. */
export type MemberRow = { uid: string; email: string; name: string | null; role: string }

export type MembersTableLabels = {
  member: string
  role: string
  /** The header of the column of actions, read by a screen reader only. */
  actions: string
  /** Each role in your reader's words, such as `{ admin: "Admin", member: "Member" }`. */
  roles: Readonly<Record<string, string>>
  /** The accessible name of a row's role picker, such as `(m) => \`Role of ${m.email}\``. */
  roleOf: (member: MemberRow) => string
  remove: string
  /** The confirmation's title, such as `(m) => \`Remove ${m.email}?\``. */
  removeTitle: (member: MemberRow) => string
  /** What removing does, such as "They lose access at once." */
  removeText: string
  cancel: string
  /** Shown when the tenant has nobody else. */
  empty: string
}

/**
 * A tenant's members, with the role of each and the way to change it or remove them. `onChangeRole`
 * and `onRemove` call your routes. Pass `canManage` from the permission the server checked, and
 * `currentUid` so nobody demotes or removes themselves by a slip.
 */
function MembersTable({
  members,
  labels,
  canManage,
  currentUid,
  onChangeRole,
  onRemove,
  className,
}: {
  members: readonly MemberRow[]
  labels: MembersTableLabels
  canManage: boolean
  currentUid?: string
  onChangeRole: (uid: string, role: string) => void | Promise<void>
  onRemove: (uid: string) => void | Promise<void>
  className?: string
}) {
  const [busy, setBusy] = React.useState<string | null>(null)

  async function run(uid: string, action: () => void | Promise<void>) {
    if (busy) return
    setBusy(uid)
    try {
      await action()
    } finally {
      setBusy(null)
    }
  }

  if (members.length === 0)
    return <p className="text-sm text-muted-foreground">{labels.empty}</p>

  return (
    <Table data-slot="members-table" className={className}>
      <TableHeader>
        <TableRow>
          <TableHead>{labels.member}</TableHead>
          <TableHead>{labels.role}</TableHead>
          {canManage ? (
            <TableHead>
              <span className="sr-only">{labels.actions}</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => {
          const editable = canManage && member.uid !== currentUid
          return (
            <TableRow key={member.uid} aria-busy={busy === member.uid}>
              <TableCell>
                <div className="flex flex-col">
                  <span className="font-medium">{member.name ?? member.email}</span>
                  {member.name ? (
                    <span className="text-xs text-muted-foreground">{member.email}</span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                {editable ? (
                  <Select
                    value={member.role}
                    disabled={busy !== null}
                    onValueChange={(role) => run(member.uid, () => onChangeRole(member.uid, role))}
                  >
                    <SelectTrigger size="sm" aria-label={labels.roleOf(member)}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(labels.roles).map(([role, label]) => (
                        <SelectItem key={role} value={role}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  (labels.roles[member.role] ?? member.role)
                )}
              </TableCell>
              {canManage ? (
                <TableCell className="text-right">
                  {editable ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm" disabled={busy !== null}>
                          {labels.remove}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{labels.removeTitle(member)}</AlertDialogTitle>
                          <AlertDialogDescription>{labels.removeText}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{labels.cancel}</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() => run(member.uid, () => onRemove(member.uid))}
                          >
                            {labels.remove}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export { MembersTable }
