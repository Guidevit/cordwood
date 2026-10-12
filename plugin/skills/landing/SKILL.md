---
name: landing
description: Use when the user wants a landing page, a public home page, a marketing page or a pricing section for an app built on @cordwood, or wants an existing one rewritten, measured or A/B tested, in English or Portuguese ("create the landing page", "página de vendas", "landing do app", "página inicial pública", "testar duas versões da landing"). Builds one public page with a single action, the sign-up the app already has, on facts that each carry a source, with the app's own shadcn components, a publication switch, and visits counted on the server with @cordwood/experiments.
argument-hint: [optional: who the page is for and what it offers]
---

# A landing page for the app

The app runs and a stranger cannot tell what it does. Your job is one public page that says it, to one kind of reader, and takes their e-mail into the sign-up the app already has.

The page is built from what is true about the product today. A number with no source, a customer logo that does not exist and a promise the product does not keep are all the same defect. This skill treats each as a missing fact and shows it as a visible slot until a person fills it.

Load the `cordwood` skill too. Its rules hold here. If the app is not built yet, run the `new-app` skill first: a landing page for a product with no sign-up has nowhere to send anyone.

## 1. Read the app before asking anything

Find these in the code. Do not ask for what the repository already says.

| Look for | Where | Used for |
|---|---|---|
| The sign-up's first step | `src/app/(public)/sign-up`, `POST /api/sign-up` | The page's one action |
| What a new account can do without paying | `src/server/billing.ts`, the plan or trial rules | The offer beside every button |
| The product's real screens | `src/app/(app)/` | What the page shows |
| The language of the screens | Any page | The page's language |
| The name, the logo, the tokens | `src/server/env.ts`, `public/`, `globals.css` | The header, the footer, the theme |
| Prices | Stripe lookup keys in the billing code | The price section |

## 2. The brief: five answers

Write these down before a line of the page. Take each from the user's message or from step 1 when it is there.

1. **Reader.** One role in one situation. "Owner of a small clinic who books by phone today" is a reader. "Businesses" is not.
2. **What they use today.** The alternative the page is compared with in the reader's head: a spreadsheet, a competitor, doing it by hand. The message starts from it.
3. **The action.** One, and it is the sign-up's first step. If the user wants "talk to sales" as well, say that a second action in the hero divides the first, and put it in the footer.
4. **The offer.** What the reader gets for the action and what it costs them: the trial's length, whether a card is asked for, the limit. It must be what the code enforces.
5. **Facts.** Every number, date, name and claim the page may state, each with where it comes from.

Ask the user for what is still missing, in one message, as a short list. Facts are the part they most often cannot give on the spot. Do not wait for those: build the page with slots and list them in the hand-over.

## 3. Facts first

Create `src/content/landing/facts.ts` before any section. Every number the page states lives there, beside its source, and nowhere else.

```ts
export const FACTS = {
  // Counted from the orders table on 2026-03-02, query in docs/facts.md.
  ordersPerWeek: { value: "1,240", source: "Our measurement, 2 March 2026" },
  // Not known yet. The page shows a slot and stays unpublished.
  company: null,
} satisfies Record<string, Fact | null>;
```

- A fact is the product's own measurement with its date, a public source named on the page, or a legal text. A number from memory, from a blog about conversion or from "everyone knows" is not a fact.
- A fact still `null` renders as a marked slot (`[fact: company name and registration]`), dashed, never as a guess. See the `Fact` component in [references/page.md](references/page.md).
- The page cannot go live while a slot is on screen. Step 6 wires that.
- A precise number beats a round one. "1,240 a week" reads as counted. "Over 1,000" reads as written.

## 4. Build the page

Follow [references/page.md](references/page.md): where each file goes, the sections in order, the form, the phone's bar and the rules each one keeps. In short:

| # | Section | Its one job |
|---|---|---|
| 1 | Hero | Who it is for, what the product does with one number, the e-mail field, the offer under the button, and what happens after the click |
| 2 | The product, shown | A real screen with real-looking data, never an invented mockup |
| 3 | Where the numbers come from | Two to four facts, each with its source on the card |
| 4 | How it works | The steps a new account really takes, in order |
| 5 | Price | The plans the code sells, on the page, with the action again |
| 6 | Questions | What this reader asks before trying, each answer closed until asked for |
| 7 | Closing | The same form and the same offer |
| 8 | Footer | The company's legal identity, the legal pages, a contact, and the way out of being measured |

