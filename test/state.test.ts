import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  accountUsage,
  cancelActiveGoal,
  cancelGoal,
  clearGoal,
  completeGoal,
  createGoal,
  DEFAULT_MAX_OBJECTIVE_CHARS,
  getAllGoals,
  getGoal,
  getGoalHistory,
  getGoalInternal,
  getGoalSync,
  markGoalUnmet,
  markPendingContinuationStarted,
  pauseGoalForPlanMode,
  recordAssistantProgress,
  recordContinuationResult,
  recordPromptAgent,
  recordToolProgress,
  replaceGoal,
  reserveContinuation,
  rollbackContinuationAttempt,
  setGoalStatus,
  setGoalWaiting,
  updateGoalObjective,
  validateEvidence,
  validateObjective,
} from "../src/state"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
})

afterEach(async () => {
  delete process.env.OPENCODE_GOAL_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

test("creates, reads, pauses, resumes, completes, and clears a goal", async () => {
  const created = await createGoal("ses_1", "ship the plugin", 100)
  expect(created.status).toBe("active")
  expect(created.tokenBudget).toBe(100)
  expect(created.remainingTokens).toBe(100)
  expect(created.sampledAt).toBeGreaterThanOrEqual(created.createdAt)

  await accountUsage("ses_1", 40)
  expect((await getGoal("ses_1"))?.tokensUsed).toBe(40)

  expect((await setGoalStatus("ses_1", "paused")).status).toBe("paused")
  expect((await setGoalStatus("ses_1", "active")).status).toBe("active")
  const completed = await completeGoal("ses_1", "tests passed")
  expect(completed.status).toBe("complete")
  expect(completed.completionEvidence).toBe("tests passed")
  expect(await clearGoal("ses_1")).toBe(true)
  expect(await getGoal("ses_1")).toBeNull()
})

test("cancels, clears, and replaces goals while preserving per-session history", async () => {
  await createGoal("ses_1", "first goal", null)
  const cancelled = await cancelGoal("ses_1")
  expect(cancelled).toMatchObject({
    status: "cancelled",
    stopReason: "cancelled",
    closedAt: expect.any(Number),
  })
  expect(await reserveContinuation("ses_1", 10, 0)).toBeNull()

  const replacement = await replaceGoal("ses_1", "second goal", null)
  expect(replacement.replaced).toMatchObject({ objective: "first goal", status: "cancelled" })
  expect(replacement.goal).toMatchObject({ objective: "second goal", status: "active" })

  expect(await clearGoal("ses_1")).toBe(true)
  expect(await getGoal("ses_1")).toBeNull()
  expect(await getGoalHistory("ses_1")).toMatchObject({
    current: null,
    previous: [
      { objective: "first goal", status: "cancelled" },
      { objective: "second goal", status: "cancelled", stopReason: "cleared" },
    ],
  })

  const third = await createGoal("ses_1", "third goal", null)
  expect(third.status).toBe("active")
  expect((await getGoalHistory("ses_1")).previous).toHaveLength(2)
})

test("host cancellation observes a queued pause atomically while explicit stop can still close it", async () => {
  await createGoal("ses_1", "preserve the pause contract", null)
  const [, result] = await Promise.all([
    setGoalStatus("ses_1", "paused"),
    cancelActiveGoal("ses_1"),
  ])
  expect(result?.status).toBe("paused")
  expect((await setGoalStatus("ses_1", "active")).status).toBe("active")
  expect((await cancelActiveGoal("ses_1"))?.status).toBe("cancelled")
  await createGoal("ses_1", "explicit stop may close a paused goal", null)
  await setGoalStatus("ses_1", "paused")
  expect((await cancelGoal("ses_1"))?.status).toBe("cancelled")
})

test("closed and cancelled goals cannot be edited or closed again", async () => {
  await createGoal("ses_1", "do not reopen", null)
  await cancelGoal("ses_1")

  await expect(updateGoalObjective("ses_1", "reopened")).rejects.toThrow("goal is closed")
  await expect(completeGoal("ses_1", "stale completion")).rejects.toThrow("already closed")
  expect(await getGoal("ses_1")).toMatchObject({ objective: "do not reopen", status: "cancelled" })
})

test("archives compact goal state and writes version 3 after migrating version 1", async () => {
  await writeFile(
    process.env.OPENCODE_GOAL_STATE_PATH!,
    JSON.stringify({ version: 1, goals: {} }),
    "utf8",
  )
  await createGoal("ses_1", "x".repeat(3_000), null)
  await recordAssistantProgress("ses_1", {
    messageID: "message",
    text: "y".repeat(10_000),
    outputTokens: 100,
  })
  await completeGoal("ses_1", "e".repeat(DEFAULT_MAX_OBJECTIVE_CHARS))
  await clearGoal("ses_1")

  const persisted = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")) as {
    version: number
    archives: Record<string, Array<Record<string, unknown>>>
  }
  expect(persisted.version).toBe(3)
  expect(String(persisted.archives.ses_1?.[0]?.objective).length).toBeLessThanOrEqual(2_000)
  expect(String(persisted.archives.ses_1?.[0]?.completionEvidence).length).toBeLessThanOrEqual(
    2_000,
  )
  expect(persisted.archives.ses_1?.[0]).not.toHaveProperty("lastAssistantText")
  expect(persisted.archives.ses_1?.[0]).not.toHaveProperty("usageTrackers")
  expect(persisted.archives.ses_1?.[0]).not.toHaveProperty("pendingAttempt")

  persisted.archives.ses_1![0]!.completionEvidence = "z".repeat(5_000)
  await writeFile(process.env.OPENCODE_GOAL_STATE_PATH!, JSON.stringify(persisted), "utf8")
  expect(
    (await getGoalHistory("ses_1")).previous[0]?.completionEvidence?.length,
  ).toBeLessThanOrEqual(2_000)
  await accountUsage("missing")
  const normalized = JSON.parse(
    await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8"),
  ) as typeof persisted
  expect(String(normalized.archives.ses_1?.[0]?.completionEvidence).length).toBeLessThanOrEqual(
    2_000,
  )
})

test("reads and updates planless version 3 state without downgrading or losing metadata", async () => {
  await createGoal("ses_1", "preserve the existing objective", 100)
  const file = process.env.OPENCODE_GOAL_STATE_PATH!
  const state = JSON.parse(await readFile(file, "utf8"))
  state.version = 3
  state.goals.ses_1.plan = null
  state.goals.ses_1.planRevision = 0
  await writeFile(file, JSON.stringify(state), "utf8")

  expect(await getGoal("ses_1")).toMatchObject({
    objective: "preserve the existing objective",
    plan: null,
    planRevision: 0,
  })
  expect(getGoalSync("ses_1")).toMatchObject({ plan: null, planRevision: 0 })
  await accountUsage("ses_1", 20)
  await setGoalStatus("ses_1", "paused")
  const updated = JSON.parse(await readFile(file, "utf8"))
  expect(updated.version).toBe(3)
  expect(updated.goals.ses_1).toMatchObject({
    plan: null,
    planRevision: 0,
    tokensUsed: 20,
    status: "paused",
  })

  await clearGoal("ses_1")
  expect((await getGoalHistory("ses_1")).previous[0]).toMatchObject({ plan: null, planRevision: 0 })
  expect(JSON.parse(await readFile(file, "utf8")).version).toBe(3)
})

test("rejects malformed plans and unknown future state versions without rewriting them", async () => {
  await createGoal("ses_1", "preserve planning state", null)
  const file = process.env.OPENCODE_GOAL_STATE_PATH!
  const original = JSON.parse(await readFile(file, "utf8"))
  for (const incompatible of [
    {
      ...original,
      version: 3,
      goals: { ses_1: { ...original.goals.ses_1, plan: { phases: [] }, planRevision: 1 } },
    },
    { ...original, version: 4 },
  ]) {
    const content = JSON.stringify(incompatible)
    await writeFile(file, content, "utf8")
    await expect(accountUsage("ses_1", 1)).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe(content)
    expect((await readdir(dir)).filter((name) => name.includes(".corrupt-"))).toEqual([])
  }
})

test("status transitions are idempotent and cannot reopen closed goals", async () => {
  await createGoal("ses_1", "ship safely", null)
  const active = await getGoal("ses_1")
  await setGoalStatus("ses_1", "active")
  expect((await getGoal("ses_1"))?.history).toEqual(active?.history)

  await setGoalStatus("ses_1", "paused")
  const paused = await getGoal("ses_1")
  await setGoalStatus("ses_1", "paused")
  expect((await getGoal("ses_1"))?.history).toEqual(paused?.history)

  await completeGoal("ses_1", "verified")
  await expect(setGoalStatus("ses_1", "active")).rejects.toThrow("goal is closed")
  expect((await getGoal("ses_1"))?.status).toBe("complete")
})

test("pausing an already limited goal preserves its safety status", async () => {
  await createGoal("ses_limited", "stay bounded", 1)
  await accountUsage("ses_limited", 2)
  const limited = await getGoal("ses_limited")

  await setGoalStatus("ses_limited", "paused")

  expect(await getGoal("ses_limited")).toMatchObject({
    status: "budgetLimited",
    lastStatus: limited?.lastStatus,
    history: limited?.history,
  })
})

test("a mutation writes back to the state path it read", async () => {
  const firstPath = process.env.OPENCODE_GOAL_STATE_PATH!
  const secondPath = join(dir, "other-goals.json")
  await createGoal("ses_path", "original objective", null)

  const update = updateGoalObjective("ses_path", "updated objective")
  queueMicrotask(() => {
    process.env.OPENCODE_GOAL_STATE_PATH = secondPath
  })
  await update

  process.env.OPENCODE_GOAL_STATE_PATH = firstPath
  expect((await getGoal("ses_path"))?.objective).toBe("updated objective")
  process.env.OPENCODE_GOAL_STATE_PATH = secondPath
  expect(await getGoal("ses_path")).toBeNull()
  process.env.OPENCODE_GOAL_STATE_PATH = firstPath
})

test("lists public goals across sessions by most recent update", async () => {
  expect(await getAllGoals()).toEqual({ goals: [], total: 0, truncated: false })

  try {
    setSystemTime(new Date(100_000))
    await createGoal("ses_old", "older goal", null)
    await accountUsage("ses_old", 500, { cumulative: true, source: "private-test-source" })
    await reserveContinuation("ses_old", 10, 0)

    setSystemTime(new Date(200_000))
    await createGoal("ses_new", "newer goal", null)

    const listed = await getAllGoals()
    expect(listed).toMatchObject({ total: 2, truncated: false })
    expect(listed.goals.map((goal) => goal.sessionID)).toEqual(["ses_new", "ses_old"])
    expect(listed.goals.map((goal) => goal.objective)).toEqual(["newer goal", "older goal"])
    expect(listed.goals.find((goal) => goal.sessionID === "ses_old")?.timeUsedSeconds).toBe(0)
    for (const goal of listed.goals) {
      expect(goal).not.toHaveProperty("usageTrackers")
      expect(goal).not.toHaveProperty("pendingAttempt")
      expect(goal).not.toHaveProperty("history")
      expect(goal).not.toHaveProperty("checkpoints")
      expect(goal).not.toHaveProperty("lastAssistantText")
      expect(goal).not.toHaveProperty("completionEvidence")
      expect(goal).not.toHaveProperty("blocker")
    }
  } finally {
    setSystemTime()
  }
})

test("caps cross-session goal listings and reports truncation", async () => {
  for (let index = 50; index >= 0; index -= 1) {
    await createGoal(`ses_${String(index).padStart(2, "0")}`, `goal ${index}`, null)
  }

  const listed = await getAllGoals()

  expect(listed.total).toBe(51)
  expect(listed.truncated).toBe(true)
  expect(listed.goals).toHaveLength(50)
  expect(listed.goals[0]?.sessionID).toBe("ses_00")
  expect(listed.goals.at(-1)?.sessionID).toBe("ses_49")
})

test("marks a goal unmet with a blocker and allows a new goal afterward", async () => {
  await createGoal("ses_1", "ship the plugin", 100)
  const unmet = await markGoalUnmet("ses_1", "missing external credentials")

  expect(unmet.status).toBe("unmet")
  expect(unmet.blocker).toBe("missing external credentials")

  const next = await createGoal("ses_1", "ship follow-up", null)
  expect(next.status).toBe("active")
  expect(next.objective).toBe("ship follow-up")
})

test("requires evidence when closing goals", async () => {
  await createGoal("ses_1", "ship the plugin", 100)
  await expect(completeGoal("ses_1", "")).rejects.toThrow("completion evidence must not be empty")
  await expect(markGoalUnmet("ses_1", "")).rejects.toThrow("blocker must not be empty")
})

test("objective and evidence limits use submitted Unicode code points per call", async () => {
  expect(validateObjective("😀", 1)).toBe("😀")
  expect(validateObjective(" a ", 3)).toBe("a")
  expect(() => validateObjective(" a ", 1)).toThrow("at most 1 characters")
  expect(() => validateObjective(" ", 1)).toThrow("must not be empty")
  expect(() => validateObjective("   ", 3)).toThrow("must not be empty")
  expect(() => validateObjective("ab", 1)).toThrow("at most 1 characters")
  expect(() => validateEvidence("😀😀", "blocker", 1)).toThrow(
    "blocker must be at most 1 characters",
  )
  expect(validateEvidence(" ok ", "completion evidence", 4)).toBe("ok")

  const created = await createGoal("ses_limit", "😀", { maxObjectiveChars: 1 })
  expect(created.objective).toBe("😀")
  await expect(createGoal("ses_over", "ab", { maxObjectiveChars: 1 })).rejects.toThrow(
    "at most 1 characters",
  )
  await expect(
    createGoal("ses_default", "x".repeat(DEFAULT_MAX_OBJECTIVE_CHARS + 1)),
  ).rejects.toThrow("at most 100000 characters")

  await createGoal("ses_close", "keep")
  await expect(completeGoal("ses_close", "xy", 1)).rejects.toThrow("at most 1 characters")
  const completed = await completeGoal("ses_close", "😀", 1)
  expect(completed.completionEvidence).toBe("😀")
})

test("token usage marks goals budget limited", async () => {
  await createGoal("ses_1", "stay active", 10)
  const updated = await accountUsage("ses_1", 12)
  expect(updated?.status).toBe("budgetLimited")
  expect(updated?.remainingTokens).toBe(0)
  expect(updated?.tokensUsed).toBe(12)
  expect(updated?.stopReason).toContain("token budget reached")
})

test("cumulative usage establishes a private tracker and grows by its delta across state reloads", async () => {
  await createGoal("ses_1", "measure goal usage", null)
  await accountUsage("ses_1", 20)

  const first = await accountUsage("ses_1", 100, { cumulative: true, source: "messages" })
  expect(first?.tokensUsed).toBe(20)
  const persistedAfterFirst = JSON.parse(
    await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8"),
  ) as {
    goals: Record<string, { usageTrackers?: Record<string, unknown> }>
  }
  expect(persistedAfterFirst.goals.ses_1?.usageTrackers?.messages).toEqual({
    baseline: 100,
    lastObserved: 100,
    baseTokens: 20,
    pendingBaseline: null,
    pendingBaseTokens: null,
  })

  const grown = await accountUsage("ses_1", 105, { cumulative: true, source: "messages" })
  expect(grown?.tokensUsed).toBe(25)
  expect((await getGoal("ses_1"))?.tokensUsed).toBe(25)
})

test("cumulative usage rebases after a session counter reset without decreasing usage", async () => {
  await createGoal("ses_1", "survive compaction", null)
  await accountUsage("ses_1", 100, { cumulative: true, source: "messages" })
  await accountUsage("ses_1", 110, { cumulative: true, source: "messages" })
  expect((await getGoal("ses_1"))?.tokensUsed).toBe(10)

  const reset = await accountUsage("ses_1", 20, { cumulative: true, source: "messages" })
  expect(reset?.tokensUsed).toBe(10)
  const resumed = await accountUsage("ses_1", 25, { cumulative: true, source: "messages" })
  expect(resumed?.tokensUsed).toBe(15)
})

test("a transient cumulative dip does not inflate usage when the source recovers", async () => {
  await createGoal("ses_1", "ignore partial observations", null)
  await accountUsage("ses_1", 100, { cumulative: true, source: "messages" })
  await accountUsage("ses_1", 110, { cumulative: true, source: "messages" })

  expect(
    (await accountUsage("ses_1", 0, { cumulative: true, source: "messages" }))?.tokensUsed,
  ).toBe(10)
  expect(
    (await accountUsage("ses_1", 115, { cumulative: true, source: "messages" }))?.tokensUsed,
  ).toBe(15)
})

test("independent cumulative sources do not add overlapping usage", async () => {
  await createGoal("ses_1", "compare usage sources", null)
  await accountUsage("ses_1", 100, { cumulative: true, source: "messages" })
  await accountUsage("ses_1", 110, { cumulative: true, source: "messages" })
  await accountUsage("ses_1", 1_000, { cumulative: true, source: "events" })
  await accountUsage("ses_1", 1_005, { cumulative: true, source: "events" })
  expect((await getGoal("ses_1"))?.tokensUsed).toBe(15)

  await accountUsage("ses_1", 115, { cumulative: true, source: "messages" })
  expect((await getGoal("ses_1"))?.tokensUsed).toBe(15)
})

test("an explicit initial baseline counts the first cumulative observation delta", async () => {
  await createGoal("ses_1", "count first step", null)

  await accountUsage("ses_1", 1_030, {
    cumulative: true,
    source: "steps",
    initialBaseline: 1_000,
  })
  const observed = await accountUsage("ses_1", 1_040, {
    cumulative: true,
    source: "steps",
    initialBaseline: 1_030,
  })

  expect(observed?.tokensUsed).toBe(40)

  const afterRestart = await accountUsage("ses_1", 20, {
    cumulative: true,
    source: "steps",
    initialBaseline: 0,
  })
  expect(afterRestart?.tokensUsed).toBe(60)
})

test("an explicit baseline preserves usage for legacy goals without a tracker", async () => {
  await createGoal("ses_1", "continue after upgrade", null)
  await accountUsage("ses_1", 50)

  const observed = await accountUsage("ses_1", 2, {
    cumulative: true,
    source: "steps",
    initialBaseline: 0,
  })

  expect(observed?.tokensUsed).toBe(52)
})

test("old persisted goals without usage trackers default to an empty record", async () => {
  await createGoal("ses_1", "read old state", null)
  const persisted = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")) as {
    goals: Record<string, Record<string, unknown>>
  }
  delete persisted.goals.ses_1?.usageTrackers
  await writeFile(process.env.OPENCODE_GOAL_STATE_PATH!, JSON.stringify(persisted), "utf8")

  expect((await getGoal("ses_1"))?.tokensUsed).toBe(0)
  await accountUsage("ses_1", 40, { cumulative: true, source: "messages" })
  const rewritten = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")) as {
    goals: Record<string, { usageTrackers?: Record<string, unknown> }>
  }
  expect(rewritten.goals.ses_1?.usageTrackers?.messages).toEqual({
    baseline: 40,
    lastObserved: 40,
    baseTokens: 0,
    pendingBaseline: null,
    pendingBaseTokens: null,
  })
})

