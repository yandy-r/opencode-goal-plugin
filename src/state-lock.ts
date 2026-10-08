import { randomUUID } from "node:crypto"
import { link, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises"

/**
 * Cross-process exclusive lock for the goal state file.
 *
 * Every OpenCode process shares one state file, and each mutation is a whole
 * read -> modify -> write. The in-process mutation queue cannot stop two
 * processes from interleaving those steps, so the last writer would silently
 * drop the other's update. Holding `<file>.lock` around the full sequence
 * serializes writers across processes.
 *
 * The lock is a file created with `O_EXCL` that holds a unique token. While it
 * is held, its mtime is refreshed on a heartbeat, so a lock whose mtime is older
 * than `staleMs` belongs to a holder that died without releasing it and may be
 * broken. Breaking renames the lock aside and checks the token first, so a
 * waiter never deletes a lock that a live holder has just taken.
 */

export type StateLockOptions = {
  /** A lock not refreshed for this long is treated as abandoned. */
  staleMs?: number
  /** Give up acquiring after this long. Must exceed `staleMs`. */
  timeoutMs?: number
  /** Delay between acquisition attempts. */
  retryMs?: number
}

export class StateLockTimeoutError extends Error {
  constructor(lockFile: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for goal state lock ${lockFile}`)
    this.name = "StateLockTimeoutError"
  }
}

const DEFAULT_STALE_MS = 10_000
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_MS = 25

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function tryCreateLock(lockFile: string, token: string) {
  try {
    const handle = await open(lockFile, "wx", 0o600)
    try {
      await handle.writeFile(token)
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    throw error
  }
}

async function readToken(file: string) {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
}

/**
 * Removes the lock at `lockFile` if it still holds `staleToken`. Renaming first
 * makes the check and the removal one step: if the renamed file turns out to
 * hold a different token, a live holder took the lock in between and it is put
 * back with `link`, which never overwrites a lock created in the meantime.
 */
async function breakStaleLock(lockFile: string, staleToken: string) {
  const aside = `${lockFile}.stale-${randomUUID()}`
  try {
    await rename(lockFile, aside)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return
    throw error
  }
  const token = await readToken(aside)
  if (token !== staleToken) {
    try {
      await link(aside, lockFile)
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  }
  await unlink(aside).catch(() => undefined)
}

async function staleLockToken(lockFile: string, staleMs: number) {
  try {
    const info = await stat(lockFile)
    if (Date.now() - info.mtimeMs <= staleMs) return null
    return await readToken(lockFile)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
}

async function acquireStateLock(lockFile: string, options: Required<StateLockOptions>) {
  const token = `${process.pid}:${randomUUID()}`
  const deadline = Date.now() + options.timeoutMs
  while (true) {
    if (await tryCreateLock(lockFile, token)) return token
    const staleToken = await staleLockToken(lockFile, options.staleMs)
    if (staleToken != null) {
      await breakStaleLock(lockFile, staleToken)
      continue
    }
    if (Date.now() >= deadline) throw new StateLockTimeoutError(lockFile, options.timeoutMs)
    await sleep(options.retryMs)
  }
}

async function releaseStateLock(lockFile: string, token: string) {
  // Only remove the lock if it is still ours; if it was broken as stale, a
  // different holder may own the path now. A failed release must not turn a
  // committed mutation into an error: the lock simply goes stale.
  try {
    if ((await readToken(lockFile)) !== token) return
    await unlink(lockFile)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return
    try {
      console.error(
        `[opencode-goal-plugin] Could not release goal state lock ${lockFile}; it will expire as stale:`,
        error instanceof Error ? error.message : String(error),
      )
    } catch {
      // Diagnostics must never block state writes.
    }
  }
}

function startHeartbeat(lockFile: string, staleMs: number) {
  const timer = setInterval(
    () => {
      const now = new Date()
      void utimes(lockFile, now, now).catch(() => undefined)
    },
    Math.max(1, Math.floor(staleMs / 3)),
  )
  timer.unref?.()
  return () => clearInterval(timer)
}

export async function withStateLock<T>(
  stateFile: string,
  operation: () => Promise<T>,
  options: StateLockOptions = {},
): Promise<T> {
  const resolved: Required<StateLockOptions> = {
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
  }
  const lockFile = `${stateFile}.lock`
  const token = await acquireStateLock(lockFile, resolved)
  const stopHeartbeat = startHeartbeat(lockFile, resolved.staleMs)
  try {
    return await operation()
  } finally {
    stopHeartbeat()
    await releaseStateLock(lockFile, token)
  }
}
