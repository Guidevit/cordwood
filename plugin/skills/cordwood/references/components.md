# Installing the components

Six components install the shadcn/ui way: the CLI copies the source into the app, where it composes the app's own primitives. After that the file belongs to the app and may be edited.

## Before the first one

1. The project has a `components.json`. If not, shadcn/ui is not set up: ask before running `npx shadcn init`. Its `style` must be a Radix one (`radix-nova`, `new-york`). On a Base UI style (`base-nova`) `tour-card` and `members-table` do not compile: say so before adding them.
2. Add the registry to `components.json`, keeping whatever `registries` already holds:

```json
{
  "registries": {
    "@cordwood": "https://raw.githubusercontent.com/Guidevit/cordwood/main/registry/r/{name}.json"
  }
}
```

## Add

```bash
npx shadcn add @cordwood/tour-card
```

The CLI adds the primitives the component uses and, for `tour-card`, installs `@cordwood/tour`. If it asks to overwrite a primitive the project already has, answer no: the project's version wins.

After adding, read the new file in `components/`. Its props and its `labels` type are the reference.

| Component | Renders | The app passes | The app handles |
|---|---|---|---|
| `tour-card` | The tour's popover, ring and buttons | `tour` from `useTour`, `labels` | nothing: the buttons call the tour |
| `survey-prompt` | One question with its scale and a comment field | `kind` from `surveys.ask`, `labels` | `onAnswer` posts to the answer route, `onDismiss` unmounts it |
| `changelog-dialog` | A button with an unread dot, and the notes in a dialog | `notes`, `unread`, `labels`, optional `email` | `onRead` posts to the read route, `email.onChange` to the subscribe route |
| `unsubscribe-card` | The page an unsubscribe link opens | `endpoint`, `labels` | nothing: it posts `{ token }` to `endpoint` |
| `subscription-card` | Status, next date, and subscribe or manage | `subscription` from `billing.subscription`, `labels` | `onSubscribe` and `onManage` post to the routes and send the browser to the URL |
| `members-table` | Members with role pickers and remove | `members`, `canManage`, `currentUid`, `labels` | `onChangeRole` and `onRemove` post to the routes, then refresh the list |

## Rules

- **Write every label in the app's language.** No component holds a sentence. For a Portuguese app, `labels` are in Portuguese, including the functions (`position: (atual, total) => \`${atual} de ${total}\``).
- **A component calls no route.** Each handler is where the app posts to its own route. Return the promise, so the component shows its busy state until the request ends.
- **Data arrives as props.** Fetch on the server (a server component calling the package) and pass the result down. A `Date` crosses to a client component as a prop without trouble. Through a JSON route it arrives as a string, so turn it back into a `Date` before passing it to `subscription-card`.
- **`canManage` comes from the server.** Compute it from the permission `access.require` checked, never from a role name compared in the browser.
- **Place it yourself.** `survey-prompt` has no position of its own: put it in a fixed corner or inside a page. `changelog-dialog` renders its own trigger button, for a header or a menu.
- **Use the project's data layer.** If the project has React Query, SWR or server actions, call the routes through it. Do not add a second way to fetch.