test("invalid persisted usage trackers are discarded", async () => {
  await createGoal("ses_1", "normalize accounting state", null)
  const persisted = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")) as {
    goals: Record<string, Record<string, unknown>>
  }
  persisted.goals.ses_1!.usageTrackers = {
    valid: { baseline: 10, lastObserved: 20, baseTokens: 5 },
    fractional: { baseline: 1.5, lastObserved: 20, baseTokens: 0 },
    backwards: { baseline: 20, lastObserved: 10, baseTokens: 0 },
    missing: { lastObserved: 20 },
    text: { baseline: "10", lastObserved: 20, baseTokens: 0 },
  }
  await writeFile(process.env.OPENCODE_GOAL_STATE_PATH!, JSON.stringify(persisted), "utf8")

  await accountUsage("ses_1")
  const rewritten = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")) as {
    goals: Record<string, { usageTrackers?: Record<string, unknown> }>
  }
  expect(rewritten.goals.ses_1?.usageTrackers).toEqual({
    valid: {
      baseline: 10,
      lastObserved: 20,
      baseTokens: 5,
      pendingBaseline: null,
      pendingBaseTokens: null,
    },
  })
})

test("usage trackers are not exposed by public or internal snapshots", async () => {
  const created = await createGoal("ses_1", "hide accounting internals", null)
  await accountUsage("ses_1", 100, { cumulative: true, source: "messages" })

  expect("usageTrackers" in created).toBe(false)
  expect("usageTrackers" in (await getGoal("ses_1"))!).toBe(false)
  expect("usageTrackers" in (await getGoalInternal("ses_1"))!).toBe(false)
})

