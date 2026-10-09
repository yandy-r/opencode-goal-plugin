// yan-948: capture raw OpenCode v2.0.25 built-in shell tool execution results.
// Drives an isolated host with a deterministic fixture model: each session makes
// exactly one real advertised shell call (exit0 / exit1 / timeout), captures the
// tool execute.after hook event + raw session.context, then restarts the server
// on the same DB and recaptures with no model or tool calls.
// No goal plugin, no user state; evidence lands under /tmp/opencode/yan-948-capture-*.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const scriptPath = new URL(import.meta.url).pathname
const worktreeRoot = new URL("..", import.meta.url).pathname
await mkdir("/tmp/opencode", { recursive: true })
const root = await mkdtemp("/tmp/opencode/yan-948-capture-")
const project = join(root, "project")
await mkdir(project)
await mkdir(join(root, "config/opencode/plugins"), { recursive: true })
await mkdir(join(root, "contexts"), { recursive: true })
await mkdir(join(root, "model-requests"), { recursive: true })

const binary =
  process.env.OPENCODE_V2_BIN ?? "/tmp/opencode/yan-948-cli-2.0.25/node_modules/.bin/opencode2"
const deadline = Date.now() + Number(process.env.YAN948_TIMEOUT_MS ?? 180_000)

type Case = { id: string; command: string; timeoutMs?: number }
const CASES: Case[] = [
  { id: "exit0", command: "printf yan948-exit0-ok" },
  { id: "exit1", command: "printf yan948-exit1-stderr >&2; exit 1" },
  // END marker must be absent from the result: the call is killed at timeoutMs, before sleep ends.
  {
    id: "timeout",
    command: "printf yan948-timeout-start; sleep 5; printf yan948-timeout-end",
    timeoutMs: 1500,
  },
]
const EXPECTED_VERSION = "opencode v2.0.25"

// Advertised shell tool schema, discovered from the first agent model request.
// ponytail: boxed holder + typed getter because CFA cannot see closure writes to a plain let.
type ShellToolSchema = { name: string; parameters: Record<string, unknown> }
const shellToolBox: { current: ShellToolSchema | null } = { current: null }
const shellTool = (): ShellToolSchema | null => shellToolBox.current
let modelCalls = 0
type FixtureState = { toolSent: boolean; done: boolean }
const fixtureStates = new Map<string, FixtureState>()
const markerFor = (id: string) => `yan948-case:${id}`
const isShellToolName = (name: string) =>
  /(^|[_:.])shell$|(^|[_:.])bash$/i.test(name) || name === "shell"

