# opencode-goal-plugin — Agent Rules

OpenCode plugin adding Codex-style long-running goal mode: a `/goal` command, goal tools, persistence, and a TUI sidebar. Server entry `src/server.ts`, TUI entry `src/tui.ts`, state in `src/state.ts`. See [`AGENTS.md`](AGENTS.md) for project-specific change guidelines.

## Precedence

1. System, developer, and explicit user instructions for the task.
2. This file and [`AGENTS.md`](AGENTS.md) as repo policy.
3. General best practices when nothing above conflicts.

## MUST / MUST NOT

- **Secrets**: **Never** commit `.env`, `.env.encrypted`, tokens, or API keys.
- **Issues**: Use the YAML form templates under `.github/ISSUE_TEMPLATE/` when present. **Do not** create title-only or template-bypass issues. If `gh issue create --template` fails, create the issue via GitHub API/tooling with a body that mirrors the form fields, then apply correct labels — **not** a vague one-liner.
- **Pull requests**: Follow `.github/pull_request_template.md` when present. **Always** link the related issue (`Closes #…`). **Label** PRs using the project taxonomy — **never** invent ad-hoc labels.
- **Commits**: Use **Conventional Commits 1.0.0** — `feat|fix|docs|refactor|perf|test|build|ci|chore(scope): …`. Write the title as you want it to appear in `CHANGELOG.md`.
- **Internal docs commits**: Files under `docs/plans`, `docs/research`, or `docs/internal` **must** use `docs(internal): …`. Other non-user-facing churn: prefer `chore(…): …` to stay out of release notes.
- **Large features**: Split into smaller phases and tasks with clear dependencies and order of execution.
- **File size (~500 lines)**: Aim for **around 500 lines** per file as a soft cap. Files that drift meaningfully past that **must** be refactored into smaller modules unless the content is inherently contiguous (generated code, schemas, large test fixtures). The intent is maintainability, not a hard ceiling.
- **Modularity & reuse**: Code **must** decompose into small, cohesive units — submodules, libraries, or reusable components — with a clear public surface and minimal cross-module coupling. **No copy-paste duplication** (DRY): extract shared logic into a shared module. Prefer composition over inheritance. Avoid circular dependencies.
- **Single responsibility**: Each function, module, and component **must** have one clear reason to exist. Split when a unit grows more than one responsibility.
- **MCP**: When an MCP server fits the task (GitHub, docs, browser, etc.), **prefer it**. **Read** each tool's schema/descriptor before calling.

## SHOULD (implementation)

### General

- **Naming**: Intention-revealing names for functions, types, and modules. Public APIs should read like documentation.
- **No dead code**: Remove unused code, imports, and commented-out blocks. Git preserves history.
- **Dependency hygiene**: Before adding a new dependency, check whether an existing one does the job. New deps need a justification (maintenance cost, license, security).
- **Fail fast at boundaries**: Validate inputs at module and system boundaries; propagate via typed errors. Never silently swallow errors.
- **Tests alongside changes**: New or modified behavior ships with tests in the same change.
- **Default to worktrees**: For non-trivial work (multi-step features, refactors, changes touching multiple files), start in a git worktree instead of the main checkout. See [Git Worktrees](#git-worktrees) below. Fall back to the main checkout only when the task is a one-liner, must observe the current working tree state, or worktree creation is blocked (detached HEAD, shallow clone, submodule issues).

- **TypeScript**: `PascalCase` components; `camelCase` hooks and functions; strict TS enabled — prefer `unknown` over `any`; errors-as-values where idiomatic; no implicit `any`.

## Git & Conventional Commits

This project uses **Conventional Commits 1.0.0**. Every commit title must match:

```text
<type>[optional scope]: <description>
```

### Types

| Type       | Purpose                                     | Version bump |
| ---------- | ------------------------------------------- | ------------ |
| `feat`     | New user-facing feature                     | minor        |
| `fix`      | User-facing bug fix                         | patch        |
| `docs`     | Documentation only                          | —            |
| `refactor` | Code change that is neither fix nor feature | —            |
| `perf`     | Performance improvement                     | —            |
| `test`     | Adding or correcting tests                  | —            |
| `build`    | Build system or external dependency changes | —            |
| `ci`       | CI/CD configuration changes                 | —            |
| `chore`    | Other non-user-facing changes               | —            |
| `style`    | Formatting/whitespace only                  | —            |

### Scope

`feat(auth): …` — scope is the module, crate, package, or area of change. Keep it concise.

### Breaking changes

Append `!` after the type/scope (`feat!: …`) **or** add a `BREAKING CHANGE: …` footer. Either triggers a major version bump.

### Internal docs

Use `docs(internal): …` for files under `docs/plans`, `docs/research`, or `docs/internal`. These stay out of release notes.

## Git Worktrees

**Strong preference**: work in a git worktree for any non-trivial task. Worktrees keep the main checkout clean for parallel work, let multiple agents run concurrently without stepping on each other, and make it trivial to abandon a failed attempt (`git worktree remove`). Use the main checkout only when the task is a one-liner, requires observing the current working tree state, or worktree creation is blocked.

The Claude Code harness creates worktrees inside the current repo at `<repo-root>/.claude/worktrees/`. That repo-local parent is also the path Claude Code allows when entering managed worktrees, so do not redirect harness-created worktrees outside the repository.

- **Preferred parent**: `<repo-root>/.claude/worktrees/` for all agent-managed worktrees, named `<repo>-<branch>/`. Generated target bundles use their corresponding agent-local roots (`.codex`, `.cursor`, or `.config/opencode`).
- **Manual creation**: when invoking `git worktree add` yourself, target `<repo-root>/.claude/worktrees/<repo>-<branch>/`.
- **Harness-created worktrees** (`isolation: "worktree"`, `EnterWorktree`): the `WorktreeCreate` hook replaces Claude Code's default git behavior, so the hook must create the worktree itself and print the created absolute path on stdout.
- **Repo hygiene**: if the harness has already created `<repo-root>/.claude/worktrees/`, add `.claude/worktrees/` to `.gitignore` before committing.

## GitHub Workflow

- **Labels**: Use only the project's defined label taxonomy (`type:`, `area:`, `priority:`, `status:` families). Never create ad-hoc labels.
- **Issues**: File an issue before starting non-trivial work. Link the issue number in the PR (`Closes #…`).
- **PRs**: Follow the PR template; fill every checklist item honestly. Small, focused PRs over large omnibus ones.

## Testing & Verification

Run the following before marking any task complete:

```bash
bun run test
bun run lint
bun run build
```

After substantive changes, confirm the output matches expectations — do not rely solely on "it compiled".

## Stack Overview

| Layer               | Technology     | Notes |
| ------------------- | -------------- | ----- |
| Primary language    | **TypeScript** | —     |
| Secondary languages | —              | —     |
| Package manager     | bun            | —     |

## Commands

```bash
# Test
bun run test

# Lint
bun run lint

# Build
bun run build
```

## Branching & releases

[`RELEASING.md`](RELEASING.md) is the source of truth for branches and releases. Branch
off `main` and PR back into it; every release is tagged from `main`. Never merge one
long-lived branch into another to sync it.