test("direct usage accounting remains the default and does not establish a tracker", async () => {
  await createGoal("ses_1", "preserve direct accounting", null)
  await accountUsage("ses_1", 12)
  const unchanged = await accountUsage("ses_1", 8)
  expect(unchanged?.tokensUsed).toBe(12)

  const persisted = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")) as {
    goals: Record<string, { usageTrackers?: Record<string, unknown> }>
  }
  expect(persisted.goals.ses_1?.usageTrackers).toEqual({})
})

test("reserves continuation until max auto turns is reached", async () => {
  await createGoal("ses_1", "continue", null)
  expect(await reserveContinuation("ses_1", 1, 0)).not.toBeNull()
  const limited = await reserveContinuation("ses_1", 1, 0)
  expect(limited?.status).toBe("usageLimited")
  expect(limited?.budgetWrapupSent).toBe(true)
  expect(await reserveContinuation("ses_1", 1, 0)).toBeNull()
  expect((await getGoal("ses_1"))?.status).toBe("usageLimited")
})

test("resuming after the auto-turn limit starts a fresh continuation window", async () => {
  await createGoal("ses_1", "continue", { maxAutoTurns: 2 })
  expect((await reserveContinuation("ses_1", 25, 0))?.autoTurns).toBe(1)
  expect((await reserveContinuation("ses_1", 25, 0))?.autoTurns).toBe(2)
  expect((await reserveContinuation("ses_1", 25, 0))?.status).toBe("usageLimited")

  const resumed = await setGoalStatus("ses_1", "active", null, { resetAutoTurnLimit: true })
  expect(resumed).toMatchObject({
    status: "active",
    autoTurns: 0,
    budgetWrapupSent: false,
    stopReason: null,
  })

  expect((await reserveContinuation("ses_1", 25, 0))?.autoTurns).toBe(1)
  expect((await reserveContinuation("ses_1", 25, 0))?.autoTurns).toBe(2)
  expect((await reserveContinuation("ses_1", 25, 0))?.status).toBe("usageLimited")
})

