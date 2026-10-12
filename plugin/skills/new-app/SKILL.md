---
name: new-app
description: Use when the user wants to start a new app, SaaS or product from an empty or nearly empty folder, with or without an idea described yet, in English or Portuguese ("set up a new app", "create my app", "start a new project", "quero criar um app", "monta a base", "começar um SaaS"). Builds a running Next.js and Firebase base with sign-up, sign-in, team members, billing, release notes, surveys, a tour and analytics from the @cordwood packages, verifies it in the browser, and only then turns to the user's business rules.
argument-hint: [optional: the app idea]
---

# New app on cordwood

The user has an empty folder and wants a product in it. They may have described the idea or not. Your job has two halves, in this order: a base app that runs, then their business rules on top of it. Do not write a business rule before the base passes the walk in step 6.

The base is the part every SaaS shares, built from the `@cordwood` packages and components. It runs on the Firebase emulators, so it needs no cloud account, no Stripe key and no SendGrid key to start.

Load the `cordwood` skill too. Its rules and its `references/wiring.md` apply to everything you write here.

## 1. Read the request, ask almost nothing

The base needs two things from the user, and both have a default. The app's name is the folder's name unless the message gives one. The language of the screens is the language the user writes to you in unless the message names another.

The message may carry no idea at all. That is fine: the base is the same for every product, so build it without asking what the product is.

Ask one question only when the folder is not empty and holds something that is not yours to overwrite. Everything else has a default below. The user said they want one command, so do not stop to confirm the stack, the folder layout or the page list.

If the message does describe an idea, keep it for step 8. Do not let it shape the base.

## 2. Check the machine

Run these and stop with a plain explanation if one fails, naming what to install.

| Needs | Check | Why |
|---|---|---|
| Node 22 or later | `node -v` | The packages require it |
| pnpm | `pnpm -v` | `corepack enable pnpm` adds it |
| Java 21 or later | `java -version` | The Firebase emulators run on it |

## 3. Scaffold

Run in the target folder. Use `.` as the name when the folder is the project.

```bash
pnpm create next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-pnpm --yes
npx shadcn@latest init -b radix -p nova -y
```

The cordwood components are written on the Radix primitives. `init -d` picks the Base UI preset, where `tour-card` and `members-table` do not compile, so name the base. `components.json` should say `"style": "radix-nova"`.

