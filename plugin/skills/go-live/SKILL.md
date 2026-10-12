---
name: go-live
description: Use when an app built on @cordwood runs on the Firebase emulators and the user wants it on the internet, or asks what is still missing for that ("go live", "deploy", "put it in production", "set up the real Firebase project", "finish Stripe", "configure the e-mail domain", "what else do I need to launch"), in English or Portuguese ("colocar no ar", "publicar", "subir para produção", "criar e configurar o Firebase", "terminar de configurar o Stripe", "o que falta para lançar"). Takes the app from the emulators to a real Firebase project, a host, its secrets, Stripe, the e-mail domain and the scheduled job, in an order that works, says which steps are the user's own clicks, and ends with a walk on the live address.
---

# Go live

The app runs on the emulators with no account and no key. This skill takes it to a real address. Most of the work is not code: it is accounts, keys and DNS that belong to the user. Your job is to do every part a command can do, to open the right page for every part that is a click, and to say plainly what is left.

Load the `cordwood` skill too. Read the app's `README.md` and `.env.example` first: they say which features wait for which key.

## Rules for this skill

- **Ask before each command that creates or changes something in a cloud account.** A project id, a database location and a Stripe account's country cannot be changed later. Say what the command will create, then run it on a yes.
- **Never handle a secret's value.** Do not type a key into a page, read one back in the chat, or write one to a file that git tracks. The user pastes it into the host's secret store, or into `.env.local` for a local try. Give the command and let them run it.
- **A click that belongs to the user stays theirs.** Accepting terms, turning on billing, verifying a business, buying a domain. With a browser tool, open the page and say which button. Without one, give the address and the path.
- **Deploy nothing the checks refuse.** `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test` when it exists, and `pnpm build` pass before every deploy.
- **Report a step you could not check as not checked.**

## 1. Say what going live needs, and get the decisions

Tell the user the whole list once, before doing anything, so nothing arrives as a surprise.

| Needs | Who | Costs |
|---|---|---|
| A private GitHub repository with the code pushed | You (`new-app` step 7) | Free |
| A real Firebase project on the Blaze plan | You create it, the user links billing | Pay as you go. Blaze is required by App Hosting and by Cloud Storage |
| Firebase App Hosting for the Next.js server | You | Inside Blaze |
| A domain, and access to its DNS | The user | Yearly |
| A Stripe account, verified | The user | A fee per payment |
| A SendGrid account with the domain authenticated | The user | No free plan: a 60-day trial, then paid |
| Terms of use and a privacy notice | The user, with a lawyer | |

Then ask, in one message, only for what has no safe default:

1. **The domain**, or whether to start on the host's own address.
2. **The project id**, with a proposal (`<app>-prod`). It is public and permanent.
3. **Where the data lives.** Propose the Firestore location nearest the users. It is permanent.
4. **Stripe in test mode or live.** Going live with test keys first is a sound way to walk the whole flow.

Everything else below has a default.

## 2. The repository

Run `git remote -v` and `git status`. The code must be committed and pushed to a private repository before anything is deployed from it. If there is none, do what `new-app` step 7 says.

`git ls-files` shows `.env.development` and `.env.example` and no other `.env` file.

## 3. The Firebase project

Run `firebase login:list` and `firebase projects:list` first. Then, each on a yes:

```bash
firebase projects:create <project-id> --display-name "<App>"
firebase use --add <project-id>            # alias it "prod". Keep "default" on demo-<app>
firebase apps:create WEB "<App>" --project <project-id>
firebase apps:sdkconfig WEB --project <project-id>
```

Check each command's `--help` before running it: the CLI changes.

