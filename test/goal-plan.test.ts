import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type GoalPlan,
  type GoalPlanInput,
  GoalPlanInputSchema,
  GoalPlanSchema,
  goalPlanEntries,
} from "../src/goal-plan"
import {
  cancelGoal,
  clearGoal,
  completeGoal,
  createGoal,
  getGoal,
  getGoalHistory,
  replaceGoal,
  updateGoalObjective,
  updateGoalPlan,
} from "../src/state"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "goal-plan-test-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
})
afterEach(async () => {
  delete process.env.OPENCODE_GOAL_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

function initialPlan(): GoalPlanInput {
  return {
    summary: "Make the project production-ready",
    completionCriteria: ["Parser and execution tests pass"],
    decisions: ["Retain the original production-readiness scope"],
    phases: [
      {
        id: "parser",
        objective: "Parser correctness",
        status: "in_progress",
        tasks: [{ id: "compound", description: "Fix compound queries", status: "in_progress" }],
      },
      {
        id: "execution",
        objective: "Query execution",
        status: "pending",
        tasks: [{ id: "planner", description: "Implement the planner", status: "pending" }],
      },
    ],
  }
}

test("verified phases persist across reads and advance to remaining work without closing the overall goal", async () => {
  const goal = await createGoal("session", "Make the project production-ready")
  await updateGoalPlan("session", {
    goalID: goal.id,
    expectedRevision: 0,
    plan: initialPlan(),
    reason: "Plan the overall scope",
  })
  const next = initialPlan()
  next.phases[0]!.tasks[0]!.status = "completed"
  next.phases[0]!.tasks[0]!.evidence = "Compound-query regressions pass"
  next.phases[0]!.status = "completed"
  next.phases[0]!.verification = "Parser suite passes"
  const updated = await updateGoalPlan("session", {
    goalID: goal.id,
    expectedRevision: 1,
    plan: next,
    reason: "Parser verified; reassess query execution",
  })
  expect(updated).toMatchObject({
    objective: goal.objective,
    status: "active",
    planRevision: 2,
    planProgress: {
      currentPhaseID: "execution",
      currentTaskID: null,
      nextTaskID: "planner",
      completedTaskIDs: ["compound"],
    },
  })
  const persisted = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8"))
  expect(persisted.version).toBe(3)
  expect((await getGoal("session"))?.plan).toEqual(persisted.goals.session.plan)
  expect(goalPlanEntries(updated.plan!)).toEqual([
    {
      content: "Parser correctness: Fix compound queries",
      status: "completed",
      priority: "medium",
    },
    { content: "Query execution: Implement the planner", status: "pending", priority: "medium" },
  ])
  await expect(completeGoal("session", "A parser task passed")).rejects.toThrow("planned phases")
  await cancelGoal("session")
  await clearGoal("session")
  expect((await getGoalHistory("session")).previous[0]?.plan?.revision).toBe(2)
})

test("stale, narrowed, deleted or reopened completed work cannot overwrite a verified plan", async () => {
  const goal = await createGoal("session", "Make the project production-ready")
  const plan = initialPlan()
  plan.phases[0]!.tasks[0]!.status = "completed"
  plan.phases[0]!.tasks[0]!.evidence = "Regression passes"
  plan.phases[0]!.status = "completed"
  plan.phases[0]!.verification = "Parser suite passes"
  const update = (plan: GoalPlanInput, revision = 1, revisitEvidence?: string) =>
    updateGoalPlan("session", {
      goalID: goal.id,
      expectedRevision: revision,
      plan,
      reason: "Reassess remaining scope",
      revisitEvidence,
    })
  await update(plan, 0)
  await expect(update(initialPlan(), 0)).rejects.toThrow("revision changed")
  await expect(update(initialPlan())).rejects.toThrow("reopening")
  await expect(update({ ...plan, completionCriteria: ["Only parser tests pass"] })).rejects.toThrow(
    "completion criteria",
  )
  await expect(update({ ...plan, phases: [plan.phases[1]!] })).rejects.toThrow("verified phase")
  expect(
    (
      await update(
        initialPlan(),
        1,
        "A newly failing compound-query regression requires revisiting the parser",
      )
    ).planRevision,
  ).toBe(2)
})

test("task and phase completion require evidence and a phase cannot leap over unfinished work", () => {
  const plan = initialPlan()
  plan.phases[0]!.tasks[0]!.status = "completed"
  expect(GoalPlanInputSchema.safeParse(plan).success).toBe(false)
  plan.phases[0]!.tasks[0]!.evidence = "Regression passes"
  plan.phases[0]!.status = "completed"
  expect(GoalPlanInputSchema.safeParse(plan).success).toBe(false)
  plan.phases[0]!.verification = "Parser verified"
  expect(GoalPlanInputSchema.safeParse(plan).success).toBe(true)
  const jumped = initialPlan()
  jumped.phases[0]!.status = "pending"
  jumped.phases[0]!.tasks[0]!.status = "pending"
  jumped.phases[1]!.status = "in_progress"
  expect(GoalPlanInputSchema.safeParse(jumped).success).toBe(false)
})

test("scope edits and replacements reject an old planner's delayed update", async () => {
  const goal = await createGoal("session", "Original scope")
  const input = {
    goalID: goal.id,
    expectedRevision: 0,
    plan: initialPlan(),
    reason: "Original plan",
  }
  await updateGoalObjective("session", "Explicitly edited scope")
  await expect(updateGoalPlan("session", input)).rejects.toThrow("revision changed")
  await replaceGoal("session", "New independent scope")
  await expect(updateGoalPlan("session", input)).rejects.toThrow("replaced")
})

test("version 2 state upgrades without changing existing goal identity or accounting", async () => {
  const goal = await createGoal("session", "Legacy goal", 100)
  const file = process.env.OPENCODE_GOAL_STATE_PATH!
  const state = JSON.parse(await readFile(file, "utf8"))
  state.version = 2
  delete state.goals.session.plan
  delete state.goals.session.planRevision
  await writeFile(file, JSON.stringify(state))
  expect(await getGoal("session")).toMatchObject({
    id: goal.id,
    tokenBudget: 100,
    plan: null,
    planRevision: 0,
  })
  await updateGoalPlan("session", {
    goalID: goal.id,
    expectedRevision: 0,
    plan: initialPlan(),
    reason: "Add a durable plan",
  })
  expect(JSON.parse(await readFile(file, "utf8")).version).toBe(3)
})

test("pending phase and task scope cannot disappear without recorded revisit evidence", async () => {
  const goal = await createGoal("session", "Keep the full engine scope")
  await updateGoalPlan("session", {
    goalID: goal.id,
    expectedRevision: 0,
    plan: initialPlan(),
    reason: "Full scope",
  })
  const narrowed = initialPlan()
  narrowed.phases.pop()
  await expect(
    updateGoalPlan("session", {
      goalID: goal.id,
      expectedRevision: 1,
      plan: narrowed,
      reason: "Only parser remains",
    }),
  ).rejects.toThrow("scope")
  const changed = initialPlan()
  changed.phases[1]!.objective = "Only parsing"
  await expect(
    updateGoalPlan("session", {
      goalID: goal.id,
      expectedRevision: 1,
      plan: changed,
      reason: "Narrow execution",
    }),
  ).rejects.toThrow("scope")
  const revised = await updateGoalPlan("session", {
    goalID: goal.id,
    expectedRevision: 1,
    plan: narrowed,
    reason: "Reassess the execution phase",
    revisitEvidence:
      "The execution engine already exists; acceptance runs prove the overall execution criterion is satisfied",
  })
  expect(revised.plan?.changes.at(-1)?.revisitEvidence).toContain("acceptance runs")
})

test("a planned objective can only clear its plan with an explicit grant for that goal and exact objective", async () => {
  const goal = await createGoal("session", "Keep the full engine scope")
  await updateGoalPlan("session", {
    goalID: goal.id,
    expectedRevision: 0,
    plan: initialPlan(),
    reason: "Full scope",
  })
  await expect(updateGoalObjective("session", "Only parser")).rejects.toThrow("/goal edit")
  await expect(
    updateGoalObjective("session", "Only parser", "active", {
      requestedPlanEdit: { goalID: "another-goal", objective: "Only parser" },
    }),
  ).rejects.toThrow("/goal edit")
  await expect(
    updateGoalObjective("session", "Only parser", "active", {
      requestedPlanEdit: { goalID: goal.id, objective: "Wrong objective" },
    }),
  ).rejects.toThrow("/goal edit")
  const edited = await updateGoalObjective("session", "Only parser", "active", {
    requestedPlanEdit: { goalID: goal.id, objective: "Only parser" },
  })
  expect(edited).toMatchObject({ objective: "Only parser", plan: null, planRevision: 2 })
})

function bigPlanInput(maxLength: number): GoalPlanInput {
  const phases: GoalPlanInput["phases"] = [
    {
      id: "phase-0",
      objective: "x".repeat(2000),
      status: "in_progress",
      tasks: [{ id: "task-0", description: "y".repeat(2000), status: "in_progress" }],
    },
  ]
  for (let i = 1; i < 64; i++) {
    phases.push({
      id: `phase-${i}`,
      objective: "x".repeat(2000),
      status: "pending",
      tasks: [{ id: `task-${i}`, description: "y".repeat(2000), status: "pending" }],
    })
  }
  const plan: GoalPlanInput = {
    summary: "Plan near the persistent size limit",
    completionCriteria: ["Size-limit regressions pass"],
    decisions: [],
    phases: [],
  }
  for (const phase of phases) {
    const candidate = [...plan.phases, phase]
    if (JSON.stringify({ ...plan, phases: candidate }).length > maxLength) break
    plan.phases = candidate
  }
  return plan
}

test("near-limit plan keeps revising and persisting while metadata grows past the raw size limit", async () => {
  const plan = bigPlanInput(124_000)
  expect(JSON.stringify(plan).length).toBeGreaterThan(110_000)
  expect(JSON.stringify(plan).length).toBeLessThanOrEqual(124_000)
  const goal = await createGoal("session", "Near the size limit")
  const reason = "r".repeat(2000)
  const revisitEvidence = "e".repeat(2000)
  for (let revision = 0; revision < 3; revision++) {
    await updateGoalPlan("session", {
      goalID: goal.id,
      expectedRevision: revision,
      plan,
      reason,
      revisitEvidence,
    })
  }
  const read = await getGoal("session")
  expect(read?.planRevision).toBe(3)
  expect(read?.plan?.changes).toHaveLength(3)
  expect(read?.plan?.changes.at(-1)?.revision).toBe(3)
  const persisted = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")) as {
    goals: Record<string, { plan: GoalPlan | null }>
  }
  expect(read?.plan).toEqual(persisted.goals.session?.plan)
  expect(JSON.stringify(persisted.goals.session?.plan).length).toBeGreaterThan(128_000)
})

test("max-length revisions keep succeeding and the change log stays capped at 32", async () => {
  const goal = await createGoal("session", "Keep revising")
  for (let revision = 0; revision < 40; revision++) {
    await updateGoalPlan("session", {
      goalID: goal.id,
      expectedRevision: revision,
      plan: initialPlan(),
      reason: `Revision ${revision}: `.padEnd(2000, "r"),
      revisitEvidence: `Evidence ${revision}: `.padEnd(2000, "e"),
    })
  }
  const read = await getGoal("session")
  expect(read?.planRevision).toBe(40)
  expect(read?.plan?.changes).toHaveLength(32)
  expect(read?.plan?.changes[0]?.revision).toBe(9)
  expect(read?.plan?.changes.at(-1)?.revision).toBe(40)
})

test("oversized input stays rejected while stored structural limits stay enforced", async () => {
  const oversized = bigPlanInput(200_000)
  expect(JSON.stringify(oversized).length).toBeGreaterThan(128_000)
  expect(GoalPlanInputSchema.safeParse(oversized).success).toBe(false)
  const goal = await createGoal("session", "Reject oversized plans")
  await expect(
    updateGoalPlan("session", {
      goalID: goal.id,
      expectedRevision: 0,
      plan: oversized,
      reason: "Too big",
    }),
  ).rejects.toThrow("plan exceeds the persistent state size limit")
  expect((await getGoal("session"))?.plan).toBeNull()

  const stored = {
    ...initialPlan(),
    revision: 1,
    updatedAt: 1,
    changes: [{ revision: 1, reason: "ok", timestamp: 1 }],
  }
  expect(GoalPlanSchema.safeParse(stored).success).toBe(true)
  const duplicateTask = structuredClone(stored)
  duplicateTask.phases[1]!.tasks[0]!.id = "compound"
  expect(GoalPlanSchema.safeParse(duplicateTask).success).toBe(false)
  const unverifiedTask = structuredClone(stored)
  unverifiedTask.phases[0]!.tasks[0]!.status = "completed"
  expect(GoalPlanSchema.safeParse(unverifiedTask).success).toBe(false)
  const tooManyChanges = structuredClone(stored)
  tooManyChanges.changes = Array.from({ length: 33 }, (_, index) => ({
    revision: index + 1,
    reason: "ok",
    timestamp: 1,
  }))
  expect(GoalPlanSchema.safeParse(tooManyChanges).success).toBe(false)
})