Add the cordwood registry to `components.json` (see the `cordwood` skill's `references/components.md`), then:

```bash
npx shadcn@latest add input label card @cordwood/tour-card @cordwood/survey-prompt @cordwood/changelog-dialog @cordwood/unsubscribe-card @cordwood/subscription-card @cordwood/members-table
pnpm add @cordwood/firebase @cordwood/auth @cordwood/email @cordwood/billing @cordwood/analytics @cordwood/surveys @cordwood/changelog @cordwood/experiments @cordwood/tour firebase firebase-admin stripe
pnpm add -D firebase-tools vitest
```

**Install the rule harness** before writing any code of your own. It is the `harness/` folder beside this file.

| From `harness/` | To the project |
|---|---|
| `hooks/` | `.claude/hooks/` |
| `rules.json` | `.claude/rules.json` |
| `settings.json` | `.claude/settings.json` (merge the `permissions` and `hooks` keys when the file exists) |
| `eslint.limits.mjs` | `eslint.limits.mjs`, at the root |
| `CLAUDE.section.md` | appended to `CLAUDE.md`, which you create with the app's name and its `pnpm` commands above it |

Then spread the limits into `eslint.config.mjs` (`import limits from "./eslint.limits.mjs"` and `...limits` last in the exported array), and add two scripts: `"test": "vitest run"` and `"rules": "node .claude/hooks/check-file.mjs --all"`.

Claude Code reads hooks when a session starts, so in this session they are not live. Follow the rules in `CLAUDE.section.md` by hand as you build, and let `pnpm rules` tell you what you missed.

Then read the README of every `@cordwood` package in `node_modules`. They are short, and every call you write in step 5 comes from them.

## 4. Local Firebase

Create the files in [references/base-app.md](references/base-app.md#local-firebase): `firebase.json`, `.firebaserc`, `firestore.rules`, the env files, and the `dev` script that starts the emulators with the app inside them.

Run `pnpm exec cordwood-firebase indexes` to write `firestore.indexes.json`.

Create no cloud project, deploy nothing, and put no real key in any file. Real Firebase, Stripe and SendGrid come later, when the user asks to go live: that is the `go-live` skill.

## 5. Build the base

Build what [references/base-app.md](references/base-app.md) lists, in its order: server modules, session routes, sign-up, sign-in, the app shell, then one feature at a time. Each feature is small because the package and the component do the work.

Write every user-facing sentence in the app's language. Run `pnpm exec tsc --noEmit` after each group of files and fix what it reports before moving on.

## 6. Run it and walk it

The base is done when a person can use it, not when it compiles.

1. `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm rules`, `pnpm test` and `pnpm build` pass.
2. Start `pnpm dev` in the background and wait for both the emulators and Next to be ready.
3. Walk the flow in a browser if you have a browser tool. Without one, walk it with `curl` and the emulators' REST endpoints, and say that no one has seen the screens.

| Step | Pass when |
|---|---|
| Sign up with an e-mail and a company name | The dev screen shows the confirmation link |
| Open the link, set a name and a password | The dashboard opens, signed in |
| Reload the dashboard | Still signed in |
| Open the dashboard for the first time | The tour opens, and does not open again after it ends |
| Invite a second address from the members page | The dev screen shows the invite link |
| Open the invite link in a private window, set a password | The second person lands on the same tenant's dashboard |
| Change the second person's role, then remove them | Their next request is refused |
| Open the release notes | The unread dot goes away and stays away after a reload |
| Sign out | The dashboard redirects to sign-in |
| Request the dashboard with no cookie | Redirect to sign-in. An API route answers 401 |

Fix every failure before going on. A step you could not check is reported as not checked, never as passing.

## 7. Hand over

Leave the dev server running. Make the first commit (`git init` when there is no repository), with `.env.development` in and `.env.local` out.

**Give the project a home on GitHub.** Run `git remote -v`. When a remote already points at GitHub, push to it and go on. When there is none, create the repository, private:

```bash
gh auth status
gh repo create <app> --private --source . --remote origin --push
```

- The repository is private by default. Make it public only when the user asked for that in their own words.
- It goes under the account `gh` is signed in to. Use an organisation only when the user named one.
- If the name is taken, try `<app>-app`, then ask.
- Before the push, check that no secret is staged: `git ls-files` shows `.env.development` and `.env.example` and no other `.env` file.
- After creating it, set the repository up: `gh repo edit --delete-branch-on-merge --enable-wiki=false --enable-issues --enable-projects`. A merged branch is deleted, the wiki is off, issues and projects are on. Leave a repository you did not create as it is.
- Do not add branch rules to it. GitHub offers rulesets and branch protection on a private repository only on a paid plan, and the call fails on a free one. Mention this once in the hand-over, as something to turn on if the plan allows.
- If `gh` is missing or not signed in, do not stop the hand-over. Say that the repository was not created and give the two commands to run after `gh auth login`.

Tell the user that the rule hooks start working in their next Claude Code session, and what they enforce in one line.

Tell the user, briefly: the address to open, the repository's address, how to sign up, what works, what waits for a key (billing needs Stripe, real e-mail needs SendGrid), which walk steps were not checked, and that putting it on the internet is a separate job you can do when asked. Write the same into the project's `README.md`, with the `pnpm dev` command first.

## 8. Now the business rules

This is the part the user came for.

If the user has not described the idea yet, ask for it now, in one message: what the product does, who uses it, and the first thing a person does in it. Then wait. With the base running they can open it while they answer.

Once you have the idea:

1. Say back, in three or four sentences, what you understood the product to do and for whom. Name the first thing a user would do in it.
2. Propose the data it needs as collections under `tenants/{tenantId}`, the permissions it adds to `defineRoles`, and the first screen. Keep it to what the first slice needs.
3. Ask the user to confirm or correct that, in one message. This is the one place to stop and listen: a wrong guess here costs more than a question.
4. Build the first slice end to end: a server module, guarded routes, a page in the shell. Then walk it in the browser as in step 6.

From here on the `cordwood` skill's rules hold for every feature. The tenant comes from the session, every route starts with `access.require`, and a feature a package already covers is wired, not rewritten. Add a product event to `defineEvents` for each act worth counting, and a tour step for each new screen worth explaining.

When the product does something a stranger could want, the `landing` skill builds its public page. Not before: a landing page needs real screens and real facts.

## When cordwood itself is the problem

A package bug, a missing capability any app would need, a README that sent you to a wrong call, or a step this skill got wrong: use the `improve` skill. It fixes the cause in the cordwood repository and opens a pull request with it. Do not leave a silent workaround in the app.

## Do not

- Do not start the business rules while a step of the walk fails.
- Do not replace a package with your own code because a call was hard to get right. Read its README again.
- Do not hard-code a tenant, a user or a secret to get past a step.
- Do not turn off the client rules that deny Firestore, even to debug.
- Do not ask the user for a Stripe or SendGrid key to finish the base. It runs without them.
- Do not create a public repository, or push to one the user did not point you at.