- **`.firebaserc` keeps `demo-<app>` as `default`.** `pnpm dev` must go on reaching the emulators. Every command against the real project names it with `--project <project-id>`.
- **Blaze comes right after the project exists.** The user links a billing account in the console (the project's "Upgrade" control). Say so, open the page, and ask them to set a budget alert while they are there. Deploying the indexes fails without it, since the packages' indexes carry a TTL policy, and so do Storage and App Hosting.
- **The web config.** `apiKey`, `authDomain` and `projectId` from `apps:sdkconfig` are the three `NEXT_PUBLIC_FIREBASE_*` values. They are safe to publish. `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR` stays empty in production.
- **Sign-in by e-mail and password** is off in a new project. The user turns it on in the console: Authentication, then Sign-in method, then Email/Password. There is no Firebase CLI command for it.
- **Firestore.** Create the database with its location, which cannot be changed after. A new project has the API off, and the create command answers 403 until it is on:

  ```bash
  gcloud services enable firestore.googleapis.com --project <project-id>
  firebase firestore:databases:create "(default)" --location=<location> --project <project-id>
  pnpm exec cordwood-firebase indexes
  firebase deploy --only firestore:rules,firestore:indexes --project <project-id>
  ```

- **Cloud Storage**, when the app uses `bucket`. The user creates the default bucket in the console (Storage, then Get started), since it asks for a location and for Blaze. A new one is named `<project-id>.firebasestorage.app`: that is `FIREBASE_STORAGE_BUCKET`, or whichever variable the app names its bucket with. Then `firebase deploy --only storage --project <project-id>` for the rules that deny everything.
- **Authorised domains.** Once the app has its address (step 6), the user adds it in Authentication, then Settings, then Authorised domains.

## 4. The host

The host is **Firebase App Hosting**. Cordwood is Firebase end to end: the server sits in the same project as its data, so firebase-admin starts with no key file, and its secrets live in Cloud Secret Manager. Do not propose another host.

Work within what it offers, and check its pages for today's answer:

- Its regions are in the United States, Europe and Asia. Pick the one nearest the users, and say which.
- It lists the Next.js versions it supports, and a newer major runs as a preview. When the app's `next` is newer than the list, deploy and walk it: step 10 is what proves it.
- It needs the Blaze plan.

```bash
firebase apphosting:backends:create --project <project-id> --non-interactive \
  --backend <app> --primary-region <region> --app <web app id> --root-dir .
```

Then write `apphosting.yaml` (step 5) and an `apphosting` entry in `firebase.json` with `backendId`, `rootDir` and an `ignore` list (`node_modules`, `.git`, `.next`, `.emulator-data`). Commit both. `firebase init apphosting` does the same by asking questions. Add `"engines": { "node": ">=22" }` to `package.json`.

The build runs away from this machine, from the committed `package.json`. A dependency installed from a local path (`file:`, `link:`) does not exist there: every `@cordwood` package must come from npm before the first deploy.

The address it gives, `https://<backend>--<project-id>.<region>.hosted.app`, is a real one. An app can launch on it with no domain of its own, and then step 6 is skipped.

**The server's identity** is `firebase-app-hosting-compute@<project-id>.iam.gserviceaccount.com`. After the first deploy, read its roles in IAM. If a request fails with a permission error from Auth, Firestore or Storage, the role it lacks is named in the error: tell the user which one, and let them grant it.

## 5. Configuration and secrets

Every variable in `.env.example` gets a production value. Plain values go in `apphosting.yaml`. Secrets go in the secret store and are only named there.

```yaml
env:
  - variable: APP_ORIGIN
    value: https://<the app's address>
  - variable: NEXT_PUBLIC_FIREBASE_API_KEY
    value: <from apps:sdkconfig>
  - variable: APP_SECRET
    secret: app-secret
  - variable: STRIPE_SECRET_KEY
    secret: stripe-secret-key
```

For each secret, give the user the command and let them run it and paste the value:

```bash
firebase apphosting:secrets:set app-secret --project <project-id>
```

| Variable | Kind | Its value |
|---|---|---|
| `APP_ORIGIN` | value | The live address, `https`, no trailing slash. Never the dev one |
| `NEXT_PUBLIC_FIREBASE_*` | value | From `apps:sdkconfig` |
| `APP_SECRET`, `VISITOR_SECRET`, `CRON_SECRET` | secret | New random ones, never the ones in `.env.development`. These are nobody's key, so store them yourself, unseen: `openssl rand -hex 32 \| firebase apphosting:secrets:set app-secret --project <project-id> --data-file - --force --non-interactive`, then `firebase apphosting:secrets:grantaccess app-secret --backend <app> --project <project-id>` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | secret | Step 7 |
| `SENDGRID_API_KEY`, `SENDGRID_WEBHOOK_PUBLIC_KEY` | secret | Step 8 |
| `EMAIL_FROM`, `EMAIL_NEWS_FROM`, `STRIPE_PRICE` | value | Steps 7 and 8 |

A `NEXT_PUBLIC_` value is read when the app is built, so it must be available to the build. Search the code for anything that only works in development (a link shown on the page while there is no e-mail key, a button that skips payment) and confirm each one is switched off by `NODE_ENV === "production"`, not by a missing key alone.

Then deploy:

```bash
firebase deploy --only apphosting:<app> --project <project-id>
```

Then ask the address for `/` and for an API route with no cookie. The page sends the visitor to sign-in and the route answers 401. The page's status can be 200 with the redirect inside the stream, so read the body, not only the code.

## 6. The domain

The user adds it in the console: the backend's Settings, then Add custom domain. The wizard shows the DNS records to create at the registrar. DNS and the certificate can each take up to a day.

When the address is final: set `APP_ORIGIN` to it and deploy again, add it to Firebase Auth's authorised domains, and use it in every webhook below. A camera or a microphone works in the browser on `https` only, which a real address gives.

## 7. Stripe

All in the user's dashboard. Open each page and say what to do.

1. **Activate the account** (business details, tax id, bank account). The country cannot be changed afterwards. Not needed for test mode.
2. **Payment methods.** For Pix: Settings, then Payment methods. In Brazil, Stripe offers Pix by invitation. If it is not listed, the user asks Stripe, and nothing built on `billing.charge` works until then. Pix takes one-off payments only.
3. **Subscriptions**, when the app sells a plan: a product with a price whose lookup key is the value of `STRIPE_PRICE`, and the customer portal turned on.
4. **The webhook.** In Workbench, Webhooks, create an event destination of the type "Webhook endpoint" at `<APP_ORIGIN>/api/billing/webhook`. Events: `checkout.session.completed`, `customer.subscription.*`, `invoice.*`, and `payment_intent.*` when the app charges once. Its signing secret is `STRIPE_WEBHOOK_SECRET`.
5. **The key.** A restricted key is better than the full secret key: write access to what the app creates (customers, checkout sessions, portal sessions, payment intents), read to the rest. A missing permission comes back as an error that names it.

Test mode and live mode each have their own key, webhook and secret.

## 8. E-mail

With no domain of the app's own, there is nothing to authenticate. SendGrid then sends from one address the user verifies (Settings, then Sender Authentication, then Single Sender Verification), and more of it lands in spam. Say so, and use that address as `EMAIL_FROM`.

1. The user creates the SendGrid account and authenticates the domain: Settings, then Sender Authentication, then Domain Authentication. It asks for three CNAME records and a `_dmarc` TXT at the registrar, and can take up to two days to verify.
2. An API key with Custom Access and only Mail Send. It is shown once: `SENDGRID_API_KEY`.
3. `EMAIL_FROM` and `EMAIL_NEWS_FROM` are addresses at the authenticated domain.
4. When the app reads bounces and complaints: Settings, then Mail Settings, then Event Webhooks, pointed at the app's route, with Signed Event Webhook on. Its public key is `SENDGRID_WEBHOOK_PUBLIC_KEY`.

Until the key is set in production, sign-up and invites fail there: the link shown on the page is a development convenience. So e-mail comes before the first real user, not after.

## 9. The scheduled job

When the app sends release notes by e-mail, something must call `POST /api/cron/changelog` once a day with the secret. With Cloud Scheduler, the user runs it, since the secret is in the command:

```bash
gcloud scheduler jobs create http changelog --project <project-id> --location=<region> \
  --schedule="0 9 * * *" --time-zone="<the users' time zone>" \
  --uri="<APP_ORIGIN>/api/cron/changelog" --http-method=post \
  --headers="Authorization=Bearer <CRON_SECRET>"
```

## 10. Walk the live address

The deploy is done when a person has used it there.

| Step | Pass when |
|---|---|
| Open the address with no cookie | Sign-in, on `https`, with no development box on the page |
| Sign up with a real address | The e-mail arrives, from the authenticated domain |
| Open its link, set a password | The dashboard opens, and a reload keeps the session |
| Invite a second real address | That e-mail arrives too |
| Pay once with the cheapest thing on sale | Stripe shows the payment, the webhook's delivery says 200, and the app opens what was bought |
| The app's own first act (create the thing it is for) | It works end to end, uploads included |
| Ask an API route with no cookie | 401 |
| Read Firestore from the browser's console with the web SDK | Refused by the rules |

In test mode, pay with Stripe's test values. In live mode it is real money: ask first, then refund it from the dashboard.

## 11. What the packages leave to the user

Say these at the end. None of them is a setting you missed.

- **Terms of use and a privacy notice.** The app holds names and e-mail addresses, and maybe photos or payments. In Brazil that is the LGPD, and the notice names who holds the data and how to have it deleted. Write the pages when asked, and say they need a lawyer's reading.
- **Backups.** Firestore has scheduled backups and point-in-time recovery, both off in a new database.
- **Watching it.** The host's logs, and an alert on the billing budget.
- **Abuse on public routes.** A route with no session, such as a sign-up or a guest upload, needs a limit before the address is shared widely.
- **Deleting an account's data** on request.

Then update the app's `README.md`: the live address, the project id, which host, where each secret lives, and how to deploy.

## When cordwood itself is the problem

A step here that was wrong, missing or out of date, or a package that cannot run in production as its README says: use the `improve` skill. It fixes the cause in the cordwood repository and opens a pull request with it.

## Do not

- Do not point `default` in `.firebaserc` at the real project.
- Do not reuse a development secret in production.
- Do not turn the client rules of Firestore or Storage on to make something work.
- Do not go live with a development shortcut reachable: a link shown on the page, a button that skips payment.
- Do not merge, deploy or pay on the user's behalf without a yes for that one act.