test("a generic status update cannot renew the auto-turn limit", async () => {
  await createGoal("ses_1", "continue", { maxAutoTurns: 1 })
  await reserveContinuation("ses_1", 25, 0)
  await reserveContinuation("ses_1", 25, 0)

  const resumed = await setGoalStatus("ses_1", "active")
  expect(resumed.autoTurns).toBe(1)
  expect((await reserveContinuation("ses_1", 25, 0))?.status).toBe("usageLimited")
})

test("generic assistant observations record checkpoints but never pause the goal", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  const first = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Inspected the repo",
    outputTokens: 10,
  })
  expect(first?.lastCheckpoint?.summary).toBe("Inspected the repo")
  expect(first?.status).toBe("active")

  await recordAssistantProgress("ses_1", {
    messageID: "m2",
    text: "Checked PTY status",
    outputTokens: 15,
  })
  const observed = await recordAssistantProgress("ses_1", {
    messageID: "m3",
    text: "Checked PTY status",
    outputTokens: 15,
  })

  expect(observed?.status).toBe("active")
  expect(observed?.noProgressTurns).toBe(0)
  expect(observed?.history.some((entry) => entry.type === "checkpoint")).toBe(true)
})

test("no-progress pause only counts goal continuation turns", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  await recordAssistantProgress("ses_1", {
    messageID: "m0",
    text: "Working on it",
    outputTokens: 100,
  })

  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 3)
  const firstStall = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Working on it",
    outputTokens: 10,
    evaluateContinuation: true,
  })
  expect(firstStall?.noProgressTurns).toBe(1)
  expect(firstStall?.status).toBe("active")

  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 3)
  const paused = await recordAssistantProgress("ses_1", {
    messageID: "m2",
    text: "Working on it",
    outputTokens: 10,
    evaluateContinuation: true,
  })
  expect(paused?.status).toBe("paused")
  expect(paused?.stopReason).toBe("no progress")
  expect(paused?.blocker).toContain("continuation turn")
})

test("progressing continuation turns reset the no-progress counter", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  await recordAssistantProgress("ses_1", {
    messageID: "m0",
    text: "Working on it",
    outputTokens: 100,
  })

  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 3)
  await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Working on it",
    outputTokens: 10,
    evaluateContinuation: true,
  })

  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 3)
  const progressed = await recordAssistantProgress("ses_1", {
    messageID: "m2",
    text: "Implemented the parser and added passing tests",
    outputTokens: 400,
    evaluateContinuation: true,
  })

  expect(progressed?.noProgressTurns).toBe(0)
  expect(progressed?.status).toBe("active")
})

test("generic observations during a continuation turn do not consume the evaluation", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  await recordAssistantProgress("ses_1", {
    messageID: "m0",
    text: "Working on it",
    outputTokens: 100,
  })
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 3)

  const observed = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Working on it",
    outputTokens: 10,
  })
  expect(observed?.noProgressTurns).toBe(0)
  expect(observed?.awaitingContinuationProgress).toBe(true)

  const evaluated = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Working on it",
    outputTokens: 10,
    evaluateContinuation: true,
  })
  expect(evaluated?.noProgressTurns).toBe(1)
  expect(evaluated?.awaitingContinuationProgress).toBe(false)
})

test("failed continuation sends do not arm no-progress evaluation", async () => {
  await createGoal("ses_1", "continue", { noProgressTokenThreshold: 50, maxNoProgressTurns: 2 })
  await recordAssistantProgress("ses_1", {
    messageID: "m0",
    text: "Checking status",
    outputTokens: 100,
  })

  const reserved = await reserveContinuation("ses_1", 10, 0)
  expect(reserved?.awaitingContinuationProgress).toBe(false)

  const failed = await recordContinuationResult("ses_1", "failure", 3)
  expect(failed?.awaitingContinuationProgress).toBe(false)

  const observed = await recordAssistantProgress("ses_1", {
    messageID: "m_user_response",
    text: "Checking status",
    outputTokens: 10,
    evaluateContinuation: true,
  })
  expect(observed?.noProgressTurns).toBe(0)
  expect(observed?.status).toBe("active")
})

test("creates a paused planning goal and records the prompting agent", async () => {
  const created = await createGoal("ses_1", "implement the feature", {
    agent: "plan",
    initialStatus: "paused",
  })

  expect(created.status).toBe("paused")
  expect(created.lastPromptAgent).toBe("plan")
  expect(created.stopReason).toBe("plan mode")
  expect(created.blocker).toContain("Build mode")
  expect(created.history.some((entry) => entry.type === "paused")).toBe(true)

  const resumed = await setGoalStatus("ses_1", "active", "build")
  expect(resumed.status).toBe("active")
  expect(resumed.stopReason).toBeNull()
  expect(resumed.lastPromptAgent).toBe("build")
})

test("plan-mode pause via objective update keeps the plan-mode reason", async () => {
  await createGoal("ses_1", "implement the feature", { agent: "plan", initialStatus: "paused" })
  const updated = await updateGoalObjective("ses_1", "implement the feature safely", "paused", {
    agent: "plan",
    planModePause: true,
  })

  expect(updated.status).toBe("paused")
  expect(updated.stopReason).toBe("plan mode")
  expect(updated.blocker).toContain("Build mode")
  expect(updated.lastPromptAgent).toBe("plan")
})

test("records the last prompting agent and pauses active goals for plan mode", async () => {
  const created = await createGoal("ses_1", "keep going", { agent: "build" })
  expect(created.status).toBe("active")
  expect(created.lastPromptAgent).toBe("build")

  const recorded = await recordPromptAgent("ses_1", "plan")
  expect(recorded?.lastPromptAgent).toBe("plan")

  const paused = await pauseGoalForPlanMode("ses_1")
  expect(paused?.status).toBe("paused")
  expect(paused?.stopReason).toBe("plan mode")
  expect(paused?.blocker).toContain("Build mode")

  expect((await pauseGoalForPlanMode("ses_1"))?.status).toBe("paused")
})

test("decodes persisted goal state with optional closure fields omitted", async () => {
  await writeFile(
    process.env.OPENCODE_GOAL_STATE_PATH!,
    JSON.stringify({
      version: 1,
      goals: {
        ses_1: {
          sessionID: "ses_1",
          objective: "continue",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
          lastAccountedAt: 1,
          autoTurns: 0,
          lastContinuationAt: null,
        },
      },
    }),
  )

  const goal = await getGoal("ses_1")

  expect(goal?.completionEvidence).toBeNull()
  expect(goal?.blocker).toBeNull()
  expect(goal?.closedAt).toBeNull()
  expect(goal?.lastPromptAgent).toBeNull()
})

