# Workflows

| Workflow               | Trigger                                    | Purpose                                                                                                       |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `ci.yml`               | PR to `main`                               | Typecheck, lint, tests with coverage, build, and V2 lifecycle smoke                                           |
| `lint.yml`             | PR, push to `main`                         | Runs `./scripts/style.sh lint` (biome, prettier, markdownlint, shellcheck)                                    |
| `lint-autofix.yml`     | Same-repo PR                               | Applies formatter fixes and pushes them back to the PR branch                                                 |
| `pr-title.yml`         | PR opened/edited                           | Requires a Conventional Commit PR title (make it a required check)                                            |
| `pr-title-autofix.yml` | PR opened/edited                           | Strips placeholder prefixes and normalizes the title type                                                     |
| `publish.yml`          | Push to `main`, push of a `v*` tag, manual | Gates, then publishes: `main` → `dev` snapshot; `v*` tag → tagged version to `latest` plus the GitHub release |

## Release

Releases are tag-driven; merging to `main` publishes only a `dev` snapshot. See [`RELEASING.md`](../../RELEASING.md).
Re-run a failed release with `gh workflow run publish.yml --ref vX.Y.Z`
(`publish.yml` declares `workflow_dispatch`).

**Secrets/permissions:** npm Trusted Publishing via `id-token: write` (no npm token secret needed); `GITHUB_TOKEN` creates the release.

**Local reproduction:** `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run test && bun run build`.

**Rollback:** `npm deprecate @yandy-r/opencode-goal-plugin@<version> "<reason>"` and merge a fix; do not
unpublish.
