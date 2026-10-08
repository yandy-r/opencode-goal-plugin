# Workflows

| Workflow               | Trigger                | Purpose                                                                                     |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `ci.yml`               | PR to `main`           | Typecheck, lint, tests with coverage, build, and V2 lifecycle smoke                         |
| `lint.yml`             | PR, push to `main`     | Runs `./scripts/style.sh lint` (biome, prettier, markdownlint, shellcheck)                  |
| `lint-autofix.yml`     | Same-repo PR           | Applies formatter fixes and pushes them back to the PR branch                               |
| `pr-title.yml`         | PR opened/edited       | Requires a Conventional Commit PR title (make it a required check)                          |
| `pr-title-autofix.yml` | PR opened/edited       | Strips placeholder prefixes and normalizes the title type                                   |
| `publish.yml`          | Push to `main`, manual | Gates, then publishes the next patch to npm and creates the `vX.Y.Z` tag and GitHub release |

## Release

Releases are continuous: every merge to `main` publishes. See [`RELEASING.md`](../../RELEASING.md).
Re-run a failed release with `gh workflow run publish.yml --ref main`
(`publish.yml` declares `workflow_dispatch`).

**Secrets/permissions:** npm Trusted Publishing via `id-token: write` (no npm token secret needed); `GITHUB_TOKEN` creates the release.

**Local reproduction:** `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run test && bun run build`.

**Rollback:** `npm deprecate @yandy-r/opencode-goal-plugin@<version> "<reason>"` and merge a fix; do not
unpublish.