test("writes state with owner-only file permissions", async () => {
  await createGoal("ses_1", "ship the plugin", null)

  const mode = (await stat(process.env.OPENCODE_GOAL_STATE_PATH!)).mode & 0o777

  if (process.platform === "win32") {
    // Windows cannot express POSIX mode bits: Node reports writable files as
    // 0o666 (0o444 when read-only). Assert the file is not read-only there,
    // while POSIX keeps the exact 0600 assertion.
    expect(mode & 0o222).not.toBe(0)
  } else {
    expect(mode).toBe(0o600)
  }
})

test("does not overwrite corrupt persisted state", async () => {
  await writeFile(process.env.OPENCODE_GOAL_STATE_PATH!, "{not valid json", "utf8")

  expect(() => getGoalSync("ses_1")).toThrow()
  await expect(createGoal("ses_1", "ship the plugin", null)).rejects.toThrow()

  expect(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")).toBe("{not valid json")
  expect((await readdir(dir)).filter((name) => name.includes(".corrupt-"))).toEqual([])
})

test("treats empty and zero-filled state files as missing for async and sync reads", async () => {
  for (const content of ["", " \n\t", "\uFEFF", "\u0000\u0000"]) {
    await writeFile(process.env.OPENCODE_GOAL_STATE_PATH!, content, "utf8")

    expect(await getGoal("ses_1")).toBeNull()
    expect(getGoalSync("ses_1")).toBeNull()
    expect(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")).toBe(content)
  }
  expect(await readdir(dir)).toEqual(["goals.json"])
})

test("loads valid state prefixed by a UTF-8 BOM", async () => {
  const content = `\uFEFF${JSON.stringify({ version: 1, goals: {} })}`
  await writeFile(process.env.OPENCODE_GOAL_STATE_PATH!, content, "utf8")

  expect(await getGoal("ses_1")).toBeNull()
  expect(getGoalSync("ses_1")).toBeNull()
  expect(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")).toBe(content)
})

test("creates and persists a goal from an empty state file", async () => {
  await writeFile(process.env.OPENCODE_GOAL_STATE_PATH!, "", "utf8")

  const created = await createGoal("ses_1", "recover safely", null)

  expect(created.objective).toBe("recover safely")
  expect((await getGoal("ses_1"))?.objective).toBe("recover safely")
  expect(JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8"))).toMatchObject({
    version: 3,
    goals: { ses_1: { objective: "recover safely" } },
  })
  expect((await readdir(dir)).filter((name) => name.includes(".corrupt-"))).toEqual([])
})

test("quarantines a non-empty zero-filled state before replacing it", async () => {
  const file = process.env.OPENCODE_GOAL_STATE_PATH!
  const damaged = "\0".repeat(28_454)
  await writeFile(file, damaged, "utf8")

  const created = await createGoal("ses_1", "recover safely", null)

  expect(created.objective).toBe("recover safely")
  expect((await getGoal("ses_1"))?.objective).toBe("recover safely")
  const quarantines = (await readdir(dir)).filter((name) => name.startsWith("goals.json.corrupt-"))
  expect(quarantines).toHaveLength(1)
  expect(await readFile(join(dir, quarantines[0]!), "utf8")).toBe(damaged)
})

test("quarantines non-empty whitespace and BOM-only state before replacing it", async () => {
  for (const [index, damaged] of [" \n\t", "\uFEFF"].entries()) {
    const file = join(dir, `goals-${index}.json`)
    process.env.OPENCODE_GOAL_STATE_PATH = file
    await writeFile(file, damaged, "utf8")

    await createGoal(`ses_${index}`, "recover padded state", null)

    const quarantines = (await readdir(dir)).filter((name) =>
      name.startsWith(`goals-${index}.json.corrupt-`),
    )
    expect(quarantines).toHaveLength(1)
    expect(await readFile(join(dir, quarantines[0]!), "utf8")).toBe(damaged)
  }
})

test("warns once for each empty state file path", async () => {
  const first = process.env.OPENCODE_GOAL_STATE_PATH!
  const second = join(dir, "other-goals.json")
  await writeFile(first, "", "utf8")
  await writeFile(second, "", "utf8")
  const warnings: string[] = []
  const warn = spyOn(console, "warn").mockImplementation((message) => {
    warnings.push(String(message))
  })

  try {
    expect(await getGoal("ses_1")).toBeNull()
    expect(getGoalSync("ses_1")).toBeNull()
    process.env.OPENCODE_GOAL_STATE_PATH = second
    expect(await getGoal("ses_1")).toBeNull()
  } finally {
    warn.mockRestore()
  }

  expect(warnings.filter((message) => message.includes(first))).toHaveLength(1)
  expect(warnings.filter((message) => message.includes(second))).toHaveLength(1)
})

test("prompt delivery arms the pending window but never resets the failure count", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "failure", 5)
  await recordContinuationResult("ses_1", "failure", 5)

  const delivered = await recordContinuationResult("ses_1", "success", 5)
  expect(delivered?.continuationFailures).toBe(2)
  expect(delivered?.pendingAttempt).not.toBeNull()
  expect(delivered?.pendingAttempt?.started).toBe(false)
  expect(delivered?.awaitingContinuationProgress).toBe(true)

  const failed = await recordContinuationResult("ses_1", "failure", 5)
  expect(failed?.continuationFailures).toBe(3)
  expect(failed?.pendingAttempt).toBeNull()
  expect(failed?.awaitingContinuationProgress).toBe(false)
})

test("a session busy event marks the pending attempt as started", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt?.started).toBe(false)

  const started = await markPendingContinuationStarted("ses_1")
  expect(started?.pendingAttempt?.started).toBe(true)

  // Marking an already-started or absent attempt is idempotent.
  const again = await markPendingContinuationStarted("ses_1")
  expect(again?.pendingAttempt?.started).toBe(true)
  await recordContinuationResult("ses_1", "failure", 5)
  expect((await markPendingContinuationStarted("ses_1"))?.pendingAttempt).toBeNull()
})

test("markPendingContinuationStarted on a goal-less busy event does not create state", async () => {
  // No goal exists for this session, so a busy event must not create a state
  // file nor rewrite anything.
  expect(await markPendingContinuationStarted("ses_nogoal")).toBeNull()
  await expect(readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")).rejects.toThrow()
})

test("markPendingContinuationStarted does not rewrite state when nothing is pending", async () => {
  await createGoal("ses_1", "keep going", null)
  await markPendingContinuationStarted("ses_1")
  const mtime = (await stat(process.env.OPENCODE_GOAL_STATE_PATH!)).mtimeMs

  // A busy with no pending attempt (or an already-started one) must be a
  // read-only no-op and must not rewrite the state file.
  await markPendingContinuationStarted("ses_1")
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect((await stat(process.env.OPENCODE_GOAL_STATE_PATH!)).mtimeMs).toBe(mtime)
})

test("persists continuation failures and the pending window across restart", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  await recordContinuationResult("ses_1", "failure", 5)
  await recordContinuationResult("ses_1", "failure", 5)

  // getGoalInternal re-reads the persisted state file, simulating a restart.
  const reloaded = await getGoalInternal("ses_1")
  expect(reloaded?.continuationFailures).toBe(2)
  expect(reloaded?.pendingAttempt).toBeNull()

  await recordContinuationResult("ses_1", "success", 5)
  const reloadedPending = await getGoalInternal("ses_1")
  expect(reloadedPending?.continuationFailures).toBe(2)
  expect(reloadedPending?.pendingAttempt?.reservedAt).toBeGreaterThanOrEqual(Date.now() - 5_000)
  expect(reloadedPending?.pendingAttempt?.started).toBe(false)

  await markPendingContinuationStarted("ses_1")
  const reloadedStarted = await getGoalInternal("ses_1")
  expect(reloadedStarted?.pendingAttempt?.started).toBe(true)
  expect(reloadedStarted?.pendingAttempt).not.toBeNull()
})

