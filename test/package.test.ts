import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { satisfies } from "semver"

test("published tui entrypoint shares host runtime instances via peerDependencies", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const runtimeImports = ["@opentui/solid", "solid-js"]

  for (const dependency of runtimeImports) {
    // The TUI host provides its own OpenTUI/solid instances; shipping a
    // second copy in dependencies would break rendering across them.
    expect(packageJson.peerDependencies?.[dependency]).toBeString()
    expect(packageJson.dependencies?.[dependency]).toBeUndefined()
    // Local development keeps its own copies for typecheck and tests.
    expect(packageJson.devDependencies?.[dependency]).toBeString()
  }

  // Dev-pinned OpenTUI must stay compatible with the host peer range.
  expect(satisfies("0.5.16", packageJson.peerDependencies?.["@opentui/solid"] ?? "")).toBe(true)
})

test("engines.opencode covers the V2 beta line and the V1 floor while excluding older stable releases", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    engines?: Record<string, string>
  }
  const range = packageJson.engines?.opencode
  expect(range).toBeString()
  if (typeof range !== "string") throw new Error("expected engines.opencode to be a string range")

  // The range must cover the 0.0.0-beta-* V2 line and the V1 floor 1.17.1
  // while excluding unsupported stable pre-1.17.1 releases.
  for (const version of ["0.0.0-beta-0", "0.0.0-beta-19425", "1.17.1", "1.17.2", "2.0.0"]) {
    expect(satisfies(version, range)).toBe(true)
  }
  for (const version of ["0.0.0", "0.0.1", "0.5.0", "1.0.0", "1.17.0"]) {
    expect(satisfies(version, range)).toBe(false)
  }
})

test("@opencode devDependencies pin the same stable SDK version", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    devDependencies?: Record<string, string>
  }
  // Derive the full set from package.json so future @opencode/* additions
  // cannot silently drift from the shared pin.
  const sdkPackages = Object.keys(packageJson.devDependencies ?? {}).filter((name) =>
    name.startsWith("@opencode/"),
  )
  for (const required of ["client", "plugin", "schema", "theme"]) {
    expect(sdkPackages).toContain(`@opencode/${required}`)
  }
  const versions = new Set(sdkPackages.map((name) => packageJson.devDependencies?.[name]))
  expect([...versions]).toEqual(["2.0.25"])
})

test("workflows pin the OpenCode CLI to the SDK version", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    devDependencies?: Record<string, string>
  }
  const sdkVersion = packageJson.devDependencies?.["@opencode/plugin"]
  for (const file of [".github/workflows/ci.yml", ".github/workflows/publish.yml"]) {
    const workflow = readFileSync(file, "utf8")
    expect(workflow).toContain(`OPENCODE_CLI_VERSION: "${sdkVersion}"`)
    expect(workflow).toContain("npm install -g @opencode/cli@${OPENCODE_CLI_VERSION}")
    expect(workflow).toContain("opencode2 --version")
    expect(workflow).toContain('test "$OBSERVED" = "opencode v${OPENCODE_CLI_VERSION}"')
    expect(workflow).not.toContain("grep -F")
    expect(workflow).not.toContain("@opencode/cli@beta")
  }
})
