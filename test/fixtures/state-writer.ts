// Spawned by test/state-lock.test.ts as a separate OS process: creates a goal
// for its own session, then accounts usage `count` times against the shared
// OPENCODE_GOAL_STATE_PATH.
import { accountUsage, createGoal } from "../../src/state"

const [sessionID, count] = process.argv.slice(2)
if (!sessionID || !count) throw new Error("usage: state-writer <sessionID> <count>")

await createGoal(sessionID, `goal for ${sessionID}`)
for (let index = 0; index < Number(count); index += 1) await accountUsage(sessionID, index + 1)