test("decodes persisted state that lacks the retry fields", async () => {
  await writeFile(
    process.env.OPENCODE_GOAL_STATE_PATH!,
    JSON.stringify({
      version: 1,
      goals: {
        ses_1: {
          sessionID: "ses_1",
          objective: "continue",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
          lastAccountedAt: 1,
          autoTurns: 0,
          lastContinuationAt: null,
        },
      },
    }),
  )

  const goal = await getGoalInternal("ses_1")

  expect(goal?.continuationFailures).toBe(0)
  expect(goal?.pendingAttempt).toBeNull()
})

test("substantive assistant text resets the failure count and pending window", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "failure", 5)
  await recordContinuationResult("ses_1", "failure", 5)
  await recordContinuationResult("ses_1", "success", 5)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).not.toBeNull()

  const progressed = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Implemented the parser and added passing tests",
    outputTokens: 400,
    completedAt: Date.now(),
  })

  expect(progressed?.continuationFailures).toBe(0)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).toBeNull()
  expect(progressed?.status).toBe("active")
})

test("successful tool output clears transport failures but preserves no-progress evaluation", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5) // delivers: arms the no-progress window
  await recordContinuationResult("ses_1", "failure", 5) // not delivered -> resolves window + counts
  await recordContinuationResult("ses_1", "success", 5) // redelivers: arms the no-progress window again
  expect((await getGoal("ses_1"))?.continuationFailures).toBe(1)
  expect((await getGoal("ses_1"))?.awaitingContinuationProgress).toBe(true)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).not.toBeNull()

  const progressed = await recordToolProgress("ses_1", "tests passed")

  // Tool progress clears the transport failure counter and pending window...
  expect(progressed?.continuationFailures).toBe(0)
  expect(progressed?.pendingAttempt).toBeNull()
  // ...but MUST NOT reset the armed no-progress evaluation: the tool ran inside
  // a continuation turn, and the assistant's still-pending final text drives
  // the low-output accounting.
  expect(progressed?.awaitingContinuationProgress).toBe(true)
  expect(progressed?.noProgressTurns).toBe(0)
})

test("recordToolProgress only clears the pending attempt captured for the same tool call", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  const attemptA = (await getGoalInternal("ses_1"))?.pendingAttempt?.id
  expect(attemptA).toMatch(/^att_/)

  // A newer attempt supersedes the one the (still-running) tool call started
  // under; the delayed output must not clear it.
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  const attemptB = (await getGoalInternal("ses_1"))?.pendingAttempt?.id
  expect(attemptB).not.toBe(attemptA)

  const delayed = await recordToolProgress("ses_1", "tests passed", attemptA)
  expect(delayed?.pendingAttempt?.id).toBe(attemptB)

  // Output from a call that started while attempt B was pending clears it.
  const cleared = await recordToolProgress("ses_1", "tests passed", attemptB)
  expect(cleared?.pendingAttempt).toBeNull()

  // A null capture (the tool call started with no pending attempt) cannot clear
  // an attempt that appeared while the call was still running.
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  const protectedNow = await recordToolProgress("ses_1", "tests passed", null)
  expect(protectedNow?.pendingAttempt).not.toBeNull()

  // Omitting the expected id keeps the legacy unconditional reset.
  const legacy = await recordToolProgress("ses_1", "tests passed")
  expect(legacy?.pendingAttempt).toBeNull()
})

test("re-reading the previous assistant message does not resolve a pending continuation", async () => {
  await createGoal("ses_1", "keep going", null)
  await recordAssistantProgress("ses_1", { messageID: "m1", text: "Initial progress" })
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)

  const repeated = await recordAssistantProgress("ses_1", {
    messageID: "m1",
    text: "Initial progress",
    evaluateContinuation: true,
    completedAt: Date.now(),
  })

  expect((await getGoalInternal("ses_1"))?.pendingAttempt).not.toBeNull()
  expect(repeated?.awaitingContinuationProgress).toBe(true)
})

test("lastContinuationAt remains a public seconds timestamp", async () => {
  await createGoal("ses_1", "keep going", null)
  const reserved = await reserveContinuation("ses_1", 10, 0)

  expect(reserved?.lastContinuationAt).toBe(Math.floor(Date.now() / 1000))
  expect(reserved?.lastContinuationAt).toBeLessThan(1_000_000_000_000)
})

test("resuming a paused goal clears the failure count and pending window", async () => {
  await createGoal("ses_1", "keep going", null)
  await recordContinuationResult("ses_1", "failure", 1)
  expect((await getGoal("ses_1"))?.status).toBe("paused")

  const resumed = await setGoalStatus("ses_1", "active")

  expect(resumed?.continuationFailures).toBe(0)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).toBeNull()
})

test("internal pending attempt fields are not exposed on the public snapshot", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)

  const publicGoal = await getGoal("ses_1")
  expect(publicGoal).not.toHaveProperty("pendingAttempt")
  expect(publicGoal).not.toHaveProperty("pendingContinuationStart")
  expect(publicGoal).not.toHaveProperty("pendingContinuationStarted")
  expect(JSON.stringify(publicGoal)).not.toContain("pendingAttempt")

  // The dedicated internal API exposes the attempt lifecycle.
  const internalGoal = await getGoalInternal("ses_1")
  expect(internalGoal?.pendingAttempt).not.toBeNull()
  expect(internalGoal?.pendingAttempt?.id).toMatch(/^att_/)
})

test("rolling back a reserved-but-not-delivered attempt restores autoTurns and lastContinuationAt", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  expect((await getGoal("ses_1"))?.autoTurns).toBe(1)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt?.delivered).toBe(false)

  const rolledBack = await rollbackContinuationAttempt("ses_1")
  expect(rolledBack).toBe(true)
  expect((await getGoal("ses_1"))?.autoTurns).toBe(0)
  expect((await getGoal("ses_1"))?.lastContinuationAt).toBeNull()
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).toBeNull()

  // Rolling back again (nothing left) is a no-op.
  expect(await rollbackContinuationAttempt("ses_1")).toBe(false)
})

test("rolling back a delivered attempt is a no-op and does not un-consume the turn", async () => {
  await createGoal("ses_1", "keep going", null)
  await reserveContinuation("ses_1", 10, 0)
  await recordContinuationResult("ses_1", "success", 5)
  expect((await getGoalInternal("ses_1"))?.pendingAttempt?.delivered).toBe(true)

  expect(await rollbackContinuationAttempt("ses_1")).toBe(false)
  expect((await getGoal("ses_1"))?.autoTurns).toBe(1)
})