Use the project's shadcn components and tokens. Add no second styling system, no animation library and no font the app does not already load. Write every sentence in the app's language.

## 5. Write it like one person talking to one reader

- The headline says what the product does, to whom, with a number when a fact gives one. A slogan that would fit any product is cut.
- The button says what the reader gets ("Try free for 14 days"), the same words everywhere it appears. The offer sits directly under it, every time.
- Use the reader's words for their work, not the team's words for the product. No name of an internal technology.
- Each claim can be pictured, could be false, and is one only this product can make. "Fast" fails all three.
- One idea per sentence. Short sentences beside longer ones. No sentence that could close any page.
- Say what the product does not do. A stated limit is believed, and so is the sentence after it.
- With no customers yet, the proof is the measurement, the real screen, the honest limit and the free trial. Do not fill the gap with a wall of grey logos.

## 6. Publish with a switch, and measure on the server

Follow [references/measure.md](references/measure.md).

- The page is built unpublished. Until `LANDING=on` and every fact is filled, a visitor with no session keeps getting sign-in at `/`, and only a signed-in person opens the page to review it.
- Search engines are told of the page by a second switch, set in production only.
- Visits and sign-ups are counted on the server, first-party, with `@cordwood/experiments`. One arm is enough to count the funnel. A second arm comes later, when the traffic can carry a test.
- No third-party tag, pixel or A/B tool is added by default. When the user asks for one, the consent question in the reference comes with it.

## 7. Walk it

The page is done when a stranger on a phone can read it and sign up.

1. `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test` and `pnpm build` pass, and `pnpm rules` when the project has the harness.
2. Open the page in a browser at 390 px and at 1280 px. Without a browser tool, fetch the HTML with `curl` and say that no one has seen the page.

| Check | Pass when |
|---|---|
| First screen at 390 px | Who it is for, the headline, the e-mail field, the button and the offer are visible without scrolling |
| Submit the hero form | The sign-up's own next step happens, and the page says where the link went |
| Submit the form with a bad address | The sentence beside the field says what is wrong |
| Scroll on the phone | The bar appears when no form is on screen, hides when one is, and its button puts the cursor in the e-mail field |
| Tab through the page | Every control is reached, focus is visible, the skip link comes first |
| JavaScript off | Every section and every answer is in the HTML, and the form still posts |
| Reduced motion on | Nothing moves |
| No horizontal scroll | At 390 px, on every section |
| `LANDING` unset, no session | `/` leads to sign-in |
| `LANDING=on` with a `null` fact | Still unpublished |
| Visit, then sign up | One exposure and one conversion in `experiments.results` |

A check you could not run is reported as not checked.

## 8. Hand over

Tell the user, briefly:

- The address to review the page, and that it is not public yet.
- The slots still open, each with what fact fills it.
- What must be true before `LANDING=on`: every slot filled, a privacy policy and terms of use the footer can link to, and the offer enforced by the code.
- What the page counts, and where to read it.

Do not write a privacy policy or terms of use from imagination. If the app has none, say so. When the user asks for a draft, write one that describes what the code really collects, and mark it as a draft for a lawyer.

## When cordwood itself is the problem

A package bug, a missing capability any app would need, or a step this skill got wrong: use the `improve` skill. Do not leave a silent workaround in the app.

## Do not

- Do not invent a number, a customer, a testimonial, a logo, a rating or a seal.
- Do not add a countdown, "limited spots", an exit pop-up or any urgency the product does not have.
- Do not write "the only", "the first" or "faster than" without a fact that carries its source.
- Do not put a second action in the hero.
- Do not ask for more than the e-mail in the page's form.
- Do not animate the headline or the form. The first read and the first action stay still.
- Do not autoplay a video in the hero.
- Do not let the page's theme reach the signed-in app.
- Do not publish the page, turn on indexing or deploy. Those switches are the user's.
- Do not test button colours on a page with a few hundred visits a month. See the reference for what a small audience can test.
