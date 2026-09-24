import { expect, test } from "bun:test"
import { PUBLISHED_DESKTOP_VERSIONS } from "../src/generated/desktop-versions.js"

test("static desktop release metadata uses the committed snapshot", async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/sofia_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"

  const { getDesktopReleaseMetadata } = await import("../src/desktop-releases.js")
  const metadata = await getDesktopReleaseMetadata()
  expect(metadata.latestAppVersion).toBe(PUBLISHED_DESKTOP_VERSIONS[0])
  expect(metadata.publishedDesktopVersions).toEqual([...PUBLISHED_DESKTOP_VERSIONS])
})