test("a replaced goal rejects stale continuation delivery and rollback", async () => {
  await createGoal("ses_1", "old goal", null)
  const reserved = await reserveContinuation("ses_1", 10, 0)
  const identity = { goalID: reserved!.id, attemptID: reserved!.pendingAttempt!.id }

  await replaceGoal("ses_1", "new goal", null)
  expect(
    await recordContinuationResult("ses_1", "success", 3, {
      expectedGoalID: identity.goalID,
      expectedAttemptID: identity.attemptID,
    }),
  ).toBeNull()
  expect(await rollbackContinuationAttempt("ses_1", identity)).toBe(false)
  expect(await getGoal("ses_1")).toMatchObject({ objective: "new goal", autoTurns: 0 })
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).toBeNull()
})

test("delayed prior-turn assistant output cannot clear a newer pending attempt", async () => {
  await createGoal("ses_1", "keep going", null)
  await recordAssistantProgress("ses_1", { messageID: "m_old", text: "Old work" })
  const reserved = await reserveContinuation("ses_1", 10, 0)
  const reservedAt = reserved?.pendingAttempt?.reservedAt ?? 0
  await recordContinuationResult("ses_1", "success", 5)

  // A delayed prior-turn message arrives late, completing BEFORE the attempt
  // was reserved. Its messageID is new, so the repeated-message guard alone
  // cannot reject it; the completedAt correlation must keep the pending
  // attempt intact.
  await recordAssistantProgress("ses_1", {
    messageID: "m_delayed",
    text: "Delayed old output that arrived late",
    completedAt: reservedAt - 10_000,
  })
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).not.toBeNull()
  expect((await getGoal("ses_1"))?.continuationFailures).toBe(0)

  // A newer message completing after the attempt resolves it.
  await recordAssistantProgress("ses_1", {
    messageID: "m_new",
    text: "Current progress after the continuation",
    completedAt: reservedAt + 10_000,
  })
  expect((await getGoalInternal("ses_1"))?.pendingAttempt).toBeNull()
})

test("setGoalWaiting freezes the clock across snapshot, usage, and resume", async () => {
  try {
    setSystemTime(new Date(100_000))
    const created = await createGoal("ses_wait", "gate on approval", null)
    expect(created.waitingForHuman).toBe(false)
    expect(created.elapsedPaused).toBe(false)

    setSystemTime(new Date(130_000))
    const waiting = await setGoalWaiting("ses_wait", "deploy the release", true, created.id)
    expect(waiting).toMatchObject({
      waitingForHuman: true,
      elapsedPaused: true,
      status: "active",
      lastStatus: "Awaiting approval: deploy the release",
      timeUsedSeconds: 30,
    })

    setSystemTime(new Date(190_000))
    expect((await getGoal("ses_wait"))?.timeUsedSeconds).toBe(30)
    await accountUsage("ses_wait", 25)
    expect((await getGoal("ses_wait"))?.timeUsedSeconds).toBe(30)

    const resumed = await setGoalWaiting("ses_wait", null, true, created.id)
    expect(resumed).toMatchObject({
      waitingForHuman: false,
      elapsedPaused: false,
      status: "active",
      lastStatus: "Goal resumed.",
      timeUsedSeconds: 30,
    })
    setSystemTime(new Date(200_000))
    expect((await getGoal("ses_wait"))?.timeUsedSeconds).toBe(40)
  } finally {
    setSystemTime()
  }
})

test("setGoalWaiting opt-out keeps the clock running while blocking continuation", async () => {
  try {
    setSystemTime(new Date(100_000))
    await createGoal("ses_opt", "count while waiting", null)
    setSystemTime(new Date(110_000))
    await setGoalWaiting("ses_opt", "review the diff", false)
    setSystemTime(new Date(140_000))
    expect(await getGoal("ses_opt")).toMatchObject({
      waitingForHuman: true,
      elapsedPaused: false,
      timeUsedSeconds: 40,
    })
    expect(await reserveContinuation("ses_opt", 10, 0)).toBeNull()
  } finally {
    setSystemTime()
  }
})

test("waiting blocks limit wrap-up reservation and clear keeps the limit status", async () => {
  await createGoal("ses_wrap", "wrap while waiting", 10)
  await setGoalWaiting("ses_wrap", "pick one", true)
  await accountUsage("ses_wrap", 25)
  expect((await getGoal("ses_wrap"))?.status).toBe("budgetLimited")
  expect(await reserveContinuation("ses_wrap", 10, 0)).toBeNull()

  const cleared = await setGoalWaiting("ses_wrap", null, true)
  expect(cleared).toMatchObject({
    waitingForHuman: false,
    elapsedPaused: false,
    status: "budgetLimited",
  })
  expect(cleared?.lastStatus).toContain("wrap-up required")
})

test("continuation evaluation is skipped while waiting but accounting is kept", async () => {
  await createGoal("ses_prog", "progress while waiting", null)
  await recordAssistantProgress("ses_prog", {
    messageID: "m0",
    text: "baseline text",
    outputTokens: 5,
  })
  await reserveContinuation("ses_prog", 10, 0)
  await recordContinuationResult("ses_prog", "success", 3)
  await setGoalWaiting("ses_prog", "approve", true)

  const waiting = await recordAssistantProgress("ses_prog", {
    messageID: "m1",
    text: "still working",
    outputTokens: 5,
    evaluateContinuation: true,
  })
  expect(waiting).toMatchObject({
    noProgressTurns: 0,
    awaitingContinuationProgress: true,
    lastAssistantText: "still working",
  })

  await setGoalWaiting("ses_prog", null, true)
  const resumed = await recordAssistantProgress("ses_prog", {
    messageID: "m2",
    text: "new direction taken",
    outputTokens: 5,
    evaluateContinuation: true,
  })
  expect(resumed).toMatchObject({ awaitingContinuationProgress: false, noProgressTurns: 0 })
})

test("delivery success, failure, and rollback preserve the waiting presentation", async () => {
  await createGoal("ses_succ", "keep presentation on success", null)
  const reserved = await reserveContinuation("ses_succ", 10, 0)
  await setGoalWaiting("ses_succ", "deploy?", true)
  const delivered = await recordContinuationResult("ses_succ", "success", 3, {
    expectedAttemptID: reserved?.pendingAttempt?.id,
  })
  expect(delivered?.lastStatus).toBe("Awaiting approval: deploy?")

  await createGoal("ses_roll", "keep presentation on rollback", null)
  const pending = await reserveContinuation("ses_roll", 10, 0)
  await setGoalWaiting("ses_roll", "ok?", true)
  expect(
    await rollbackContinuationAttempt("ses_roll", {
      attemptID: pending?.pendingAttempt?.id,
    }),
  ).toBe(true)
  expect((await getGoal("ses_roll"))?.lastStatus).toBe("Awaiting approval: ok?")
  await reserveContinuation("ses_roll", 10, 0)
  await recordContinuationResult("ses_roll", "failure", 3)
  expect((await getGoal("ses_roll"))?.lastStatus).toBe("Awaiting approval: ok?")
})

