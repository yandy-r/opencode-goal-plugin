# yan-948: OpenCode v2 shell result evidence

## Finding

On Linux with `opencode v2.0.25`, the built-in `shell` tool result provides explicit exit metadata for normal completion and an explicit timeout flag for timeout. Use the integer `result.metadata.exit` as the success signal, guarded by `result.metadata.timeout !== true`. Do not infer success from tool status, output text, or presence/absence of error prose.

| Case    | `execute.after` result metadata                            | Output                                                                             | Interpretation                                             |
| ------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Exit 0  | `{ status: "completed", truncated: false, exit: 0 }`       | `{ exit: 0, status: "completed", output: "yan948-exit0-ok" }`                      | successful shell command                                   |
| Exit 1  | `{ status: "completed", truncated: false, exit: 1 }`       | `{ exit: 1, status: "completed", output: "yan948-exit1-stderr" }`                  | failed shell command; output can still contain stderr text |
| Timeout | `{ status: "completed", truncated: false, timeout: true }` | `{ timeout: true, status: "completed", output: "...Command exceeded timeout..." }` | timed out; no `exit` field                                 |

The persisted `session.context` tool part has the same `state.metadata` values after server restart. Timeout output included the start marker but not the end marker. All three hook records and all three persisted tool parts were observed; capture summary reports 6 model calls before and after restart, with no additional calls during recapture.

## Safe decision rule

For this tested shape, consider shell execution successful only when metadata contains an integer `exit` equal to `0` and `timeout !== true`. Treat nonzero exits, timeout, missing/unknown metadata, and any unrecognized shape as failure. A status-only fallback is **NO-GO**: all three cases report tool status `completed`, including exit 1 and timeout.

Do not parse output strings or treat empty output, success-looking text, or an error message as authoritative exit state. Truncation is separate from success; this capture observed `truncated: false` only.

## Scope and limits

Evidence covers the foreground built-in shell tool on Linux, OpenCode v2.0.25 only. It does not establish behavior for background commands, other platforms or versions, arbitrary wrappers, or other tools. Do not generalize result parsing beyond the tested shape without new evidence.

## Reproduction and fixture

Capture with the isolated harness and pinned binary:

```bash
OPENCODE_V2_BIN=/tmp/opencode/yan-948-cli-2.0.25/node_modules/.bin/opencode2 bun run scripts/capture-v2-shell-results.ts
```

The harness reports its evidence directory under `/tmp/opencode/yan-948-capture-*`; inspect `hooks.jsonl`, `contexts/pre-*.json`, `contexts/post-*.json`, matching `contexts/rest-*.json`, `summary.json`, `baseline-sha.txt`, and `version.txt`. Confirm baseline SHA matches the intended worktree before citing capture provenance.

Authoritative capture: `/tmp/opencode/yan-948-capture-S4bisl`, summary `PASS`, baseline `aa91e646c8f7fa96ddfdf5db5acafd49881eaae4` (worktree HEAD `aa91e64`), `opencode v2.0.25`, 6/6 model calls and 3/3 hook records across restart. An earlier capture (`/tmp/opencode/yan-948-capture-GpqG3m`) used incorrect baseline `fe59631c2c25df687ec84493784db39366c58b11` due to a path calculation error; it is superseded and must not be cited as provenance.

Captured fixtures are checked in at `test/fixtures/opencode-shell-v2.0.25.json`. Run their focused checks with `bun test test/shell-result-fixtures.test.ts`.
