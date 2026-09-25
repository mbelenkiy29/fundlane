import { test } from "node:test"
import assert from "node:assert/strict"
import { parseSpreadsheet } from "../src/lib/mca/imports/parser"
const parse = (text: string) => parseSpreadsheet({ filename: "import.csv", bytes: Buffer.from(text) })

test("CSV preserves literal formulas, leading zeroes, escaped quotes and multiline values", () => {
  const result = parse('Name,Code,Note\r\n"Smith, LLC",00123,"A ""quoted""\nline"\r\nOther,=1+2,text')
  assert.deepEqual(result.rows, [["Smith, LLC", "00123", 'A "quoted"\nline'], ["Other", "=1+2", "text"]])
})
test("CSV rejects disguised binary, malformed quotes, extra columns and rows", () => {
  for (const content of ['a,b\nPK\u0003\u0004,x', 'a,b\n"unclosed,x', 'a,b\n"x"bad,y']) assert.throws(() => parse(content))
  assert.throws(() => parse(Array.from({ length: 201 }, (_, i) => `h${i}`).join(',') + '\n1'), /200 columns/)
  assert.throws(() => parse('Name,Value\n' + 'a,1\n'.repeat(10001)), /10,000/)
  assert.throws(() => parseSpreadsheet({ filename: "book.xlsx", bytes: Buffer.from("Name,Value\na,1") }), /Excel file could not be read/)
})
test("CSV accepts the current 10,000-row and 200-column limits without truncating", () => {
  const headers = Array.from({ length: 200 }, (_, i) => `column${i}`).join(',')
  const row = Array.from({ length: 200 }, () => '12345678901').join(',')
  const bytes = Buffer.from(headers + '\n' + (row + '\n').repeat(10000))
  assert.ok(bytes.length < 25 * 1024 * 1024)
  const result = parseSpreadsheet({ filename: "maximum.csv", bytes })
  assert.equal(result.rows.length, 10000); assert.equal(result.headers.length, 200)
  assert.equal(result.rows[9999][199], '12345678901')
})