test("setGoalWaiting identity guard, no-goal, repeated updates, and close reset", async () => {
  expect(await setGoalWaiting("ses_none", "x", true)).toBeNull()

  await createGoal("ses_guard", "guard identity", null)
  const goal = await getGoal("ses_guard")
  expect(await setGoalWaiting("ses_guard", "x", true, "wrong-id")).toBeNull()
  expect((await getGoal("ses_guard"))?.waitingForHuman).toBe(false)

  const first = await setGoalWaiting("ses_guard", "deploy", true, goal?.id)
  const second = await setGoalWaiting("ses_guard", "deploy", true, goal?.id)
  expect(second?.history).toEqual(first?.history)
  expect((await setGoalWaiting("ses_guard", "ship", true))?.lastStatus).toBe(
    "Awaiting approval: ship",
  )
  expect(await setGoalWaiting("ses_guard", "  ", true)).toMatchObject({
    lastStatus: "Waiting for user input.",
    waitingForHuman: true,
  })

  expect(await completeGoal("ses_guard", "done")).toMatchObject({
    waitingForHuman: false,
    elapsedPaused: false,
    lastStatus: "Goal completed.",
  })
})

test("setGoalWaiting ignores paused goals", async () => {
  await createGoal("ses_pause", "pause gate", null)
  await setGoalStatus("ses_pause", "paused")
  expect(await setGoalWaiting("ses_pause", "x", true)).toMatchObject({
    waitingForHuman: false,
    status: "paused",
    lastStatus: "Goal paused.",
  })
})

test.each(["Awaiting approval: deploy the release", "Waiting for user input."])(
  "setGoalWaiting preserves canonical status %s",
  async (status) => {
    await createGoal("ses_canonical", "canonical gate", null)
    expect((await setGoalWaiting("ses_canonical", status, true))?.lastStatus).toBe(status)
  },
)

test("waiting failure at threshold one preserves accepted attempt and history", async () => {
  const goal = await createGoal("ses_failure_wait", "accepted human gate", null)
  const reserved = await reserveContinuation("ses_failure_wait", 10, 0)
  await recordContinuationResult("ses_failure_wait", "success", 1, {
    expectedAttemptID: reserved?.pendingAttempt?.id,
    started: true,
  })
  await setGoalWaiting("ses_failure_wait", "approve deployment", true)
  const before = await getGoalInternal("ses_failure_wait")
  const failed = await recordContinuationResult("ses_failure_wait", "failure", 1, {
    expectedGoalID: goal.id,
    expectedAttemptID: reserved?.pendingAttempt?.id,
    requirePending: true,
  })
  expect(failed).toMatchObject({
    status: "active",
    continuationFailures: 0,
    awaitingContinuationProgress: true,
    waitingForHuman: true,
    elapsedPaused: true,
    lastStatus: "Awaiting approval: approve deployment",
  })
  expect(failed?.pendingAttempt).toEqual(before?.pendingAttempt)
  expect(failed?.history).toEqual(before?.history)
  expect(failed?.history.some((entry) => entry.type === "error" || entry.type === "paused")).toBe(
    false,
  )
})

test.each([true, false])(
  "resume and objective edit preserve human wait (freeze=%s)",
  async (freeze) => {
    try {
      setSystemTime(new Date(100_000))
      await createGoal("ses_resume_wait", "keep waiting", null)
      await reserveContinuation("ses_resume_wait", 10, 0)
      await recordContinuationResult("ses_resume_wait", "success", 1)
      setSystemTime(new Date(110_000))
      await setGoalWaiting("ses_resume_wait", "approve deployment", freeze)
      const attempt = (await getGoalInternal("ses_resume_wait"))?.pendingAttempt
      await setGoalStatus("ses_resume_wait", "paused")
      setSystemTime(new Date(140_000))
      const resumed = await setGoalStatus("ses_resume_wait", "active")
      expect(resumed).toMatchObject({
        status: "active",
        waitingForHuman: true,
        elapsedPaused: freeze,
        timeUsedSeconds: 10,
        lastStatus: "Awaiting approval: approve deployment",
      })
      expect((await getGoalInternal("ses_resume_wait"))?.pendingAttempt).toEqual(attempt)
      setSystemTime(new Date(150_000))
      const edited = await updateGoalObjective(
        "ses_resume_wait",
        "edited but still waiting",
        "active",
      )
      expect(edited).toMatchObject({
        status: "active",
        waitingForHuman: true,
        elapsedPaused: freeze,
        timeUsedSeconds: freeze ? 10 : 20,
        lastStatus: "Awaiting approval: approve deployment",
      })
      expect((await getGoalInternal("ses_resume_wait"))?.pendingAttempt).toEqual(attempt)
      setSystemTime(new Date(160_000))
      expect((await getGoal("ses_resume_wait"))?.timeUsedSeconds).toBe(freeze ? 10 : 30)
      expect(await reserveContinuation("ses_resume_wait", 10, 0)).toBeNull()
      await setGoalWaiting("ses_resume_wait", null, freeze)
      setSystemTime(new Date(170_000))
      expect((await getGoal("ses_resume_wait"))?.timeUsedSeconds).toBe(freeze ? 20 : 40)
    } finally {
      setSystemTime()
    }
  },
)

test("clearing a human wait preserves newer active and paused status", async () => {
  await createGoal("ses_new_status", "new status survives", null)
  await setGoalWaiting("ses_new_status", "approve", true)
  const file = process.env.OPENCODE_GOAL_STATE_PATH!
  const raw = JSON.parse(await readFile(file, "utf8")) as {
    goals: Record<string, Record<string, unknown>>
  }
  raw.goals.ses_new_status!.lastStatus = "Newer plugin status."
  await writeFile(file, JSON.stringify(raw), "utf8")
  const before = await getGoal("ses_new_status")
  const cleared = await setGoalWaiting("ses_new_status", null, true)
  expect(cleared?.lastStatus).toBe("Newer plugin status.")
  expect(cleared?.history).toEqual(before?.history)

  await setGoalWaiting("ses_new_status", "approve", true)
  await setGoalStatus("ses_new_status", "paused")
  expect(await setGoalWaiting("ses_new_status", null, true)).toMatchObject({
    status: "paused",
    lastStatus: "Goal paused.",
    waitingForHuman: false,
    elapsedPaused: false,
  })
})

test("stale identity clear cannot release replacement goal's human gate", async () => {
  const old = await createGoal("ses_stale_clear", "old goal", null)
  await setGoalWaiting("ses_stale_clear", "old approval", true, old.id)
  const replacement = await replaceGoal("ses_stale_clear", "replacement goal", null)
  await setGoalWaiting("ses_stale_clear", "new approval", true, replacement.goal.id)
  const before = await getGoal("ses_stale_clear")
  expect(await setGoalWaiting("ses_stale_clear", null, true, old.id)).toBeNull()
  expect(await getGoal("ses_stale_clear")).toMatchObject({
    id: replacement.goal.id,
    waitingForHuman: true,
    elapsedPaused: true,
    lastStatus: "Awaiting approval: new approval",
    history: before?.history,
  })
})

test("legacy goals without waiting fields default to not waiting", async () => {
  await createGoal("ses_legacy", "legacy goal", null)
  const file = process.env.OPENCODE_GOAL_STATE_PATH!
  const raw = JSON.parse(await readFile(file, "utf8")) as {
    goals: Record<string, Record<string, unknown>>
  }
  delete raw.goals.ses_legacy!.waitingForHuman
  delete raw.goals.ses_legacy!.elapsedPaused
  await writeFile(file, JSON.stringify(raw), "utf8")
  expect(await getGoal("ses_legacy")).toMatchObject({
    waitingForHuman: false,
    elapsedPaused: false,
  })
})
