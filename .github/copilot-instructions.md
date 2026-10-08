# GitHub Copilot / code-agent PR guidance — opencode-goal-plugin

This file is read by GitHub Copilot's coding agent when it opens or edits a
pull request. OpenAI Codex and Anthropic's code-agent bots read
[`AGENTS.md`](../AGENTS.md) / [`CLAUDE.md`](../CLAUDE.md), which are the
**canonical** agent rules — the points below are the PR-workflow essentials
re-stated for agents that land here first.

## PR title — Conventional Commits, enforced

PR titles are validated by
[`.github/workflows/pr-title.yml`](workflows/pr-title.yml) and the check is
required to merge. Use:

```text
<type>[optional scope]: <description>
```

- Allowed types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `style`. Version-bump semantics: see
  [`CLAUDE.md`](../CLAUDE.md) § _Git & Conventional Commits_.
- **Never open a PR with `[WIP]`, `[Draft]`, `Draft:`, `WIP:`, or
  `Initial plan` in the title.** The workflow rejects these prefixes. For
  work-in-progress, use GitHub's native **Draft PR** status instead.
- The PR title becomes the **squash-merge commit subject verbatim** and
  appears in `CHANGELOG.md` / `git log`. Write it exactly as it should read.
- Internal-only docs (files under `docs/plans/`, `docs/research/`,
  `docs/internal/`) must use `docs(internal): …` so they stay out of
  release notes.

### Fixing a rejected title

Edit the existing PR in place — **do not open a replacement PR**:

```text
gh pr edit <number> --title "<new-title>"
```

Or use the GitHub UI. The workflow re-runs automatically on edit.

> Safety net: [`workflows/pr-title-autofix.yml`](workflows/pr-title-autofix.yml)
> runs in parallel and will (1) strip `[WIP]` / `[Draft]` / `Draft:` / `WIP:` /
> `Initial plan` prefixes from the PR title server-side, then convert the PR
> to draft; and (2) normalize a leading Conventional Commit type that was
> written without a colon or with capitalization — e.g. `Refactor X` becomes
> `refactor: X`, `Feat(auth): X` becomes `feat(auth): X`. It exists because
> some coding-agent runtime tokens lack `pull_requests:write` and cannot edit
> their own title after the fact. **Do not rely on it** — produce a clean
> Conventional Commit title up-front; the autofix workflow is a last-resort
> guardrail, not an excuse to bypass these rules.

### Work-in-progress

Use GitHub's native **Draft PR** status (the "Draft" toggle when opening, or
`gh pr ready --undo`). Never encode work-in-progress by prefixing the title
with `[WIP]` or `Draft:` — both are rejected by the title workflow.

## PR body

- Follow [`pull_request_template.md`](pull_request_template.md). Fill every
  checklist item honestly; don't leave stubs.
- Always link the issue: `Closes #…` for standalone issues, or
  `Part of #…` for child PRs of an umbrella/tracker issue.
- Label PRs using the repo's taxonomy only — see
  [`labels.md`](labels.md) or [`CLAUDE.md`](../CLAUDE.md) § _Labels_.
  **Never invent ad-hoc labels.**

## Scope

- Keep PRs **small and focused** — one logical change per PR. Omnibus PRs
  (multiple unrelated features, refactors, and bug fixes in one branch) are
  harder to review and harder to revert. Split into smaller PRs with clear
  dependencies when the scope grows.

## Commits inside the PR

This repository's convention is **squash-only merges**, so the PR title is
what lands on the default branch. Interior commits may be informal during
development; the final PR title is the contract.

If the repo is configured for merge commits instead, each interior commit is
independently enforced by the project's `commit-msg` hook (see
[`docs/lefthook-usage.md`](../docs/lefthook-usage.md) when `--git` was used
during `ycc:init`).

## Security

- **Never** commit `.env`, `.env.encrypted`, tokens, API keys, service
  credentials, or any secret material.
- Configuration must come from environment variables or a secret-management
  system — never hard-coded.
- If you think you may have committed a secret, **stop and tell a
  maintainer** before opening a PR; rotate the credential and force-push
  the branch only after coordinating.

## Everything else

For architecture boundaries, module/file-size bars, persistence rules,
firewalled-agent environment rules, `gh` quoting conventions, and
language-specific build/test commands (TypeScript), read
[`CLAUDE.md`](../CLAUDE.md) and [`AGENTS.md`](../AGENTS.md) before writing
code.
