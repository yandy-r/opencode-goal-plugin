import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getGoal, recordAssistantProgress, recordPromptAgent } from "../src/state"
import { StateLockLostError, StateLockTimeoutError, withStateLock } from "../src/state-lock"

let dir = ""
let stateFile = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-lock-"))
  stateFile = join(dir, "goals.json")
  process.env.OPENCODE_GOAL_STATE_PATH = stateFile
})

afterEach(async () => {
  delete process.env.OPENCODE_GOAL_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

test("concurrent processes sharing the state file do not lose each other's goals", async () => {
  const writer = join(import.meta.dir, "fixtures", "state-writer.ts")
  const count = 60
  const processes = ["ses_a", "ses_b", "ses_c"].map((sessionID) =>
    Bun.spawn([process.execPath, writer, sessionID, String(count)], {
      env: { ...process.env, OPENCODE_GOAL_STATE_PATH: stateFile },
      stderr: "pipe",
    }),
  )
  const codes = await Promise.all(processes.map((child) => child.exited))
  expect(codes).toEqual([0, 0, 0])

  for (const sessionID of ["ses_a", "ses_b", "ses_c"]) {
    const goal = await getGoal(sessionID)
    expect(goal?.tokensUsed).toBe(count)
  }
  await expect(stat(`${stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" })
}, 60_000)

test("mutations for a session without a goal do not write the state file", async () => {
  expect(await recordPromptAgent("ses_nogoal", "build")).toBeNull()
  await expect(stat(stateFile)).rejects.toMatchObject({ code: "ENOENT" })

  const existing = `${JSON.stringify({ version: 3, goals: {}, archives: {} }, null, 2)}\n`
  await writeFile(stateFile, existing)
  await recordPromptAgent("ses_nogoal", "build")
  await recordAssistantProgress("ses_nogoal", { text: "hello", outputTokens: 10 })
  expect(await readFile(stateFile, "utf8")).toBe(existing)
})

test("withStateLock serializes holders and removes the lock afterwards", async () => {
  const order: string[] = []
  let entered!: () => void
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  const first = withStateLock(stateFile, async () => {
    order.push("first:start")
    entered()
    await Bun.sleep(50)
    order.push("first:end")
  })
  await firstEntered
  const second = withStateLock(stateFile, async () => {
    order.push("second")
  })
  await Promise.all([first, second])
  expect(order).toEqual(["first:start", "first:end", "second"])
  await expect(stat(`${stateFile}.lock`)).rejects.toMatchObject({ code: "ENOENT" })
})

test("withStateLock breaks a stale lock left by a dead holder", async () => {
  const lockFile = `${stateFile}.lock`
  await writeFile(lockFile, "999999:dead")
  const old = new Date(Date.now() - 60_000)
  await utimes(lockFile, old, old)

  expect(await withStateLock(stateFile, async () => "ran", { staleMs: 1_000 })).toBe("ran")
  await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" })
})

test("withStateLock times out instead of running unlocked when a live holder keeps the lock", async () => {
  const lockFile = `${stateFile}.lock`
  await writeFile(lockFile, "1:live")
  let ran = false
  await expect(
    withStateLock(
      stateFile,
      async () => {
        ran = true
      },
      { staleMs: 60_000, timeoutMs: 100, retryMs: 10 },
    ),
  ).rejects.toBeInstanceOf(StateLockTimeoutError)
  expect(ran).toBe(false)
  expect(await readFile(lockFile, "utf8")).toBe("1:live")
})

test("a holder whose stale lock was taken over cannot pass assertHeld", async () => {
  const lockFile = `${stateFile}.lock`
  await expect(
    withStateLock(stateFile, async (lock) => {
      await lock.assertHeld()
      await writeFile(lockFile, "2:successor")
      await lock.assertHeld()
    }),
  ).rejects.toBeInstanceOf(StateLockLostError)
  // The successor's lock is left in place on release.
  expect(await readFile(lockFile, "utf8")).toBe("2:successor")
})

test("concurrent waiters break a stale lock once and never overlap", async () => {
  const lockFile = `${stateFile}.lock`
  await writeFile(lockFile, "999999:dead")
  const old = new Date(Date.now() - 60_000)
  await utimes(lockFile, old, old)
  let active = 0
  let maxActive = 0
  const results = await Promise.all(
    [1, 2, 3, 4].map((index) =>
      withStateLock(
        stateFile,
        async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await Bun.sleep(10)
          active -= 1
          return index
        },
        { staleMs: 1_000, retryMs: 5 },
      ),
    ),
  )
  expect(results.sort()).toEqual([1, 2, 3, 4])
  expect(maxActive).toBe(1)
  await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" })
  await expect(stat(`${lockFile}.break`)).rejects.toMatchObject({ code: "ENOENT" })
})
