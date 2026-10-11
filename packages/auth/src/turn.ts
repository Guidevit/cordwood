// How two managers acting on a tenant's members at the same moment are put in order, and how a
// member's claims are made to follow their roster row.
import type { Auth } from "firebase-admin/auth";
import type { DocumentReference } from "firebase-admin/firestore";
import { REMOVED_FROM_CLAIM, ROLE_CLAIM, TENANT_CLAIM } from "./claims.js";

export const MEMBERS = "members";

/** What a manager's act writes on the row of the member it is about: a new role, or that they are leaving. */
type Mark = { role: string } | { removing: true };

/** `actor`: who acts may not, or no longer. `absent`: the member has no row here, or is already leaving. */
export type Turn = "ok" | "actor" | "absent";

/**
 * Auth has no transaction, so the roster is where two managers meet. One transaction reads the row of
 * who acts and the row of who is acted on, and writes the second. Two managers demoting or removing each
 * other read each other's write: Firestore runs one of the two again, and that one finds its own row no
 * longer a manager's, or leaving, and is refused. So two managers removing each other leave one.
 */
export function takeTurn(
  tenant: DocumentReference,
  actorUid: string,
  uid: string,
  mark: Mark,
  mayManage: (role: unknown) => boolean,
): Promise<Turn> {
  const members = tenant.collection(MEMBERS);
  return tenant.firestore.runTransaction(async (tx) => {
    const [actor, target] = await tx.getAll(members.doc(actorUid), members.doc(uid));
    if (!actor?.exists || actor.get("removing") || !mayManage(actor.get("role")))
      return "actor";
    // A removal asked again finds its own mark and goes on. A role is not given to someone who is leaving.
    if (!target?.exists || ("role" in mark && target.get("removing")))
      return "absent";
    tx.update(target.ref, mark);
    return "ok";
  });
}

/** How many times the claims are written again to match the row before giving up: each one answers another manager's act. */
const ROUNDS = 4;

/**
 * Makes the member's claims say what their row says, after a role was written to both. A claims write
 * replaces the whole object, so one built from an account read a moment before can put back what another
 * manager's act has just taken. So the row is read after every write: a row gone or leaving means a
 * removal won, and the tenant's claims come off again with the removal's marker. Another role there
 * means a later change won, and the claims take it. Answers the role the claims ended with, or null when
 * the member left.
 */
export async function followRow(
  auth: Auth,
  tenant: DocumentReference,
  uid: string,
  written: string,
): Promise<string | null> {
  const row = tenant.collection(MEMBERS).doc(uid);
  let inClaims = written;
  for (let round = 0; round < ROUNDS; round++) {
    const read = await row.get();
    const inRow = read.get("role") as string | undefined;
    const left = !read.exists || read.get("removing") === true;
    if (!left && inRow === inClaims) return inClaims;
    const account = await auth.getUser(uid);
    if (left) {
      // Only when the write this follows put the tenant back: claims another tenant holds now are not ours.
      if (account.customClaims?.[TENANT_CLAIM] === tenant.id) {
        const { [TENANT_CLAIM]: _t, [ROLE_CLAIM]: _r, ...rest } = account.customClaims;
        await auth.setCustomUserClaims(uid, { ...rest, [REMOVED_FROM_CLAIM]: tenant.id });
        continue;
      }
      return null;
    }
    if (!inRow) return inClaims;
    await auth.setCustomUserClaims(uid, { ...account.customClaims, [ROLE_CLAIM]: inRow });
    inClaims = inRow;
  }
  throw new Error("the member's claims did not settle on their roster row");
}