const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      messages: Array<{ role: string; content?: unknown }>
      tools?: Array<{ function: { name: string; parameters?: Record<string, unknown> } }>
      stream?: boolean
    }
    modelCalls++
    await writeFile(
      join(root, "model-requests", `request-${modelCalls}.json`),
      JSON.stringify(body),
    )
    const shell = body.tools?.find((entry) => isShellToolName(entry.function.name))
    // Auxiliary requests (title/compaction) carry no shell tool; answer with
    // plain text so they can never consume a case's tool turn.
    if (!shell) return respond(body, { role: "assistant", content: "aux" }, "stop")
    if (!shellTool())
      shellToolBox.current = {
        name: shell.function.name,
        parameters: shell.function.parameters ?? {},
      }
    const text = JSON.stringify(body.messages)
    const marker = CASES.map((c) => c.id).find((id) => text.includes(markerFor(id)))
    assert(marker, `agent request without a case marker (request ${modelCalls})`)
    const state = fixtureStates.get(marker) ?? { toolSent: false, done: false }
    fixtureStates.set(marker, state)
    if (!state.toolSent) {
      state.toolSent = true
      const args = shellArgs(CASES.find((c) => c.id === marker)!)
      return respond(
        body,
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${marker}_${modelCalls}`,
              type: "function",
              function: { name: shellTool()!.name, arguments: JSON.stringify(args) },
            },
          ],
        },
        "tool_calls",
      )
    }
    state.done = true
    return respond(
      body,
      { role: "assistant", content: `yan948-final-text-after-tool-${marker}` },
      "stop",
    )
  },
})

function shellArgs(c: Case): Record<string, unknown> {
  const tool = shellTool()
  assert(tool, "shell tool schema not advertised")
  const props = ((tool.parameters as { properties?: Record<string, unknown> }).properties ??
    {}) as Record<string, { type?: string | string[] }>
  const keys = Object.keys(props)
  const commandField =
    keys.find((key) => /^command$/i.test(key)) ?? keys.find((key) => /command/i.test(key))
  assert(
    commandField,
    `no command field in advertised shell schema: ${JSON.stringify(Object.keys(props))}`,
  )
  const args: Record<string, unknown> = { [commandField]: c.command }
  if (c.timeoutMs != null) {
    const timeoutField =
      keys.find((key) => /^timeout$/i.test(key)) ?? keys.find((key) => /timeout/i.test(key))
    assert(
      timeoutField,
      `no timeout field in advertised shell schema: ${JSON.stringify(Object.keys(props))}`,
    )
    args[timeoutField] = c.timeoutMs
  }
  return args
}

let respondSeq = 0
function respond(
  body: { stream?: boolean },
  delta: Record<string, unknown>,
  finish: string,
): Response {
  const chunk = (choices: unknown[]) => ({
    id: `chatcmpl_${++respondSeq}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fixture",
    choices,
  })
  if (!body.stream)
    return Response.json({
      ...chunk([]),
      object: "chat.completion",
      choices: [{ index: 0, message: delta, finish_reason: finish }],
    })
  return new Response(
    [
      chunk([{ index: 0, delta, finish_reason: null }]),
      chunk([{ index: 0, delta: {}, finish_reason: finish }]),
    ]
      .map((item) => `data: ${JSON.stringify(item)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

await writeFile(
  join(root, "config/opencode/plugins/observer.ts"),
  `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
export default {
  id: "local.yan948.observer",
  setup: async (context) => {
    const phase = process.env.YAN948_PHASE ?? "pre"
    const hookFile = process.env.YAN948_HOOK_FILE
    const contextDir = process.env.YAN948_CONTEXT_DIR
    const errorFile = process.env.YAN948_OBSERVER_ERRORS
    // Observer failures are recorded (and fail the harness), never swallowed.
    const record = (where, error) =>
      appendFileSync(errorFile, JSON.stringify({ phase, where, error: String(error?.stack ?? error) }) + "\\n")
    await context.tool.hook("execute.after", async (input) => {
      try {
        appendFileSync(hookFile, JSON.stringify({ phase, ts: Date.now(), event: input }) + "\\n")
      } catch (error) {
        record("tool.hook", error)
        throw error
      }
    })
    await context.command.transform((draft) => {
      draft.add({
        name: "yan948_capture",
        description: "Capture-only: dump raw session context for yan-948",
        execute: async (input) => {
          const file = contextDir + "/" + phase + "-" + input.sessionID + ".json"
          try {
            const raw = await context.session.context({ sessionID: input.sessionID })
            mkdirSync(contextDir, { recursive: true })
            writeFileSync(file, JSON.stringify({ phase, ts: Date.now(), sessionID: input.sessionID, raw }))
          } catch (error) {
            record("session.context", error)
            throw error
          }
        },
      })
    })
    return async () => {}
  },
}
`,
)
await writeFile(
  join(root, "config/opencode/opencode.json"),
  JSON.stringify({
    model: "fixture/fixture",
    snapshots: false,
    // Isolated fixture project only: allow every action so the shell call never blocks on an ask.
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
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

const env = {
  PATH: process.env.PATH!,
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"),
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_PASSWORD: crypto.randomUUID(),
  FIXTURE_API_KEY: "local-fixture-only",
  YAN948_HOOK_FILE: join(root, "hooks.jsonl"),
  YAN948_CONTEXT_DIR: join(root, "contexts"),
  YAN948_OBSERVER_ERRORS: join(root, "observer-errors.jsonl"),
  YAN948_PHASE: "pre",
}

await mkdir(env.HOME, { recursive: true })
const version = await run(binary, ["--version"], env)
await writeFile(join(root, "version.txt"), version)
if (version.trim() !== EXPECTED_VERSION)
  throw new Error(`Expected "${EXPECTED_VERSION}", got "${version.trim()}"; evidence=${root}`)
const baselineSHA = (await run("git", ["rev-parse", "HEAD"], env, worktreeRoot)).trim()
await writeFile(join(root, "baseline-sha.txt"), baselineSHA + "\n")

async function run(
  cmd: string,
  args: string[],
  runEnv: Record<string, string>,
  cwd = project,
): Promise<string> {
  const child = Bun.spawn([cmd, ...args], { cwd, env: runEnv, stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const code = await child.exited
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${code}: ${out}${err}`)
  return out + err
}

