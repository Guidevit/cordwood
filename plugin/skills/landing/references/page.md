# Building the page

Where the files go, what each section holds, and the rules each keeps. Paths follow the base app from the `new-app` skill. Follow the project's own layout where it differs.

## Files

```text
src/
├── content/landing/
│   ├── facts.ts          # every number the page states, with its source
│   └── copy.ts           # the strings repeated word for word: action, offer, steps
├── components/landing/
│   ├── landing-page.tsx  # header, the arm's sections in order, footer, phone bar
│   ├── section.tsx       # the column, the vertical rhythm, the heading size
│   ├── fact.tsx          # a fact, or its slot
│   ├── signup-form.tsx   # the one action (client)
│   ├── scroll-action.tsx # a button that leads to the form (client)
│   ├── sticky-bar.tsx    # the phone's bar (client)
│   ├── questions.tsx     # answers open on demand (client)
│   └── sections/         # one file per section
├── server/landing.ts     # is the page live, may this request see it, is it indexable
├── app/(public)/welcome/page.tsx
├── app/robots.ts
├── app/sitemap.ts
└── proxy.ts              # the root, for a visitor with no session
```

Each section is one file with one reason to change, written in its first line. `landing-page.tsx` lists the sections in order and holds no sentence of its own.

**One arm, shaped for more.** Build the page as one arm in a record of arms:

```tsx
export type Arm = {
  Content: ComponentType;
  header?: { sections: readonly HeaderLink[]; sticky?: boolean; action?: boolean };
  className?: string;
};

const ARMS = { control: CONTROL } satisfies Record<string, Arm>;
```

A second version of the page later is a second entry, sharing every section it does not change. `className` goes on the element that wraps the whole page, so an arm's theme (`dark`, a different accent) stays inside it and never reaches the signed-in app.

## Shared measures

Put the column and the heading size in `section.tsx` and use them in every section, so two sections never disagree by a few pixels.

- The column: about 72 rem wide, a 16 px gutter on a phone and 32 px from 768 px.
- A section: generous vertical padding (`py-16`, `lg:py-24`). A section may sit on the card colour between two rules to separate it from its neighbours. Two plain sections in a row share one gap.
- Each `<section>` has an `id` and `aria-labelledby` its heading. With a sticky header, give sections a `scroll-margin-top` taller than the header.
- `tabular-nums` on the page's wrapper. `text-balance` on headings and `text-pretty` on paragraphs.

## The form

A client component. It asks for the e-mail and nothing else.

- It posts to the sign-up route the app already has. Do not write a second sign-up. If that route asks for more at this step (the base asks for a company name), move the extra field to the step that follows the link, where the address is already proved.
- `type="email"`, `autocomplete="email"`, full width, a 44 px tall field and button.
- The button's label is the action from `copy.ts`. The offer sits directly under it, in one line.
- Under the field, one line on what happens next ("You get a link by e-mail to create the account").
- While the request is out, the button is disabled and says so. A refusal shows the route's reason as a sentence beside the field, linked with `aria-describedby`.
- On success the form is replaced by the confirmation, which takes the focus so a screen reader hears it.
- The form appears twice, in the hero and in the closing. Give each wrapper an id (`signup-hero`, `signup-closing`) for the other actions to lead to.

**Every other action leads to the form.** A button in the header, the price section or the phone's bar is a link to the form's anchor. With a script it scrolls the form to the centre of the screen and puts the cursor in the e-mail field. Without one it is still a working link. One action stays one form.

## The sections

### Header

The product's mark (a link to the top), three or four links to sections, a "Sign in" link, and from 768 px the action. On a phone keep the mark, sign-in and at most one section link, usually the price. A skip link to the content comes before all of it. The header may stick to the top with a translucent background.

### 1. Hero

In the order a phone reads it:

1. A small line saying who the page is for.
2. The `h1`: what the product does, with a number from `facts.ts` when one exists.
3. One paragraph of two or three sentences on how.
4. The form.
5. What happens after the click, as three short numbered steps. They answer "what am I getting into" before it is asked.

On a wide screen a scene of the product may sit beside the text. On a phone the form comes before the paragraph, so the field is on the first screen.

Size the `h1` with `clamp()`. On a wide screen that is not tall (a laptop at 768 px of height), tighten the spacing so the button still fits in the first screen. Check it.

### 2. The product, shown

One real screen of the app: the one the reader would live in. Two ways to do it honestly.

- Compose the app's own components with sample data, inside a frame. It stays sharp at every width, follows the theme and costs no image weight.
- A screenshot, with `next/image`, real dimensions, and an `alt` that says what the screen shows.

