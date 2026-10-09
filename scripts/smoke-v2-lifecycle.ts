// Runs the installed OpenCode V2 binary against a deterministic local model.
// No real provider credentials, shared service, or user goal state are used.
import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = await mkdtemp(join(tmpdir(), "goal-v2-lifecycle-smoke-"))
const project = join(root, "project")
await mkdir(project)
const target = process.argv[2] ?? "."
const registryPackage = target.startsWith("@")
const packagePath = registryPackage ? target : resolve(target)
let modelCalls = 0
let continuationCalls = 0
// Persisted goal fields the permission-wait smoke inspects.
type SmokeGoal = {
  status: string
  autoTurns: number
  timeUsedSeconds: number
  waitingForHuman?: boolean
  elapsedPaused?: boolean
  lastStatus?: string | null
}
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      messages: Array<{ role: string; content?: unknown }>
      tools?: Array<{ function: { name: string } }>
      stream?: boolean
    }
    modelCalls++
    await writeFile(join(root, `model-request-${modelCalls}.json`), JSON.stringify(body))
    const messages = body.messages
    const last = messages.at(-1)
    const continuationCount = messages.filter(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes("Continue working toward the active session goal"),
    ).length
    const hasContinuation = continuationCount > 0
    if (hasContinuation) continuationCalls++
    const statusOnly =
      !hasContinuation &&
      messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("status smoke"),
      )
    const toolName = statusOnly ? "get_goal" : hasContinuation ? "update_goal" : "create_goal"
    const tool = body.tools?.find(
      (entry) => entry.function.name === toolName || entry.function.name.endsWith(`_${toolName}`),
    )
    const call = last?.role === "user" && tool && (!hasContinuation || continuationCount >= 2)
    const args = statusOnly
      ? {}
      : hasContinuation
        ? {
            status: "complete",
            evidence:
              "A native V2 execution settled and the plugin automatically sent the next goal prompt.",
          }
        : {
            objective: "Verify native V2 goal continuation with the local fixture model",
            max_auto_turns: 3,
          }
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${modelCalls}`,
              type: "function",
              function: { name: tool.function.name, arguments: JSON.stringify(args) },
            },
          ],
        }
      : {
          role: "assistant",
          content: `Isolated fixture milestone ${modelCalls} is verified. The active goal still requires the next automatic continuation turn.`,
        }
    const finish = call ? "tool_calls" : "stop"
    const chunk = (choices: unknown[], usage?: unknown) => ({
      id: `chatcmpl_${modelCalls}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fixture",
      choices,
      ...(usage ? { usage } : {}),
    })
    const usage = { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
    if (!body.stream) {
      return Response.json({
        ...chunk([]),
        object: "chat.completion",
        choices: [{ index: 0, message: delta, finish_reason: finish }],
        usage,
      })
    }
    return new Response(
      [
        chunk([{ index: 0, delta, finish_reason: null }]),
        chunk([{ index: 0, delta: {}, finish_reason: finish }], usage),
      ]
        .map((item) => `data: ${JSON.stringify(item)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      {
        headers: { "content-type": "text/event-stream" },
      },
    )
  },
})

await mkdir(join(root, "config/opencode"), { recursive: true })
if (!registryPackage) {
  await mkdir(join(root, "config/opencode/plugins"))
  await writeFile(
    join(root, "config/opencode/plugins/goal.ts"),
    `export { default } from ${JSON.stringify(pathToFileURL(join(packagePath, "dist/server.js")).href)}\n`,
  )
}
await writeFile(
  join(root, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "fixture/fixture",
    snapshots: false,
    // The permission-wait smoke synthesizes an ask for this action; the host
    // must hold it pending until a reply instead of auto-resolving it.
    permissions: [{ action: "yan935.smoke", resource: "*", effect: "ask" }],
    providers: {
      fixture: {
        env: ["FIXTURE_API_KEY"],
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${model.port}/v1` },
        models: { fixture: { name: "Local fixture", limit: { context: 100000, output: 1000 } } },
      },
    },
  }),
)

