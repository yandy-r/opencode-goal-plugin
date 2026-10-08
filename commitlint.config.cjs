// commitlint.config.cjs — Conventional Commits 1.0.0 for opencode-goal-plugin
//
// Install dependencies:
//   bun add -D @commitlint/cli @commitlint/config-conventional
//
// Wire into husky:
//   npx husky add .husky/commit-msg 'npx --no -- commitlint --edit "$1"'
//
// Wire into lefthook (lefthook.yml):
//   commit-msg:
//     commands:
//       commitlint:
//         run: npx commitlint --edit {1}

/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "refactor",
        "perf",
        "test",
        "build",
        "ci",
        "chore",
        "style",
        "revert",
      ],
    ],
    "subject-case": [2, "never", ["pascal-case", "upper-case"]],
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [0],
  },
}
