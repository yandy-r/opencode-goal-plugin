import { randomUUID } from "node:crypto"
import { open, readFile, stat, unlink, utimes } from "node:fs/promises"

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
 * than `staleMs` belongs to a holder that died (or stalled) without releasing
 * it and may be broken. Breakers are serialized through a second short-lived
 * `O_EXCL` guard and re-check the token under it, so two waiters can never
 * both break and re-take the lock. A holder that stalled past `staleMs` finds
 * out through `assertHeld()` before it writes.
 */

export type StateLockOptions = {
  /** A lock not refreshed for this long is treated as abandoned. */
  staleMs?: number
  /** Give up acquiring after this long. Must exceed `staleMs`. */
  timeoutMs?: number
  /** Delay between acquisition attempts. */
  retryMs?: number
}

export type StateLockHandle = {
  /** Throws `StateLockLostError` if the lock was broken while held. */
  assertHeld(): Promise<void>
}

export class StateLockTimeoutError extends Error {
  constructor(lockFile: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for goal state lock ${lockFile}`)
    this.name = "StateLockTimeoutError"
  }
}

export class StateLockLostError extends Error {
  constructor(lockFile: string) {
    super(`goal state lock ${lockFile} was taken over while held; refusing to write`)
    this.name = "StateLockLostError"
  }
}

const DEFAULT_STALE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_RETRY_MS = 25

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined
}

// On Windows a file that another process is deleting or has open can make
// create/unlink fail transiently with EPERM/EBUSY; treat that as contention.
function isTransientContention(error: unknown) {
  const code = errorCode(error)
  return process.platform === "win32" && (code === "EPERM" || code === "EBUSY")
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function tryCreateExclusive(file: string, token: string) {
  try {
    const handle = await open(file, "wx", 0o600)
    try {
      await handle.writeFile(token)
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if (errorCode(error) === "EEXIST" || isTransientContention(error)) return false
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

async function removeIfPresent(file: string) {
  try {
    await unlink(file)
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && !isTransientContention(error)) throw error
  }
}

async function isStale(file: string, staleMs: number) {
  try {
    return Date.now() - (await stat(file)).mtimeMs > staleMs
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

/**
 * Removes `lockFile` if it is still stale. Only the holder of the break guard
 * may do this, and it re-reads staleness under the guard, so a lock that was
 * released and re-taken in the meantime is left alone. A guard abandoned by a
 * breaker that died is itself removed once stale.
 */
async function breakStaleLock(lockFile: string, staleMs: number) {
  const guard = `${lockFile}.break`
  const guardToken = randomUUID()
  if (!(await tryCreateExclusive(guard, guardToken))) {
    if (await isStale(guard, staleMs)) await removeIfPresent(guard)
    return
  }
  try {
    if (await isStale(lockFile, staleMs)) await removeIfPresent(lockFile)
  } finally {
    if ((await readToken(guard).catch(() => null)) === guardToken) {
      await removeIfPresent(guard).catch(() => undefined)
    }
  }
}

async function acquireStateLock(lockFile: string, options: Required<StateLockOptions>) {
  const token = `${process.pid}:${randomUUID()}`
  const deadline = Date.now() + options.timeoutMs
  while (true) {
    if (await tryCreateExclusive(lockFile, token)) return token
    if (await isStale(lockFile, options.staleMs)) {
      await breakStaleLock(lockFile, options.staleMs)
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
    await removeIfPresent(lockFile)
  } catch (error) {
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

function startHeartbeat(lockFile: string, token: string, staleMs: number) {
  const timer = setInterval(
    () => {
      // Touch the lock only while it is still ours, never a successor's.
      void readToken(lockFile)
        .then((current) => {
          if (current !== token) return
          const now = new Date()
          return utimes(lockFile, now, now)
        })
        .catch(() => undefined)
    },
    Math.max(1, Math.floor(staleMs / 3)),
  )
  timer.unref?.()
  return () => clearInterval(timer)
}

export async function withStateLock<T>(
  stateFile: string,
  operation: (lock: StateLockHandle) => Promise<T>,
  options: StateLockOptions = {},
): Promise<T> {
  const resolved: Required<StateLockOptions> = {
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
  }
  const lockFile = `${stateFile}.lock`
  const token = await acquireStateLock(lockFile, resolved)
  const stopHeartbeat = startHeartbeat(lockFile, token, resolved.staleMs)
  const handle: StateLockHandle = {
    async assertHeld() {
      if ((await readToken(lockFile)) !== token) throw new StateLockLostError(lockFile)
    },
  }
  try {
    return await operation(handle)
  } finally {
    stopHeartbeat()
    await releaseStateLock(lockFile, token)
  }
}
