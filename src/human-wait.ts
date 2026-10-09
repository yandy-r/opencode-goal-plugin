import { getGoal, setGoalWaiting } from "./state"

/** Request IDs are scoped by kind and session; replies seen during recovery win over lists. */
export class HumanWaits {
  readonly pending = new Map<string, Set<string>>()
  private readonly actions = new Map<string, Map<string, string>>()
  private readonly recovering = new Set<string>()
  private readonly replied = new Map<string, Set<string>>()
  private closed = false
  private readonly goalIDs = new Map<string, string>()
  /** Failed inventories block until an authoritative list succeeds. */
  private readonly unverified = new Set<string>()
  private readonly recoveryPending = new Map<string, Set<string>>()
  private readonly replyOverflow = new Set<string>()
  private readonly deferredWake = new Set<string>()
  private readonly revisions = new Map<string, number>()
  private readonly writes = new Map<string, Promise<unknown>>()

  private readonly pauseElapsed: boolean
  private readonly stop: (sessionID: string) => void
  private readonly wake: (sessionID: string) => void

  constructor(
    pauseElapsed: boolean,
    stop: (sessionID: string) => void,
    wake: (sessionID: string) => void,
  ) {
    this.pauseElapsed = pauseElapsed
    this.stop = stop
    this.wake = wake
  }

  blocked(sessionID: string) {
    return (
      this.recovering.has(sessionID) ||
      this.unverified.has(sessionID) ||
      Boolean(this.pending.get(sessionID)?.size)
    )
  }

  deferWake(sessionID: string) {
    if (this.recovering.has(sessionID)) this.deferredWake.add(sessionID)
  }

  revision(sessionID: string) {
    return this.revisions.get(sessionID) ?? 0
  }

  private sync(sessionID: string) {
    const expectedGoalID = this.goalIDs.get(sessionID)
    const previous = this.writes.get(sessionID) ?? Promise.resolve()
    const write = previous
      .catch(() => {})
      .then(async () => {
        if (this.closed) return null
        const goal = await getGoal(sessionID)
        if (!goal) return goal
        if (!expectedGoalID || this.goalIDs.get(sessionID) !== expectedGoalID) return null
        if (goal.id !== expectedGoalID) {
          this.delete(sessionID)
          return null
        }
        const key = this.pending.get(sessionID)?.values().next().value
        if (!key && this.recovering.has(sessionID)) return goal
        const waiting = key || this.unverified.has(sessionID)
        if (waiting && goal.status !== "active") return goal
        if (["complete", "unmet", "cancelled"].includes(goal.status)) return goal
        return setGoalWaiting(
          sessionID,
          waiting ? (key ? (this.actions.get(sessionID)?.get(key) ?? "") : "") : null,
          this.pauseElapsed,
          goal.id,
        )
      })
    this.writes.set(sessionID, write)
    void write
      .finally(() => {
        if (this.writes.get(sessionID) === write) this.writes.delete(sessionID)
      })
      .catch(() => {})
    return write
  }

  async resync(sessionID: string) {
    if (this.blocked(sessionID)) await this.sync(sessionID)
  }

  async ask(sessionID: string, kind: string, id: string, action = "") {
    if (this.closed) return
    const goal = await getGoal(sessionID)
    if (this.closed || !goal || goal.status !== "active") return
    if (this.goalIDs.has(sessionID) && this.goalIDs.get(sessionID) !== goal.id)
      this.delete(sessionID)
    this.goalIDs.set(sessionID, goal.id)
    const key = `${kind}:${id}`
    if (this.replied.get(sessionID)?.has(key)) return
    const pending = this.pending.get(sessionID) ?? new Set<string>()
    if (pending.has(key)) return
    this.pending.set(sessionID, pending)
    pending.add(key)
    const actions = this.actions.get(sessionID) ?? new Map<string, string>()
    this.actions.set(sessionID, actions)
    actions.set(key, action)
    this.revisions.set(sessionID, this.revision(sessionID) + 1)
    this.stop(sessionID)
    await this.sync(sessionID)
  }

  async reply(sessionID: string, kind: string, id: string) {
    const key = `${kind}:${id}`
    if (this.closed) return
    if (!this.recovering.has(sessionID) && !this.pending.get(sessionID)?.has(key)) return
    const current = await getGoal(sessionID)
    if (this.closed || !current || current.id !== this.goalIDs.get(sessionID)) {
      this.delete(sessionID)
      return
    }
    if (this.recovering.has(sessionID)) {
      const replied = this.replied.get(sessionID) ?? new Set<string>()
      this.replied.set(sessionID, replied)
      // Never evict a reply and let a delayed list resurrect its request.
      // On overflow retain a conservative wait instead of trusting that list.
      if (replied.size < 1024) replied.add(key)
      else this.replyOverflow.add(sessionID)
    }
    const known = this.pending.get(sessionID)?.delete(key) === true
    if (!known) return
    this.actions.get(sessionID)?.delete(key)
    const goal = await this.sync(sessionID)
    if (!this.blocked(sessionID) && goal?.status === "active" && !goal.waitingForHuman)
      this.wake(sessionID)
  }