// Use a clean environment, not a spread of process.env (which may carry a live
// OPENCODE_DB, server connection settings, provider credentials, or config).
const env = {
  PATH: process.env.PATH!,
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_GOAL_STATE_PATH: join(root, "goals.json"),
  OPENCODE_PASSWORD: crypto.randomUUID(),
  FIXTURE_API_KEY: "local-fixture-only",
}
const binary = process.env.OPENCODE_V2_BIN ?? "opencode2"
if (registryPackage) {
  const install = Bun.spawn([binary, "plugin", "add", packagePath], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(install.stdout).text(),
    new Response(install.stderr).text(),
    install.exited,
  ])
  await writeFile(join(root, "install.log"), stdout + stderr)
  if (code !== 0) {
    model.stop(true)
    throw new Error(`Plugin installation failed; inspect ${root}/install.log`)
  }
}
const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: project,
  env,
  stdout: "pipe",
  stderr: "pipe",
})
let output = ""
const consume = async (stream: ReadableStream<Uint8Array>) => {
  for await (const chunk of stream) output += new TextDecoder().decode(chunk)
}
const readers = Promise.all([consume(child.stdout), consume(child.stderr)])
// The permission-wait smoke holds a settled session for several seconds and then
// drives two more continuation cycles, so the default budget must exceed 60s.
const deadline = Date.now() + Number(process.env.OPENCODE_SMOKE_TIMEOUT_MS ?? 60000)
let lastStage: string | undefined
const waitFor = async (
  stage: string,
  check: () => boolean | Promise<boolean>,
  diagnose?: () => string,
) => {
  lastStage = stage
  while (Date.now() < deadline) {
    if (await check()) return
    if (child.exitCode != null) throw new Error(`Private V2 exited: ${output.slice(-4000)}`)
    await Bun.sleep(50)
  }
  const details = diagnose?.()
  const observed = `modelCalls=${modelCalls}, continuationCalls=${continuationCalls}${details ? `; ${details}` : ""}`
  throw new Error(`Smoke timeout at stage "${stage}"; ${observed}; logs=${root}/server.log`)
}
let passed = false
// Requests that may stay pending on the host (a permission ask hangs until
// replied). Every one gets a rejection handler at creation; cleanup aborts the
// controller so none can outlive the run or surface as an unhandled rejection.
const requests = new AbortController()
const settledRequests: Promise<void>[] = []
const trackRequest = (request: Promise<unknown>) => {
  const outcome: { done: boolean; error?: Error } = { done: false }
  settledRequests.push(
    request.then(
      () => {
        outcome.done = true
      },
      (error: unknown) => {
        outcome.done = true
        if (!requests.signal.aborted)
          outcome.error = error instanceof Error ? error : new Error(String(error))
      },
    ),
  )
  return outcome
}
try {
  await waitFor("server-ready", () => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const base = output.match(/http:\/\/127\.0\.0\.1:\d+/)![0]
  const api = async (path: string, data?: unknown, signal?: AbortSignal) => {
    const response = await fetch(`${base}${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}`,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
        : AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
    assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
    const text = await response.text()
    return text ? JSON.parse(text) : undefined
  }
  const created = (await api("/api/session", {
    location: { directory: project },
    title: "Isolated lifecycle smoke",
    model: { providerID: "fixture", id: "fixture" },
    agent: "build",
  })) as { data: { id: string } }
  const sessionID = created.data.id
  // The user's shared server hosts many locations. Activating a second plugin
  // instance must not duplicate continuation delivery for the first location.
  const otherProject = join(root, "other-project")
  await mkdir(otherProject)
  // OpenCode 2.0.26 removed /api/plugin/await-activation. GET /api/plugin loads
  // the location and reports each plugin's native active/failed state, so poll it
  // for both locations before driving the session.
  type PluginList = { data: Array<{ id?: string; state?: { status: string; error?: string } }> }
  const listPlugins = (directory: string) =>
    api(
      `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
    ) as Promise<PluginList>
  const goalPluginActive = (list: PluginList) =>
    list.data.some(
      (plugin) => plugin.id === "local.goal-mode.server" && plugin.state?.status === "active",
    )
  let plugins: PluginList = { data: [] }
  let otherPlugins: PluginList = { data: [] }
  await waitFor(
    "plugin-active",
    async () => {
      ;[otherPlugins, plugins] = await Promise.all([
        listPlugins(otherProject),
        listPlugins(project),
      ])
      const failed = [...otherPlugins.data, ...plugins.data].find(
        (plugin) => plugin.state?.status === "failed",
      )
      if (failed) throw new Error(`Plugin failed to activate: ${JSON.stringify(failed)}`)
      return goalPluginActive(otherPlugins) && goalPluginActive(plugins)
    },
    () => `plugins=${JSON.stringify(plugins.data)}, other=${JSON.stringify(otherPlugins.data)}`,
  )
  await writeFile(join(root, "plugins.json"), JSON.stringify({ plugins, otherPlugins }))
  await writeFile(
    join(root, "config.json"),
    JSON.stringify(await api(`/api/config?location%5Bdirectory%5D=${encodeURIComponent(project)}`)),
  )
  assert(
    plugins.data.some(
      (plugin) => plugin.id === "local.goal-mode.server" && plugin.state?.status === "active",
    ),
    `Goal plugin did not activate; inspect ${root}/plugins.json`,
  )
  const commands = (await api(
    `/api/command?location%5Bdirectory%5D=${encodeURIComponent(project)}`,
  )) as { data: Array<{ name: string }> }
  assert(commands.data.some((command) => command.name === "goal"))
  await api(`/api/session/${sessionID}/command`, {
    name: "goal",
    text: "Create a goal for the fixture milestone. Keep it active until the automatic continuation arrives.",
  })
  let state: { goals: Record<string, SmokeGoal> } | undefined
  const readState = async () => {
    state = JSON.parse(await readFile(env.OPENCODE_GOAL_STATE_PATH, "utf8")) as typeof state
  }
  // Last-observed values for each final condition, so a timeout can report
  // which one was stuck instead of failing opaquely.
  let lastOutcome: string | undefined
  let lastGoalStatus: string | undefined
  let lastAutoTurns: number | undefined
  let lastActiveSessionActive: boolean | undefined
  await waitFor(
    "goal-complete",
    async () => {
      const current = (await api(`/api/session/${sessionID}`)) as { data: { outcome?: string } }
      lastOutcome = current.data.outcome
      if (current.data.outcome === "failed") {
        const exported = await api(`/api/session/${sessionID}/export`)
        await writeFile(join(root, "failed-session.json"), JSON.stringify(exported))
        throw new Error(`Fixture session failed; inspect ${root}/failed-session.json`)
      }
      try {
        state = JSON.parse(await readFile(env.OPENCODE_GOAL_STATE_PATH, "utf8"))
      } catch {
        return false
      }
      lastGoalStatus = state?.goals[sessionID]?.status
      lastAutoTurns = state?.goals[sessionID]?.autoTurns
      if (state?.goals[sessionID]?.status !== "complete") return false
      const active = (await api("/api/session/active")) as { data: Record<string, unknown> }
      lastActiveSessionActive = sessionID in active.data
      return !lastActiveSessionActive
    },
    () => {
      const parts = [
        `goal status=${lastGoalStatus ?? "none"}`,
        `autoTurns=${lastAutoTurns ?? "none"}`,
        `outcome=${lastOutcome ?? "unknown"}`,
        `stillActive=${lastActiveSessionActive ?? "unknown"}`,
      ]
      return parts.join(", ")
    },
  )
  assert.equal(state!.goals[sessionID]!.autoTurns, 2)
  assert(continuationCalls > 0)

  // Real-host permission-wait smoke (local mode only). Registry mode installs
  // the published package, which cannot import this checkout's src/state.ts,
  // and the seeded goal requires it; the rest of the registry smoke is
  // unchanged and this test is explicitly skipped there.
  let permissionWaitEvidence: Record<string, unknown> | undefined
  if (!registryPackage) {
    const waitSession = (await api("/api/session", {
      location: { directory: project },
      title: "Isolated permission wait smoke",
      model: { providerID: "fixture", id: "fixture" },
      agent: "build",
    })) as { data: { id: string } }
    const waitSessionID = waitSession.data.id
    // Seed an already-active goal for the separate session. Seeding through the
    // checkout's real state module (same OPENCODE_GOAL_STATE_PATH) avoids
    // driving the fixture model just to register a goal.
    const seed = Bun.spawn(
      [
        "bun",
        "-e",
        `import { createGoal } from ${JSON.stringify(new URL("../src/state.ts", import.meta.url).href)};` +
          ` await createGoal(${JSON.stringify(waitSessionID)}, "Hold automation while a host permission request is pending");`,
      ],
      { env: { ...env, PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" },
    )
    const seedOutput =
      (await new Response(seed.stdout).text()) + (await new Response(seed.stderr).text())
    if ((await seed.exited) !== 0)
      throw new Error(`Goal seeding failed; inspect ${root}/server.log\n${seedOutput}`)
    const waitingPath = `/api/session/${waitSessionID}/permission`
    // Create the ask without awaiting: the request stays pending on the host
    // until the reply below.
    const waitingRequest = trackRequest(
      api(
        waitingPath,
        {
          id: "per_yan935_smoke",
          action: "yan935.smoke",
          resources: ["yan935-smoke-resource"],
        },
        requests.signal,
      ),
    )
    const waitGoal = () => state?.goals[waitSessionID]
    await waitFor("permission-request-pending", async () => {
      const listed = (await api(waitingPath)) as { data: Array<{ id?: string }> }
      return listed.data.some((request) => request.id === "per_yan935_smoke")
    })
    await waitFor("goal-waiting", async () => {
      try {
        await readState()
      } catch {
        return false
      }
      const goal = waitGoal()
      return Boolean(
        goal &&
        goal.status === "active" &&
        goal.waitingForHuman === true &&
        goal.elapsedPaused === true &&
        typeof goal.lastStatus === "string" &&
        goal.lastStatus.includes("Awaiting approval"),
      )
    })
    // Settle the manual fixture execution while the ask is pending, so the
    // busy/idle boundary the reply will re-evaluate is already quiet.
    await api(`/api/session/${waitSessionID}/command`, {
      name: "goal",
      // A control-only `/goal status` returns after its manual turn; pursuit
      // commands intentionally wait through the human gate.
      text: "status smoke",
    })
    await Bun.sleep(1000)
    const modelCallsWhilePending = modelCalls
    // Hold past three seconds: automation must not arm, and the paused clock
    // must not advance while waiting.
    await Bun.sleep(4000)
    try {
      await readState()
    } catch {
      /* the assertions below only need a readable snapshot */
    }
    const held = waitGoal()
    assert(held && held.autoTurns === 0, `waiting goal must not continue: ${JSON.stringify(held)}`)
    assert(
      held!.timeUsedSeconds <= 2,
      `waiting goal time must stay paused: ${JSON.stringify(held)}`,
    )
    assert.equal(
      modelCalls,
      modelCallsWhilePending,
      "no new model work while the permission request is pending",
    )
    await api(`${waitingPath}/per_yan935_smoke/reply`, { decision: "once" })
    await waitFor(
      "permission-wait-continue",
      async () => {
        if (!waitingRequest.done) return false
        try {
          await readState()
        } catch {
          return false
        }
        const goal = waitGoal()
        return Boolean(
          goal &&
          (goal.waitingForHuman === false || goal.waitingForHuman == null) &&
          (goal.elapsedPaused === false || goal.elapsedPaused == null) &&
          goal.autoTurns >= 1,
        )
      },
      () => `goal=${JSON.stringify(waitGoal())}`,
    )
    if (waitingRequest.error) throw waitingRequest.error
    // The fixture completes the goal after two continuation prompts.
    await waitFor(
      "permission-wait-goal-complete",
      async () => {
        try {
          await readState()
        } catch {
          return false
        }
        return waitGoal()?.status === "complete"
      },
      () => `goal=${JSON.stringify(waitGoal())}`,
    )
    permissionWaitEvidence = {
      result: "PASS",
      sessionID: waitSessionID,
      heldAutoTurns: held.autoTurns,
      heldElapsedSeconds: held.timeUsedSeconds,
      holdSeconds: 4,
      finalStatus: waitGoal()?.status,
      finalAutoTurns: waitGoal()?.autoTurns,
    }
  }

  const arraysSession = (await api("/api/session", {
    location: { directory: project },
    title: "Isolated command arrays smoke",
    model: { providerID: "fixture", id: "fixture" },
    agent: "build",
  })) as { data: { id: string } }
  await api(`/api/session/${arraysSession.data.id}/command`, {
    name: "goal",
    text: "Create a goal for the arrays-present command smoke.",
    files: [],
    agents: [],
    skills: [],
  })
  await waitFor("arrays-goal-registered", async () => {
    try {
      state = JSON.parse(await readFile(env.OPENCODE_GOAL_STATE_PATH, "utf8"))
    } catch {
      return false
    }
    return state?.goals[arraysSession.data.id] != null
  })
  const summary = {
    result: "PASS",
    packagePath,
    sessionID,
    modelCalls,
    continuationCalls,
    status: state!.goals[sessionID]!.status,
    autoTurns: state!.goals[sessionID]!.autoTurns,
    multiLocationPluginActive: true,
    permissionWait: registryPackage
      ? "SKIPPED: registry package cannot seed through this checkout's src/state.ts"
      : permissionWaitEvidence,
    artifacts: root,
  }
  console.log(JSON.stringify(summary, null, 2))
  passed = true
} finally {
  requests.abort()
  await Promise.all(settledRequests)
  child.kill()
  await child.exited
  await readers
  await writeFile(join(root, "server.log"), output)
  model.stop(true)
  // On failure, preserve diagnostics before the temp root disappears: a bare
  // timeout cannot say which final condition was stuck, and CI uploads the
  // copied directory as an artifact via OPENCODE_SMOKE_ARTIFACTS_DIR.
  if (!passed) {
    try {
      const summary = {
        failed: true,
        stage: lastStage ?? "unknown",
        modelCalls,
        continuationCalls,
        deadlineAtMs: deadline,
        finishedAt: Date.now(),
      }
      await writeFile(join(root, "failure-summary.json"), JSON.stringify(summary))
      const artifactsDir = process.env.OPENCODE_SMOKE_ARTIFACTS_DIR
      if (artifactsDir) {
        await mkdir(artifactsDir, { recursive: true })
        await cp(root, artifactsDir, { recursive: true })
      }
    } catch (error) {
      // Artifact preservation must never mask the original failure.
      console.error(
        `Failed to preserve smoke artifacts: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