The data on it is invented but plausible, and names no real person or customer. Under it, two or three cards say what to read on the screen. A card about a keyboard shortcut is hidden on a phone.

### 3. Where the numbers come from

Two to four cards. Each has the number large, a line saying what it counts, and a smaller line with the source: "Our measurement, 2 March 2026" or the law or the public report by name. A number the product measured is labelled as the product's own measurement.

Every value goes through `Fact`:

```tsx
export function Fact({ value, slot }: { value: string | null; slot: string }) {
  if (value !== null) return <>{value}</>;
  return (
    <span data-pending="" title="Pending" className="whitespace-nowrap text-muted-foreground underline decoration-dashed underline-offset-4">
      {slot}
    </span>
  );
}
```

A comparison with what the reader uses today belongs here only with its basis on the page: the same data, the same day, the method in a sentence. A comparison with no basis beside it is a claim someone can take down.

### 4. How it works

The steps a new account really takes, numbered, each a title and one or two sentences. Read the app to write them. If a step is not built, it is not a step. On a wide screen the heading may stay in place while the steps scroll past it.

### 5. Price

When the product is self-serve, the price is on the page. Show the plans the billing code sells, with the same names and amounts, the action again, and the offer under it. A plan that needs a conversation says so plainly and gives the contact. Do not hide the price behind "contact us" when a card can buy it.

Read the amounts from one module the billing code also reads, so the page and the checkout cannot disagree.

### 6. Questions

Six to eight questions this reader asks before trying, in their words: what happens when the trial ends, who can see my data, what the product does not do, how to cancel, how to get the data out. Answer in two or three sentences each.

Use the project's accordion, every item closed at first, several open at once. Keep each answer in the server's HTML while it is closed (`forceMount` with the closed state hiding it), so a search engine reads it and the page works with scripts off.

### 7. Closing

A card with one sentence that restates the offer in the reader's terms, the form again, and a quiet link back to how it works.

### 8. Footer

- The mark and one sentence on what the product does.
- Columns of plain links: the page's sections and sign-in, the legal pages, a contact address.
- A bottom line with the year, the company's legal name and registration (a fact, so a slot until known), the source of any public data the page uses, and the link that turns measurement off for this visitor.

Footer links are 44 px tall on a phone.

## The phone

- A bar fixed to the foot of the screen below 768 px, holding the action. It shows only while no form is on screen (an `IntersectionObserver` on both forms), so it never covers the form it leads to. Hidden, it is `inert` and `aria-hidden`.
- The page keeps room at its foot for the bar, plus `env(safe-area-inset-bottom)`, so the bar never covers the footer's last line.
- Every target a thumb reaches is 44 px tall. A shadcn `lg` button is shorter: add `min-h-11`.
- Tables become stacked cards. Nothing scrolls sideways. The gutter is 16 px.
- Anything pinned to the foot (a consent card, a chat bubble) sits above the bar, or takes its own room at the top.

## Motion

Build the page still first. Then add at most these, each off under `prefers-reduced-motion`.

- Sections may fade up a few pixels once as they enter the screen. The headline and the form never animate in.
- A number may count up once when its card is seen, ending on the exact value in the HTML.
- A scene of the product may play a short script (rows arriving, a decision made). The server sends the scene's last frame, whole with scripts off. The script starts when about half the scene is on screen, runs once, and has a pause and replay control a keyboard reaches. Load the script only when the scene is seen.

Transitions name their properties, last under 300 ms for anything the visitor triggers, and ease out. No autoplaying video.

## Speed

The page is the first thing a stranger loads, on a phone, often from an ad.

- Server components by default. Only the form, the scroll action, the bar, the accordion and a scene are client components.
- No font, script or image the first screen does not need is loaded before it. The mark and the first image take `priority`.
- Aim for a Largest Contentful Paint under 2.5 s on a phone. Measure it with the browser's own tools after `pnpm build && pnpm start`, not in `next dev`, and report the number or say it was not measured.

## What a search engine reads

- `metadata` on the page: a title with the product's name and what it does, a description of one or two sentences from the hero, the canonical address from the configured origin, Open Graph fields.
- One block of JSON-LD with the organisation and the software application: the name, the address, the description. No rating, no review count, no customer and no price. Those are claims a search engine would show, and the page's own sections are where their terms are. Write `<` as `<` when serialising, so no string can close the script tag.
- `robots.ts` and `sitemap.ts` name the page only when the server says it is indexable. See [measure.md](measure.md).
