---
name: improve
description: Use while building with @cordwood when a package has a bug, lacks something any app would need, or its README sent you to a wrong call, and when a cordwood skill gave an instruction that was wrong, missing or out of date. Fixes the cause in the Guidevit/cordwood repository, with a test, and always proposes it as a pull request, never a push to main, so the next app does not meet the same problem. Also in Portuguese (bug no package, faltou no framework, a skill errou, melhorar o cordwood).
---

# Improve cordwood from the field

You found the problem while building a real app. That makes you the best-placed person to fix it, now, while the failing case is in front of you. Do not work around it in the app and move on: the next app would meet it again.

## Is it cordwood's to fix?

Fix upstream when one of these is true.

- A package does something its README says it does not, or fails on valid input.
- A package lacks a capability that any app of its kind needs (a missing option, a return value you had to recompute).
- A README or a skill named a function, an option or a step that does not exist or does not work.
- A skill left out a step you had to discover, or its walk missed a failure a user would hit.

Keep it in the app when the need comes from this product alone. The packages know no business: no domain word, no product name, no rule of one industry. If you cannot describe the change without naming the app, it belongs in the app.

When unsure, write the problem down in one sentence that names no app. If the sentence still makes sense, it is cordwood's.

## Fix it

1. **Get the repository**, outside the app's folder, so nothing of the app can be committed by accident.

   ```bash
   git clone https://github.com/Guidevit/cordwood ~/.cordwood/repo   # first time
   git -C ~/.cordwood/repo pull --ff-only                           # after that
   ```

   Read its `README.md`. The rules there bind the fix: packages stay agnostic, Firebase through firebase-admin, no environment variable read inside a package.

2. **Reproduce it in a test first.** Add a failing test beside the package's other tests (`*.test.ts`, or `*.emulator.test.ts` when it needs Firestore or Auth). A README or skill fix needs no new test, but `plugin/skill.test.ts` must still pass.

3. **Make the smallest change that fixes the cause.** Follow the surrounding code. Update the package's README when behaviour or an option changed, and the skill text when an instruction was wrong.

4. **Run everything.**

   ```bash
   pnpm install && pnpm build && pnpm typecheck && pnpm test
   ```

   Do not push while anything fails, and do not weaken a test to make it pass.

5. **Describe the change for the release.** For a package, add a changeset: a file in `.changeset/` naming the package and `patch` for a fix or `minor` for an addition, with one sentence a user of the package would understand. For the plugin, raise `version` in `plugin/.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json`.

6. **Commit** with a message that says what was wrong and what it does now.

## Send it

Every fix goes up as a pull request, whether or not you may push to the repository. Never push to `main`: the owner reads the change before it reaches every other app.

Commit on a branch of its own, cut from an up-to-date `main` and named after the problem.

```bash
git switch -c fix/<short-name>
```

Check what you may do: `gh api repos/Guidevit/cordwood --jq .permissions.push`.

**With push access (`true`)**: push the branch to the repository.

```bash
git push -u origin fix/<short-name>
```

**Without push access**: push the branch to a fork.

```bash
gh repo fork Guidevit/cordwood --remote --remote-name fork
git push -u fork fix/<short-name>
```

Then open the pull request against `main`, in both cases, and watch its checks:

```bash
gh pr create --repo Guidevit/cordwood --base main --title "<what was wrong>" --body "<the failing case, and what it does now>"
gh pr checks --watch
```

The body names the failing case and the fix, and nothing of the app. If CI fails on the pull request, fix it on the same branch. Without `gh`, give the user the text of an issue to open.

Merging is the owner's decision. Do not merge your own pull request, and do not merge the "Version Packages" pull request that publishes to npm. Give the user the link, and keep the app moving with the narrowest workaround, with a comment on it that links the pull request. Once the fix is merged and released, update the app: `pnpm update @cordwood/<name>`.

Several fixes found in one session may share a pull request, one commit per problem.

## Then return to the app

- Remove a workaround once its fix is merged and released. Until then it stays, with its comment.
- Tell the user in two lines what was wrong upstream and what you changed, with the pull request link.
- A skill fix reaches other sessions once it is merged and the plugin updates (`/plugin marketplace update cordwood`). In this session you already know the correction: follow it.

## Limits

- **Nothing of the app goes upstream.** No app code, no customer or product name, no key, no real e-mail address, no data from its database. The repository is public. Write the test with invented values.
- **A breaking change waits for the user.** Removing or renaming something exported, or changing what a call returns, breaks every other app. Describe it and ask before opening the pull request.
- **Stop and ask when the fix is not small.** A new package, a redesign of an API, or a change across three or more packages is a decision for the repository's owner.
- **One problem per commit.** Do not tidy unrelated code while you are there.
- **Never push to `main`, skip CI, force-push, or publish from your machine.** The release runs in GitHub Actions only.
- **If the push or the pull request is refused**, by GitHub or by a permission prompt, do not look for another way in. Report what you prepared and where it is.