let lastStage = "start"
const fail = (message: string): never => {
  throw new Error(`${message}; stage=${lastStage}; evidence=${root}`)
}
const liveServers: Array<{ handle: ServerHandle; logName: string }> = []
const waitFor = async (stage: string, check: () => boolean | Promise<boolean>) => {
  lastStage = stage
  while (Date.now() < deadline) {
    const dead = liveServers.find((server) => server.handle.child.exitCode != null)
    if (dead)
      fail(
        `server exited early (code ${dead.handle.child.exitCode}): ${dead.handle.output.slice(-2000)}`,
      )
    if (await check()) return
    await Bun.sleep(50)
  }
  fail(`Timeout at "${stage}"`)
}

type ServerHandle = {
  child: Bun.Subprocess<"ignore", "pipe", "pipe">
  output: string
  readers: Promise<unknown>
}
const startServer = async (
  phase: string,
  logName: string,
): Promise<{ handle: ServerHandle; base: string }> => {
  const child = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env: { ...env, YAN948_PHASE: phase },
    stdout: "pipe",
    stderr: "pipe",
  })
  const handle: ServerHandle = { child, output: "", readers: Promise.resolve() }
  liveServers.push({ handle, logName })
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) handle.output += new TextDecoder().decode(chunk)
  }
  handle.readers = Promise.all([consume(child.stdout), consume(child.stderr)])
  await waitFor(`server-ready(${phase})`, () => /http:\/\/127\.0\.0\.1:\d+/.test(handle.output))
  return { handle, base: handle.output.match(/http:\/\/127\.0\.0\.1:\d+/)![0] }
}
const stopServer = async (handle: ServerHandle, logName: string) => {
  const index = liveServers.findIndex((server) => server.handle === handle)
  if (index >= 0) liveServers.splice(index, 1)
  handle.child.kill()
  await handle.child.exited
  await handle.readers
  await writeFile(join(root, logName), handle.output)
}

