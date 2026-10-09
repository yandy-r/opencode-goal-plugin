import { expect, test } from "bun:test"
import fixture from "./fixtures/opencode-shell-v2.0.25.json" with { type: "json" }

// Real OpenCode V2 2.0.25 shell results. Every shell call settles as
// status "completed"; failure and timeout are told apart by metadata only.
type ToolPart = {
  type: string
  id: string
  name: string
  state: { status: string; input: unknown; content: unknown; metadata: Record<string, unknown> }
}

const toolPart = (transcript: unknown[], callID: string): ToolPart => {
  const parts = (transcript as Array<{ content?: ToolPart[] }>).flatMap(
    (message) => message.content ?? [],
  )
  const part = parts.find((entry) => entry.type === "tool" && entry.id === callID)
  if (!part) throw new Error(`No tool part for ${callID}`)
  return part
}

const cases = [
  { name: "exit0", command: "printf yan948-exit0-ok" },
  { name: "exit1", command: "printf yan948-exit1-stderr >&2; exit 1" },
  {
    name: "timeout",
    command: "printf yan948-timeout-start; sleep 5; printf yan948-timeout-end",
  },
] as const

test("provenance records the exact capture and complete counts", () => {
  const { provenance } = fixture
  expect(provenance.opencodeVersion).toBe("opencode v2.0.25")
  expect(provenance.platform).toBe("linux")
  expect(provenance.baselineSHA).toMatch(/^[0-9a-f]{40}$/)
  expect(provenance.captureRoot).toBe("yan-948-capture-S4bisl")
  expect(provenance.capturedModelRequests).toBe(6)
  expect(provenance.capturedHookEvents).toBe(3)
  expect(Object.keys(fixture.hookEvents)).toHaveLength(provenance.capturedHookEvents)
  expect(Object.keys(fixture.sessions)).toHaveLength(provenance.sessions)
})

for (const { name, command } of cases) {
  test(`shell ${name}: hook result matches pre- and post-restart transcript`, () => {
    const event = fixture.hookEvents[name]
    const { pre, post } = fixture.sessions[name]

    expect(event.tool).toBe("shell")
    expect(event.input.command).toBe(command)
    // Status alone cannot distinguish success from failure or timeout.
    expect(event.status).toBe("completed")
    expect(event.result.metadata.status).toBe("completed")

    const preTool = toolPart(pre, event.id)
    const postTool = toolPart(post, event.id)
    expect(preTool.state.input).toEqual(event.input)
    expect(preTool.state.content).toEqual(event.result.content)
    expect(preTool.state.metadata).toEqual(event.result.metadata)
    // Server restart must not change the persisted tool part.
    expect(postTool).toEqual(preTool)
    expect(post).toEqual(pre)

    // Hook call and its assistant message correlate with the transcript.
    const owner = (pre as Array<{ id: string; content?: Array<{ id?: string }> }>).find((m) =>
      m.content?.some((part) => part.id === event.id),
    )
    expect(owner?.id).toBe(event.messageID)
  })
}

test("exit codes and timeout discriminator live in metadata", () => {
  const { exit0, exit1, timeout } = fixture.hookEvents
  expect(exit0.result.metadata.exit).toBe(0)
  expect(exit0.result.metadata).not.toHaveProperty("timeout")
  expect(exit1.result.metadata.exit).toBe(1)
  expect(exit1.result.metadata).not.toHaveProperty("timeout")
  expect(timeout.result.metadata.timeout).toBe(true)
  expect(timeout.result.metadata).not.toHaveProperty("exit")
  // Raw output mirrors the metadata discriminator.
  expect(exit0.result.output).toMatchObject({ exit: 0, status: "completed" })
  expect(exit1.result.output).toMatchObject({ exit: 1, status: "completed" })
  expect(timeout.result.output).toMatchObject({ timeout: true, status: "completed" })
  expect(timeout.result.output).not.toHaveProperty("exit")
})

test("timeout keeps the start marker and never reaches the end marker", () => {
  const { timeout } = fixture.hookEvents
  const output = timeout.result.output.output
  expect(output).toContain("yan948-timeout-start")
  expect(output).not.toContain("yan948-timeout-end")
  expect(timeout.result.content.at(-1)?.text).toBe("Timed out before completion")
})

test("exit1 reports the marker and a failure content part despite completed status", () => {
  const { exit1 } = fixture.hookEvents
  expect(exit1.result.output.output).toBe("yan948-exit1-stderr")
  expect(exit1.result.content.map((part) => part.text)).toEqual([
    "yan948-exit1-stderr",
    "Exited with code 1",
  ])
})
