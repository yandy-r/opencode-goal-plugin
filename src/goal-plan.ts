import { z } from "zod"

const text = z.string().trim().min(1).max(2000)
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const status = z.enum(["pending", "in_progress", "completed", "blocked"])
const task = z
  .object({
    id,
    description: text,
    status,
    evidence: text.nullish(),
    blocker: text.nullish(),
  })
  .strict()
const phase = z
  .object({
    id,
    objective: text,
    status,
    tasks: z.array(task).min(1).max(128),
    verification: text.nullish(),
    blocker: text.nullish(),
  })
  .strict()

export const GoalPlanInputSchema = z
  .object({
    summary: text,
    completionCriteria: z.array(text).min(1).max(32),
    phases: z.array(phase).min(1).max(64),
    decisions: z.array(text).max(32).default([]),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const ids = new Set<string>()
    let runningPhases = 0
    let runningTasks = 0
    for (const phase of plan.phases) {
      if (ids.has(phase.id)) ctx.addIssue({ code: "custom", message: "plan IDs must be unique" })
      ids.add(phase.id)
      if (phase.status === "in_progress") runningPhases++
      if (phase.status === "blocked" && !phase.blocker)
        ctx.addIssue({ code: "custom", message: "blocked phases require a blocker" })
      if (
        phase.status === "completed" &&
        (!phase.verification || phase.tasks.some((task) => task.status !== "completed"))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "completed phases require verified tasks and phase verification",
        })
      }
      for (const task of phase.tasks) {
        if (ids.has(task.id)) ctx.addIssue({ code: "custom", message: "plan IDs must be unique" })
        ids.add(task.id)
        if (task.status === "completed" && !task.evidence)
          ctx.addIssue({ code: "custom", message: "completed tasks require evidence" })
        if (task.status === "blocked" && !task.blocker)
          ctx.addIssue({ code: "custom", message: "blocked tasks require a blocker" })
        if (task.status === "in_progress") {
          runningTasks++
          if (phase.status !== "in_progress")
            ctx.addIssue({ code: "custom", message: "running tasks require a running phase" })
        }
      }
    }
    const firstUnfinished = plan.phases.find((phase) => phase.status !== "completed")
    if (plan.phases.some((phase) => phase.status === "in_progress" && phase !== firstUnfinished))
      ctx.addIssue({
        code: "custom",
        message: "verify the current phase before starting the next phase",
      })
    if (runningPhases > 1 || runningTasks > 1)
      ctx.addIssue({ code: "custom", message: "choose one current phase and task" })
    if (ids.size > 576 || JSON.stringify(plan).length > 128_000)
      ctx.addIssue({ code: "custom", message: "plan exceeds the persistent state size limit" })
  })

export type GoalPlanInput = z.infer<typeof GoalPlanInputSchema>
export const GoalPlanSchema = GoalPlanInputSchema.safeExtend({
  decisions: z.array(text).max(32),
  revision: z.number().int().positive(),
  updatedAt: z.number().finite().nonnegative(),
  changes: z
    .array(
      z
        .object({
          revision: z.number().int().positive(),
          reason: text,
          timestamp: z.number().finite(),
          revisitEvidence: text.optional(),
        })
        .strict(),
    )
    .max(32),
})
export type GoalPlan = z.infer<typeof GoalPlanSchema>

/** A task result advances the plan, never the overall goal's scope or lifecycle. */
export function reviseGoalPlan(
  previous: GoalPlan | null,
  input: GoalPlanInput,
  expectedRevision: number,
  reason: string,
  now: number,
  revisitEvidence?: string,
  currentRevision = previous?.revision ?? 0,
): GoalPlan {
  if (expectedRevision !== currentRevision)
    throw new Error("goal plan revision changed; read get_goal before updating it")
  const next = GoalPlanInputSchema.parse(input)
  const why = text.parse(reason)
  if (previous) {
    if (JSON.stringify(previous.completionCriteria) !== JSON.stringify(next.completionCriteria)) {
      throw new Error("preserve overall completion criteria; replace the goal for a new scope")
    }
    for (const oldPhase of previous.phases) {
      const newPhase = next.phases.find((phase) => phase.id === oldPhase.id)
      if (!newPhase) {
        if (
          oldPhase.status === "completed" ||
          oldPhase.tasks.some((task) => task.status === "completed")
        )
          throw new Error("preserve verified phase and task history")
        if (!revisitEvidence?.trim())
          throw new Error("removing planned scope requires concrete revisit evidence")
        continue
      }
      if (oldPhase.objective !== newPhase.objective && !revisitEvidence?.trim())
        throw new Error("changing planned phase scope requires concrete revisit evidence")
      if (oldPhase.status === "completed" && oldPhase.objective !== newPhase.objective)
        throw new Error("preserve verified phase objectives")
      if (
        oldPhase.status === "completed" &&
        newPhase.status !== "completed" &&
        !revisitEvidence?.trim()
      ) {
        throw new Error("reopening a verified phase requires concrete revisit evidence")
      }
      for (const oldTask of oldPhase.tasks) {
        const newTask = newPhase.tasks.find((task) => task.id === oldTask.id)
        if (oldTask.status !== "completed") {
          if ((!newTask || newTask.description !== oldTask.description) && !revisitEvidence?.trim())
            throw new Error(
              "removing or changing planned task scope requires concrete revisit evidence",
            )
          continue
        }
        if (!newTask || newTask.description !== oldTask.description)
          throw new Error("preserve completed task IDs and descriptions across plan revisions")
        if (
          oldTask.status === "completed" &&
          newTask.status !== "completed" &&
          !revisitEvidence?.trim()
        ) {
          throw new Error("reopening a completed task requires concrete revisit evidence")
        }
      }
    }
  }
  const revision = expectedRevision + 1
  return GoalPlanSchema.parse({
    ...next,
    revision,
    updatedAt: now,
    changes: [
      ...(previous?.changes ?? []),
      {
        revision,
        reason: why,
        timestamp: now,
        ...(revisitEvidence ? { revisitEvidence: text.parse(revisitEvidence) } : {}),
      },
    ].slice(-32),
  })
}

export function goalPlanProgress(plan: GoalPlan) {
  const current =
    plan.phases.find((phase) => phase.status === "in_progress") ??
    plan.phases.find((phase) => phase.status !== "completed")
  const running = current?.tasks.find((task) => task.status === "in_progress")
  const next = current?.tasks.find((task) => task.status === "pending")
  return {
    currentPhaseID: current?.id ?? null,
    currentTaskID: running?.id ?? null,
    nextTaskID: next?.id ?? null,
    nextPhaseID:
      plan.phases.find((phase) => phase.id !== current?.id && phase.status !== "completed")?.id ??
      null,
    completedPhaseIDs: plan.phases
      .filter((phase) => phase.status === "completed")
      .map((phase) => phase.id),
    completedTaskIDs: plan.phases.flatMap((phase) =>
      phase.tasks.filter((task) => task.status === "completed").map((task) => task.id),
    ),
  }
}

/** ACP v1's plan surface is flat; retain phase boundaries in each entry's content. */
export function goalPlanEntries(plan: GoalPlan) {
  return plan.phases.flatMap((phase) =>
    phase.tasks.map((task) => ({
      content: `${phase.objective}: ${task.description}${task.blocker ? ` — Blocked: ${task.blocker}` : ""}`,
      priority: "medium" as const,
      status: task.status === "blocked" ? ("pending" as const) : task.status,
    })),
  )
}
