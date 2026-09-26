import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import ts from "typescript"

const catalog = readFileSync(new URL("../src/components/marketing/catalog.ts", import.meta.url), "utf8")
const help = readFileSync(new URL("../src/lib/marketing/help.ts", import.meta.url), "utf8")
const report = readFileSync(new URL("../docs/release-acceptance.md", import.meta.url), "utf8")

function catalogClaims() {
  const source = ts.createSourceFile("catalog.ts", catalog, ts.ScriptTarget.Latest, true)
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(item => item.name.getText(source) === "marketingFeatures")
  assert.ok(declaration && ts.isArrayLiteralExpression(declaration.initializer), "marketingFeatures array must be inspectable")

  return declaration.initializer.elements.map(feature => {
    assert.ok(ts.isObjectLiteralExpression(feature))
    const property = name => feature.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(source) === name)
    const id = property("id")?.initializer
    const capabilities = property("capabilities")?.initializer
    assert.ok(id && ts.isStringLiteral(id))
    assert.ok(capabilities && ts.isArrayLiteralExpression(capabilities))
    return { id: id.text, capabilities: capabilities.elements.map(item => {
      assert.ok(ts.isStringLiteral(item))
      return item.text
    }) }
  })
}

test("each public marketing capability has a readiness and hosted-evidence row", () => {
  const claims = catalogClaims()
  const table = report.split("## Public capability coverage\n")[1]?.split("The homepage's five-stage story")[0]
  assert.ok(table, "public capability matrix is present")
  const rows = [...table.matchAll(/^\| `([a-z]+)` — (.+?) \| (.+?) \| (.+?) \| (.+?) \| \*\*needed\*\* \|$/gm)]
  assert.deepEqual(rows.map(row => row[1]), claims.map(claim => claim.id))
  for (const [index, claim] of claims.entries()) {
    const row = rows[index]
    for (const capability of claim.capabilities) assert.ok(row[2].includes(capability), `${claim.id}: ${capability}`)
    assert.match(row[5], /\*\*(?:local-only|conditional|unavailable)\*\*/)
    assert.match(row[3], /src\//)
    assert.match(row[4], /tests\//)
  }
})

test("each published help article is tracked with a non-ready hosted label", () => {
  const source = ts.createSourceFile("help.ts", help, ts.ScriptTarget.Latest, true)
  const slugs = [...source.statements]
    .filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(item => item.name.getText(source) === "helpArticles")
    .flatMap(item => ts.isArrayLiteralExpression(item.initializer) ? [...item.initializer.elements] : [])
    .map(article => {
      assert.ok(ts.isObjectLiteralExpression(article))
      const slug = article.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(source) === "slug")
      assert.ok(slug && ts.isStringLiteral(slug.initializer))
      return slug.initializer.text
    })
  const rows = [...report.matchAll(/^\| `([a-z-]+)` \| (.+?) \| (.+?) \| \*\*needed\*\* \|$/gm)]
    .filter(row => slugs.includes(row[1]))
  assert.deepEqual(rows.map(row => row[1]), slugs)
  for (const row of rows) {
    assert.match(row[2], /tests\//)
    assert.match(row[3], /\*\*(?:local-only|conditional|unavailable)\*\*/)
  }
})
