# Publishing and measuring

When the page is shown, who is counted, and how a second version is tested. Read `node_modules/@cordwood/experiments/README.md` before writing a call. It is the reference for the installed version.

## The switches

`src/server/landing.ts` answers three questions and holds no other logic. It takes `env` as an argument with `process.env` as the default, so its test passes a plain object.

| Function | True when |
|---|---|
| `landingIsLive(env)` | `LANDING` is `on` and no fact in `facts.ts` is `null` |
| `maySeeLanding(cookies, env)` | The page is live, or the request carries the session cookie |
| `indexableOrigin(env)` | The page is live and `LANDING_INDEXABLE` is `on`. Answers the configured origin, or null |

- The switch that publishes reads the facts itself. Nobody has to remember which slots were open.
- `maySeeLanding` checks that the session cookie is present, without verifying it. All it guards is a page nobody should read yet, so the team reviews it while signed in.
- Indexing is a separate switch. A development deployment serves the page for checks and is not a place to index. Only production sets `LANDING_INDEXABLE`.
- Add both variables to `.env.example`, unset. Write the tests first: unset, on with a slot open, on with every fact filled, the cookie present.

## The root

In the base app the dashboard is at `/`. A visitor with no session gets the landing page there, once it is live.

`src/proxy.ts` (Next 16, `middleware.ts` before) matches `/` alone:

- Session cookie present: go on to the dashboard.
- No session and the page is live: rewrite to `/welcome`.
- No session and the page is not live: go on. The app's own guard sends the visitor to sign-in, as before.

`/welcome` itself answers 404 unless `maySeeLanding` is true.

The session cookie's name is the one the auth instance was built with (`cordwood.cookieName`). Keep the name in a small module that both `src/server/auth.ts` and the proxy import, so the proxy does not load firebase-admin to read a string.

## Counting visits

Count on the server, first-party, with the experiments package. One arm is enough to count a funnel.

```ts
"landing-1": { arms: { control: 1 }, goals: ["signup_requested", "signed_up"] }
```

| Moment | Where | Call |
|---|---|---|
| A visitor arrives with no visitor cookie | `proxy.ts` | `visitors.mint()`, set the cookie on the response |
| The page is rendered for a visitor | The page, on the server | `experiments.expose("landing-1", unit)` |
| The e-mail is accepted | `POST /api/sign-up` | `experiments.convert("landing-1", unit, "signup_requested")` |
| The account is created | The sign-up's finish route | `experiments.convert("landing-1", unit, "signed_up")` |

- The unit is the id inside the signed visitor cookie, read with `visitors.read`. A cookie the secret did not sign answers null and is not counted.
- A conversion is counted by the route that performs the act, never on the page's word.
- Neither call throws and no response waits on its answer.
- `experiments.results("landing-1")` gives visitors, sign-up requests and accounts. Show it on a page only a platform operator opens, or read it from a script. Run the indexes command so old events are deleted on schedule.

**Who is never counted.** Skip `expose` for a robot (`isRobot`), a prefetch (`isPrefetch`), a browser sending Global Privacy Control (`refusesTracking`), a request with the session cookie (the team reviewing the page), and a visitor who asked not to be measured.

**The way out.** The footer's "do not measure my visit" is a plain form posting to a public route. The route sets a cookie that lasts a year, deletes the visitor cookie and returns to the page. It is a form so that it works with scripts blocked, which is when someone is most likely to ask.

**Caching.** A page that reads the visitor cookie is rendered per request. Do not let a CDN store its HTML: one visitor's arm and count would be served to the next. Check on the deployed host that the visitor cookie reaches the server at all. Some hosts forward only a cookie named `__session`.

## Third-party tags

Add none by default: no analytics script, no advertising pixel, no client-side A/B tool, no chat widget. Each costs speed and puts a third party on the page.

When the user asks for one:

- An advertising tag waits for a yes. The page asks one question, in a card that covers nothing the visitor needs. Refusing is one click, drawn the same as accepting. The answer is kept on the server, and the footer has a link to change it.
- On a phone the card takes its own room at the top of the page. Pinned to the foot it sits over the form's button.
- A signed-in team member and a visitor who refused load no tag at all.
- Say in the hand-over that the legal basis for each tag is the user's to settle, and that the privacy policy must name what the page loads.

## A second version

A test needs traffic. Do the arithmetic before building an arm.

1. `sampleSize(baseline, detectable)` gives the visitors each arm needs. With a 4% sign-up rate, telling 4% from 6% takes about 1,900 visitors per arm.
2. Divide by the page's real visits per week. If the answer is longer than about eight weeks, do not run the test. Show the two versions to five people who match the reader and ask what each one says the product does. That finds a broken message faster than a test this size can.
3. With little traffic, test structure: a different hero, the price shown or hidden, a demo before the form. Never a button colour or one word.

Running it:

- A new experiment id for each round (`landing-2`), with `perArm` set from step 1 before the first visitor. Reusing an id carries the old split and the old counts into the new round.
- The proxy picks `experiments.arm("landing-2", unit)` and rewrites to `/welcome/<arm>`. The page renders that entry of `ARMS`. A robot gets the control and is not counted.
- Every built arm opens at its own address for a signed-in reviewer.
- Do not change an arm while its round runs. A fix that cannot wait ends the round.
- Read the result in the README's order: `split.mismatch` first, then `reached`, then `comparisons`. Do not read a rate before `reached` is true. A result looked at every morning finds a winner by chance.
- The winner becomes the control of the next round, and the losing arm's files are deleted.

Whatever differs between arms is the thing under test. The offer, the price, the product's name and the sign-up's e-mail are the same in every arm.

## Before the page goes live

The user turns the switch. Give them this list.

- Every slot is filled, each fact with its source.
- The offer under the button is what the code enforces: the trial's length, the limit, whether a card is asked.
- The footer links to a privacy policy and terms of use that exist, and the policy says what the page counts.
- The company's legal name and registration are in the footer, where the law of the reader's country asks for them.
- A comparison with another product or method carries its basis on the page.
- A customer's name, logo or words appear only with their written permission.
- The page was read on a real phone.