  beginRecovery(sessionID: string, goalID: string) {
    if (this.closed) return
    this.goalIDs.set(sessionID, goalID)
    this.recovering.add(sessionID)
    this.recoveryPending.set(sessionID, new Set(this.pending.get(sessionID)))
  }

  needsRecovery(sessionID: string) {
    return this.unverified.has(sessionID) && !this.recovering.has(sessionID)
  }

  /** Drops a recovery marker without any state write (foreign or unresolvable session). */
  abandonRecovery(sessionID: string) {
    this.recovering.delete(sessionID)
    this.recoveryPending.delete(sessionID)
    this.replied.delete(sessionID)
    this.replyOverflow.delete(sessionID)
    this.deferredWake.delete(sessionID)
    if (!this.pending.get(sessionID)?.size) this.goalIDs.delete(sessionID)
  }

  /**
   * Merges a restart list with live events. `null` (failed list after retries)
   * blocks even without a persisted wait. Only a successful authoritative list
   * clears unknown inventory; live events may trigger another bounded recovery.
   * Reply tombstones exist only during recovery and are dropped here.
   */
  async finishRecovery(
    sessionID: string,
    requests: readonly { id: string; action?: string }[] | null,
  ) {
    if (!this.recovering.has(sessionID)) return
    let wasWaiting: boolean
    try {
      const current = await getGoal(sessionID)
      if (
        this.closed ||
        !current ||
        current.id !== this.goalIDs.get(sessionID) ||
        ["complete", "unmet", "cancelled"].includes(current.status)
      ) {
        this.delete(sessionID)
        return
      }
      wasWaiting = current.waitingForHuman === true || this.unverified.has(sessionID)
      if (this.replyOverflow.delete(sessionID)) requests = null
      const replied = this.replied.get(sessionID)
      if (requests) {
        // An authoritative list replaces permission keys known before relisting;
        // asks seen while listing remain until their replies arrive.
        const listed = new Set(requests.map((request) => `permission:${request.id}`))
        for (const key of this.recoveryPending.get(sessionID) ?? [])
          if (key.startsWith("permission:") && !listed.has(key)) {
            this.pending.get(sessionID)?.delete(key)
            this.actions.get(sessionID)?.delete(key)
          }
        this.unverified.delete(sessionID)
      } else this.unverified.add(sessionID)
      for (const request of requests ?? []) {
        const key = `permission:${request.id}`
        if (replied?.has(key) || this.pending.get(sessionID)?.has(key)) continue
        const pending = this.pending.get(sessionID) ?? new Set<string>()
        this.pending.set(sessionID, pending)
        pending.add(key)
        const actions = this.actions.get(sessionID) ?? new Map<string, string>()
        this.actions.set(sessionID, actions)
        actions.set(key, request.action ?? "")
      }
    } finally {
      this.recovering.delete(sessionID)
      this.recoveryPending.delete(sessionID)
      this.replied.delete(sessionID)
    }
    const deferred = this.deferredWake.delete(sessionID)
    if (this.pending.get(sessionID)?.size || requests === null) {
      this.revisions.set(sessionID, this.revision(sessionID) + 1)
      this.stop(sessionID)
      await this.sync(sessionID)
      return
    }
    const goal = wasWaiting ? await this.sync(sessionID) : await getGoal(sessionID)
    if ((deferred || wasWaiting) && goal?.status === "active" && !goal.waitingForHuman)
      this.wake(sessionID)
  }

  delete(sessionID: string) {
    this.deferredWake.delete(sessionID)
    this.pending.delete(sessionID)
    this.actions.delete(sessionID)
    this.recovering.delete(sessionID)
    this.recoveryPending.delete(sessionID)
    this.replied.delete(sessionID)
    this.revisions.delete(sessionID)
    this.goalIDs.delete(sessionID)
    this.unverified.delete(sessionID)
    this.replyOverflow.delete(sessionID)
  }

  clear() {
    this.closed = true
    for (const sessionID of new Set([
      ...this.pending.keys(),
      ...this.recovering,
      ...this.goalIDs.keys(),
    ]))
      this.delete(sessionID)
  }
}