// Observer appends whole lines; a read can race a partial final line, so drop an unparseable last line only.
const readJsonl = async <T>(name: string): Promise<T[]> => {
  const text = await readFile(join(root, name), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  const lines = text.split("\n").filter((line) => line.trim())
  return lines.flatMap((line, index) => {
    try {
      return [JSON.parse(line) as T]
    } catch (error) {
      if (index === lines.length - 1 && !text.endsWith("\n")) return []
      throw error
    }
  })
}
const hooks = () => readJsonl<{ phase: string; event: Record<string, any> }>("hooks.jsonl")
const observerErrors = () => readJsonl<Record<string, unknown>>("observer-errors.jsonl")

let base = ""
const api = async (path: string, data?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${btoa(`opencode:${env.OPENCODE_PASSWORD}`)}`,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  })
  assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

const sessionIDs: Record<string, string> = {}
const outcomes: Record<string, unknown> = {}
let modelCallsPre: number
let hooksPre: number

try {
  const first = await startServer("pre", "server1.log")
  base = first.base
  const openapi = await api("/openapi.json")
  await writeFile(join(root, "openapi.json"), JSON.stringify(openapi))
  const required = (path: string) =>
    (openapi.paths[path].post.requestBody.content["application/json"].schema.required ??
      []) as string[]
  const commandField = required("/api/session/{sessionID}/command").includes("name")
    ? "name"
    : "command"
  const replyField = required("/api/session/{sessionID}/permission/{requestID}/reply").includes(
    "decision",
  )
    ? "decision"
    : "reply"
  const pluginActive = async () => {
    const plugins = (await api(
      `/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(project)}`,
    )) as {
      data: Array<{ id?: string; state?: { status?: string; error?: string } }>
    }
    const failed = plugins.data.find((plugin) => plugin.state?.status === "failed")
    if (failed) fail(`observer plugin failed to activate: ${JSON.stringify(failed)}`)
    return plugins.data.some(
      (plugin) => plugin.id === "local.yan948.observer" && plugin.state?.status === "active",
    )
  }
  await waitFor("plugin-active", pluginActive)
  // shellTool is discovered from the first agent model request inside the loop below.
  const sessionIdle = async (sessionID: string) => {
    const active = (await api("/api/session/active")) as { data: Record<string, unknown> }
    return !(sessionID in active.data)
  }

  for (const c of CASES) {
    const created = (await api("/api/session", {
      location: { directory: project },
      title: `yan948 ${c.id}`,
      model: { providerID: "fixture", id: "fixture" },
      agent: "build",
    })) as { data: { id: string } }
    sessionIDs[c.id] = created.data.id
    await api(`/api/session/${created.data.id}/prompt`, {
      text: `Run marker ${markerFor(c.id)}: make exactly one real shell tool call for the ${c.id} fixture.`,
    })
    await waitFor(`settled(${c.id})`, async () => {
      // Allow any shell permission ask instead of guessing the action name.
      const pending = (await api(`/api/session/${created.data.id}/permission`)) as {
        data: Array<{ id?: string }>
      }
      for (const item of pending.data)
        await api(`/api/session/${created.data.id}/permission/${item.id}/reply`, {
          [replyField]: "once",
        })
      const hookSeen = (await hooks()).some(
        (line) =>
          line.phase === "pre" &&
          (line.event as { sessionID?: string }).sessionID === created.data.id &&
          isShellToolName(String((line.event as { tool?: string }).tool ?? "")),
      )
      return (
        hookSeen &&
        fixtureStates.get(c.id)?.done === true &&
        pending.data.length === 0 &&
        (await sessionIdle(created.data.id))
      )
    })
    const session = await api(`/api/session/${created.data.id}`)
    outcomes[c.id] = (session as { data?: { outcome?: unknown } }).data?.outcome
    await api(`/api/session/${created.data.id}/command`, {
      [commandField]: "yan948_capture",
      text: c.id,
    })
    await waitForContext("pre", created.data.id)
    // ponytail: REST mirror of the plugin capture for pre/post only; skip message dumps until needed.
    await writeFile(
      join(root, "contexts", `rest-pre-${created.data.id}.json`),
      JSON.stringify(await api(`/api/session/${created.data.id}/context`)),
    )
  }
  const commands = (await api(
    `/api/command?location%5Bdirectory%5D=${encodeURIComponent(project)}`,
  )) as {
    data: Array<{ name: string }>
  }
  await writeFile(join(root, "commands.json"), JSON.stringify(commands))
  assert(
    commands.data.some((command) => command.name === "yan948_capture"),
    "capture command not registered",
  )
  modelCallsPre = modelCalls
  hooksPre = (await hooks()).length
  await stopServer(first.handle, "server1.log")

  const second = await startServer("post", "server2.log")
  base = second.base
  await waitFor("plugin-active(post)", pluginActive)
  for (const c of CASES) {
    assert(await sessionIdle(sessionIDs[c.id]!), `session ${c.id} active after restart`)
    await api(`/api/session/${sessionIDs[c.id]}/command`, {
      [commandField]: "yan948_capture",
      text: c.id,
    })
    await waitForContext("post", sessionIDs[c.id]!)
    await writeFile(
      join(root, "contexts", `rest-post-${sessionIDs[c.id]}.json`),
      JSON.stringify(await api(`/api/session/${sessionIDs[c.id]}/context`)),
    )
  }
  const modelCallsPost = modelCalls
  const hooksPost = await hooks()
  await stopServer(second.handle, "server2.log")

  const toolNodes = (value: unknown): unknown[] => {
    const found: unknown[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return
      if (Array.isArray(node)) return node.forEach(walk)
      const record = node as Record<string, unknown>
      const type = String(record.type ?? "")
      if (/tool/i.test(type) || ("metadata" in record && "state" in record)) found.push(record)
      Object.values(record).forEach(walk)
    }
    walk(value)
    return found
  }
  const cases = []
  const problems: string[] = []
  for (const c of CASES) {
    const id = sessionIDs[c.id]!
    const hookLines = (await hooks()).filter(
      (line) =>
        line.event.sessionID === id &&
        isShellToolName(String(line.event.tool ?? "")) &&
        line.phase === "pre",
    )
    if (hookLines.length !== 1)
      problems.push(`${c.id}: expected 1 pre shell hook event, got ${hookLines.length}`)
    const pre = JSON.parse(await readFile(join(root, "contexts", `pre-${id}.json`), "utf8"))
    const post = JSON.parse(await readFile(join(root, "contexts", `post-${id}.json`), "utf8"))
    if (JSON.stringify(pre.raw) !== JSON.stringify(post.raw))
      problems.push(`${c.id}: context changed across restart`)
    const contextTools = toolNodes(post.raw)
    if (contextTools.length === 0) problems.push(`${c.id}: no tool part in restarted context`)
    const pending = contextTools.filter(
      (node) => (node as { state?: { status?: unknown } }).state?.status !== "completed",
    )
    if (pending.length > 0) problems.push(`${c.id}: ${pending.length} tool part(s) not completed`)
    const hookEvent = hookLines[0]?.event
    const result = hookEvent?.result as Record<string, unknown> | undefined
    const meta = (result?.metadata ?? {}) as Record<string, unknown>
    const outputText = JSON.stringify(result?.output ?? "")
    if (c.id === "exit0") {
      if (meta.exit !== 0)
        problems.push(`exit0: expected metadata.exit 0, got ${JSON.stringify(meta.exit)}`)
      if (!outputText.includes("yan948-exit0-ok")) problems.push("exit0: missing output marker")
    }
    if (c.id === "exit1") {
      if (meta.exit !== 1)
        problems.push(`exit1: expected metadata.exit 1, got ${JSON.stringify(meta.exit)}`)
      if (!outputText.includes("yan948-exit1-stderr")) problems.push("exit1: missing output marker")
    }
    if (c.id === "timeout") {
      if (meta.timeout !== true)
        problems.push(
          `timeout: expected metadata.timeout true, got ${JSON.stringify(meta.timeout)}`,
        )
      if (!outputText.includes("yan948-timeout-start"))
        problems.push("timeout: missing start marker")
      if (outputText.includes("yan948-timeout-end"))
        problems.push("timeout: end marker should be absent")
      if (meta.exit !== undefined)
        problems.push(`timeout: metadata.exit should be absent, got ${JSON.stringify(meta.exit)}`)
    }
    const tool = shellTool()
    cases.push({
      case: c.id,
      sessionID: id,
      outcome: outcomes[c.id] ?? null,
      shellTool: tool ? { name: tool.name, args: shellArgs(c), schema: tool.parameters } : null,
      hook: {
        status: hookEvent?.status ?? null,
        error: hookEvent?.error ?? null,
        result: result
          ? {
              title: result.title ?? null,
              metadata: result.metadata ?? null,
              output: result.output ?? null,
            }
          : null,
      },
      contextToolParts: contextTools,
      restartContextIdentical: JSON.stringify(pre.raw) === JSON.stringify(post.raw),
      paths: {
        hookRaw: "hooks.jsonl",
        contextPre: `contexts/pre-${id}.json`,
        contextPost: `contexts/post-${id}.json`,
      },
    })
  }
  if (modelCallsPost !== modelCallsPre)
    problems.push(`model calls after restart: ${modelCallsPre} -> ${modelCallsPost}`)
  if (hooksPost.length !== hooksPre)
    problems.push(`hook events after restart: ${hooksPre} -> ${hooksPost.length}`)
  if (shellTool() == null) problems.push("shell tool schema never advertised")
  const observerErrorCount = (await observerErrors()).length
  if (observerErrorCount > 0) problems.push(`observer errors: ${observerErrorCount}`)

  const summary = {
    result: problems.length === 0 ? "PASS" : "FAIL",
    script: scriptPath,
    cli: { path: binary, version: version.trim() },
    baselineSHA,
    evidenceRoot: root,
    cases,
    counts: { modelCallsPre, modelCallsPost, hooksPre, hooksPost: hooksPost.length },
    paths: {
      modelRequests: "model-requests/",
      hooks: "hooks.jsonl",
      observerErrors: "observer-errors.jsonl",
      contexts: "contexts/",
      openapi: "openapi.json",
      commands: "commands.json",
      server1Log: "server1.log",
      server2Log: "server2.log",
      version: "version.txt",
      baselineSHA: "baseline-sha.txt",
    },
    problems,
  }
  await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
  if (problems.length > 0) process.exitCode = 1
} finally {
  model.stop(true)
  // Kill any live server even on failure so no orphan holds the DB or port.
  for (const server of liveServers) await stopServer(server.handle, server.logName)
}

function exists(path: string): Promise<boolean> {
  return readFile(path, "utf8")
    .then(() => true)
    .catch(() => false)
}

async function waitForContext(phase: string, sessionID: string) {
  await waitFor(`context-${phase}`, async () => {
    const errors = await observerErrors()
    if (errors.length > 0)
      fail(`observer error during ${phase} capture for ${sessionID}: ${JSON.stringify(errors[0])}`)
    return exists(join(root, "contexts", `${phase}-${sessionID}.json`))
  })
}
