import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, "..")
const sourceDir = path.join(appDir, "src", "models")
const outputPath = path.join(appDir, "models-site", "models", "api.json")
const devSofiaApi = "http://127.0.0.1:8791/api/v1"
const prodSofiaApi = "https://sofia-inference.ruut.chat/api/v1"

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

function sofiaProvider(models, api) {
  return {
    sofia: {
      id: "sofia",
      env: ["SOFIA_API_KEY"],
      npm: "@openrouter/ai-sdk-provider",
      name: "Sofia Models",
      api,
      models,
    },
  }
}

const isDevMode = process.env.SOFIA_DEV_MODE === "1"
const base = await readJson(path.join(sourceDir, "base.json"))
const sofiaModels = await readJson(path.join(sourceDir, "sofia-models.json"))
const sofia = sofiaProvider(sofiaModels, isDevMode ? devSofiaApi : prodSofiaApi)
const models = { ...base, ...sofia }

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(models)}\n`)

console.log(`[inference] generated ${path.relative(appDir, outputPath)} (${isDevMode ? "dev" : "prod"})`)
