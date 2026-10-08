# Branching and releases

These rules decide where every change to opencode-goal-plugin goes and how versions ship.
They apply to humans and agents alike, on every task, without being restated in prompts.

The core idea: **a change's target release is decided before work starts, and the target
decides the base branch.** A release is a tag on a branch — never a set of commits picked
from somewhere else after the fact.

## Current state

The block below is read by tools; the table is generated from it. Change both with
`release-state-update.sh` (or `/ycc:release-model`), never by hand.

<!-- ycc-release-state
model: trunk-only
trunk: main
support: latest-minor
backport_label: backport:{X.Y}
tracker: linear-labels
tracker_ref: Release
-->

<!-- ycc-release-state:table:begin -->

Model: **trunk-only**. Support window: latest-minor.

| Role  | Branch | Notes                        |
| ----- | ------ | ---------------------------- |
| Trunk | `main` | Every release is tagged here |

<!-- ycc-release-state:table:end -->

## Rules

1. **Know the target before you branch.** Every issue carries a target release (see
   [Planning](#planning)). No target: a bug in a shipped version is a patch; everything else
   goes to the next release.
2. **Branch off `main` and PR back into it.** Topic branches are short-lived (days, not
   weeks) and named `<type>/<issue-id>-<slug>`. If one falls behind, rebase it.
3. **Never "sync" one long-lived branch into another.** No `sync main into …` PRs.
4. **Every release comes from `main`.** Fixes ship in the next release; there are no
   maintenance branches and no backports. When an older version needs patches, upgrade the
   model with `/ycc:release-model --upgrade` instead of branching ad hoc.
5. **No new long-lived branches.** Large work lands on `main` in small PRs. See
   [Unfinished work](#unfinished-work).
6. **`main` is always releasable.** CI green, and nothing half-built reachable by users.
7. **Only maintainers cut releases**, following [Releasing](#releasing). Agents never tag.

## Where does my change go?

Every change targets the next release and goes into `main`. Bugs and security fixes
may prompt an earlier release; they never create a branch of their own.

## Unfinished work

Big features merge incrementally instead of living on a side branch. Anything a user could
reach before it is finished stays hidden: behind a setting or environment variable that
defaults to off, or simply not wired into navigation or routes until the last PR. When a
change cannot be hidden (a rename, a data-directory move), prepare everything behind the
scenes first and make the switch in one final PR shortly before the release.

List the project's feature switches here as they are added, with their default and the
release that flips them.

## Releasing

Tags follow `vX.Y.Z`. Version files: `package.json`. Changelog:
none yet (GitHub release notes). `.github/workflows/publish.yml` publishes to npm on every push to `main`: it computes the next patch version from npm, publishes, and creates the `vX.Y.Z` tag and GitHub release itself.

### Every release — from `main`

Releases are automatic: every merge to `main` runs `.github/workflows/publish.yml`, which
computes the next patch version from npm, publishes it, and tags and releases `vX.Y.Z`.

1. Merge the PR into `main` (squash; the PR title is the commit subject).
2. For a minor or major bump, raise `version` in `package.json` above the last published version before merging; `scripts/resolve-ci-version.ts` otherwise bumps the patch.
3. Verify with `npm view @yandy-r/opencode-goal-plugin version` and `gh release view vX.Y.Z`.

Agents never tag or publish by hand.

`/ycc:releaser` automates these steps and checks you are on the right branch.

## Planning

Every issue gets a target release at triage as a label from the single-select **Release** label group in Linear (`v0.1.x` for the patch line, `v0.2.0` for the next minor). Add a label to the group when a new version is planned.
