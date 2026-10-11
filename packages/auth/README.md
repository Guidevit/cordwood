# @cordwood/auth

Sessions, roles and tenant members on Firebase Auth. The browser signs in with Firebase and sends its ID token once. From then on every request carries an HttpOnly cookie, and each route asks one question: may this request do this?

```bash
pnpm add @cordwood/auth @cordwood/firebase firebase-admin
```

Node 22 or later. Server only.

## Set up

Name your roles and what each may do. The package knows neither.

```ts
import { createAuth, defineRoles } from "@cordwood/auth";
import { auth, firestore } from "@cordwood/firebase";

export const roles = defineRoles({
  admin: ["read", "write", "members.manage"],
  editor: ["read", "write"],
  viewer: ["read"],
});

export const cordwood = createAuth({
  auth: auth(),
  firestore: firestore(),
  roles,
  managePermission: "members.manage",
});
```

A tenant and a role are custom claims on the Firebase account (`tenant`, `role`). Only the server writes them.

## Sign in

The browser signs in with the Firebase client SDK and posts its ID token. The route exchanges it for the cookie.

```ts
export async function POST(request: Request) {
  const { idToken } = await request.json();
  const exchanged = await cordwood.sessions.exchange(idToken);
  if (!exchanged.ok) {
    return Response.json({ error: exchanged.reason }, { status: 401 });
  }
  const response = Response.json({ session: exchanged.session });
  const { maxAge } = cordwood.cookieOptions;
  response.headers.append(
    "set-cookie",
    `${cordwood.cookieName}=${exchanged.cookie}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  return response;
}
```

`exchange` refuses with one of these reasons.

| Reason | Meaning |
|---|---|
| `token` | The ID token is expired, revoked or forged, or is no token at all. |
| `email_unverified` | Nobody proved the address. |
| `stale_sign_in` | The sign-in is older than 5 minutes, so the token may have been lifted from elsewhere. |

A session lasts 5 days by default. Signing out calls `cordwood.sessions.end(cookie)`, which revokes the user's refresh tokens and ends their sessions on every device. Clearing the cookie alone would leave a copy of it working.

## Guard a route

```ts
export async function POST(request: Request) {
  const access = await cordwood.access.require(request, "write");
  if (!access.ok) {
    return Response.json({ error: access.reason }, { status: access.status });
  }
  const tenant = tenantRef(firestore(), access.tenantId);
  // access.uid, access.email and access.role say who is acting
}
```

| Status | Reason | Meaning |
|---|---|---|
| 401 | `no_session` | No cookie, or one that no longer verifies. |
| 403 | `no_tenant` | A signed-in user no tenant has admitted. |
| 403 | `forbidden` | The role does not hold the permission. |
| 403 | `cross_site` | A write that another site's page sent with the user's cookie. |

The tenant comes from the verified cookie and from nowhere else.

A cookie is checked against the account on every request. Change a member's role or remove them, and their open sessions stop at the next request, not 5 days later.

## Members

A tenant's members are kept at `tenants/{tenantId}/members/{uid}`.

### Admit

```ts
const admitted = await cordwood.members.admit(
  access.tenantId,
  { email: "ana@example.org", role: "editor", name: "Ana Lima" },
  {
    continueUrl: "https://app.example.com/welcome",
    deliver: (invite) =>
      email.send({
        to: invite.email,
        subject: "You were invited",
        text: `Set your password: ${invite.link}`,
      }),
  },
  access.uid,
);
```

The person gets a one-time link where they set a password. Opening it also proves the address. When `deliver` throws, the account, the claims and the roster row are undone and the error is rethrown.

For a sign-up whose own link already proved the address, pass `{ password }` in place of `continueUrl` and `deliver`. That is also how a tenant gets its first member.

`admit` answers `{ ok: false, reason }` for an address it will not take.

| Reason | Meaning |
|---|---|
| `member` | The address already belongs to this tenant. |
| `other_tenant` | Another tenant holds it. Moving someone between tenants is a person's decision. |
| `disabled` | The account was shut by someone other than this tenant. An invite does not reopen it. |

An existing account that had a password loses it on admission. Anyone can register an address before its owner arrives, so only the link proves who holds the mailbox.

### List, change a role, remove

```ts
const people = await cordwood.members.list(tenantId);
await cordwood.members.changeRole(tenantId, uid, "viewer", access.uid);
await cordwood.members.remove(tenantId, uid, access.uid);
```

The last argument is who acts. They must hold `managePermission`, and nobody acts on their own membership, which keeps a tenant from losing its last manager. Two managers who demote or remove each other in the same instant leave one: the second is answered `forbidden`.

Removing disables the account, ends its sessions and deletes the roster row with everything stored under it. The same tenant can admit the person again later.

## Not in this version

The browser side (the sign-in form, the Firebase client setup) and ready-made Next.js route handlers. Write the two routes above in your app for now.
