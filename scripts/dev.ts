// Dev loop: rebuild dist/server.js on every change under src/.
// With --run, also (re)start OpenCode after each rebuild, resuming the last session.
// Usage: bun run dev [--run] [-- <extra opencode args>]
import { watch } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const run = process.argv.includes("--run")
const sep = process.argv.indexOf("--")
const extra = sep === -1 ? [] : process.argv.slice(sep + 1)
const statePath = process.env.OPENCODE_GOAL_STATE_PATH ?? join(root, ".data", "dev-goals.json")

let child: Bun.Subprocess | undefined
let first = true

async function build() {
  const started = performance.now()
  const result = await Bun.build({
    entrypoints: [join(root, "src/server.ts")],
    outdir: join(root, "dist"),
    target: "bun",
    external: ["@opencode-ai/plugin", "effect-goal-state", "zod"],
  })
  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    return false
  }
  console.log(`[dev] built in ${Math.round(performance.now() - started)}ms`)
  return true
}

async function restart() {
  if (!run) return
  if (child) {
    child.kill("SIGTERM")
    await child.exited
  }
  const args = first ? extra : ["--continue", ...extra]
  first = false
  child = Bun.spawn(["opencode", ...args], {
    cwd: process.cwd(),
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, OPENCODE_GOAL_STATE_PATH: statePath },
  })
}

let timer: ReturnType<typeof setTimeout> | undefined
let busy = false
function schedule() {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    if (busy) return schedule()
    busy = true
    try {
      if (await build()) await restart()
    } finally {
      busy = false
    }
  }, 100)
}

console.log(`[dev] watching src/ (goal state: ${statePath})`)
if (await build()) await restart()
watch(join(root, "src"), { recursive: true }, schedule)

process.on("SIGINT", () => {
  child?.kill("SIGTERM")
  process.exit(0)
})
