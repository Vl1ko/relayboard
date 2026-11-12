import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { crc32, deflateRawSync } from "node:zlib";
import { ContactImportError, IMPORT_LIMITS, mapContactRows, normalizeImportPhone, parseContactFile, summarize } from "./contact-file.js";

export const csvFixture = [
  "name;phone;comment;stage",
  ...Array.from({ length: 6 }, (_, n) => "Person " + n + ";+1202555010" + (n + 1) + ";note;new"),
  "Duplicate;+1 (202) 555-0101;other;closed",
  "Duplicate;+12025550102;other;manual",
  "Bad;not-a-phone;;",
  "Missing;;;",
].join("\n");
export const fixtureMapping = { sheetName: "CSV", phoneColumn: 1, nameColumn: 0, commentColumn: 2, stageColumn: 3 };

test("CSV fixture: exactly six new, two duplicates and two invalid with physical row numbers", async () => {
  const file = await parseContactFile(Buffer.from("\uFEFF" + csvFixture), "synthetic.csv");
  const rows = mapContactRows(file, fixtureMapping);
  assert.deepEqual(summarize(rows), { total: 10, new: 6, duplicate: 2, invalid: 2 });
  assert.equal(rows[8].rowNumber, 10); assert.equal(rows[9].rowNumber, 11);
  assert.equal(rows[6].phone, "+12025550101"); assert.equal(rows[9].reason, "phone_required");
});

test("CSV quoted separators/newlines and tab delimiter remain strings, not evaluated expressions", async () => {
  const file = await parseContactFile(Buffer.from('phone;name;note\r\n+12025550101;"Name; quoted";"line1\nline2"\r\n+12025550102;Name;=2+2'), "test.csv");
  const rows = mapContactRows(file, { sheetName: "CSV", phoneColumn: 0, nameColumn: 1, commentColumn: 2 });
  assert.equal(rows[0].name, "Name; quoted"); assert.equal(rows[0].comment, "line1\nline2");
  assert.equal(rows[1].rowNumber, 4); assert.equal(rows[1].comment, "=2+2");
  const tabs = await parseContactFile(Buffer.from("phone\tname\n+12025550101\tA"), "tabs.csv");
  assert.equal(tabs.sheets[0].headers.length, 2);
});

test("local phone requires an explicit country; extensions/embedded text are not accepted", () => {
  assert.throws(() => normalizeImportPhone("2025550101"), { code: "country_required" });
  assert.equal(normalizeImportPhone("2025550101", "US"), "+12025550101");
  assert.equal(normalizeImportPhone("00442079460018"), "+442079460018");
  for (const raw of ["call +12025550101", "+12025550101 ext 2", "++12025550101", "123"]) assert.throws(() => normalizeImportPhone(raw, "US"));
  assert.throws(() => normalizeImportPhone("2025550101", "ZZ"));
});

test("XLSX preserves string and safe integer phone cells and rejects formulas in selected fields", async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Numbers");
  sheet.addRow(["phone", "name"]);
  sheet.addRow(["+12025550101", "String"]);
  sheet.addRow([12025550102, "Integer"]);
  sheet.addRow([{ formula: "12025550103", result: 12025550103 }, "Formula"]);
  const file = await parseContactFile(Buffer.from(await workbook.xlsx.writeBuffer()), "synthetic.xlsx");
  const rows = mapContactRows(file, { sheetName: "Numbers", phoneColumn: 0, nameColumn: 1, defaultCountry: "US" });
  assert.deepEqual(summarize(rows), { total: 3, new: 2, duplicate: 0, invalid: 1 });
  assert.equal(rows[1].phone, "+12025550102"); assert.equal(rows[2].reason, "formula_not_allowed");
});

test("bad types, damaged files, unsupported extensions and file/row bounds fail closed", async () => {
  await assert.rejects(parseContactFile(Buffer.from([0xff, 0xfe]), "broken.csv"), { code: "csv_requires_utf8" });
  await assert.rejects(parseContactFile(Buffer.from("not zip"), "broken.xlsx"), { code: "invalid_xlsx" });
  await assert.rejects(parseContactFile(Buffer.from("anything"), "macro.xlsm"), { code: "unsupported_file_type" });
  await assert.rejects(parseContactFile(Buffer.alloc(IMPORT_LIMITS.bytes + 1), "large.csv"), { code: "file_size_limit" });
  const csv = "phone\n" + Array.from({ length: IMPORT_LIMITS.rows + 1 }, () => "+12025550101").join("\n");
  await assert.rejects(parseContactFile(Buffer.from(csv), "rows.csv"), { code: "row_or_cell_limit" });
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet("Bad").getCell("A10002").value = "far";
  await assert.rejects(parseContactFile(Buffer.from(await workbook.xlsx.writeBuffer()), "far.xlsx"), { code: "xlsx_dimensions_limit" });
});

test("mapping is explicit and invalid fields are reported instead of truncated or silently repaired", async () => {
  const file = await parseContactFile(Buffer.from("phone;name\n+12025550101;" + "a".repeat(257) + "\n+12025550102;A;extra"), "rows.csv");
  assert.throws(() => mapContactRows(file, { sheetName: "CSV", phoneColumn: 0, nameColumn: 0 }));
  assert.throws(() => mapContactRows(file, { sheetName: "Missing", phoneColumn: 0 }));
  const rows = mapContactRows(file, { sheetName: "CSV", phoneColumn: 0, nameColumn: 1 });
  assert.equal(rows[0].reason, "field_too_long"); assert.equal(rows[1].reason, "extra_columns");
  assert.ok(rows.every(r => r.outcome === "invalid"));
  assert.ok(new ContactImportError("invalid_phone") instanceof Error);
});

// Tiny ZIP writer for adversarial archive fixtures, without trusting a second parser.
function zipFixture(entries: [string, string][]) {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(text), compressed = deflateRawSync(data);
    const local = Buffer.alloc(30), directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(data), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed); central.push(directory, filename); offset += local.length + filename.length + compressed.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, index, end]);
}

test("XLSX preflight rejects entities, compressed expansion, macros and huge sheet references", async () => {
  const workbook: [string, string] = ["xl/workbook.xml", "<workbook/>"];
  for (const declaration of ['<!DOCTYPE x [<!ENTITY a "b">]><x/>', '<!ENTITY a SYSTEM "file:///etc/passwd">']) {
    await assert.rejects(parseContactFile(zipFixture([["xl/workbook.xml", declaration]]), "unsafe.xlsx"), { code: "unsafe_xml" });
  }
  await assert.rejects(parseContactFile(zipFixture([workbook, ["xl/big.xml", "x".repeat(IMPORT_LIMITS.entryBytes + 1)]]), "bomb.xlsx"), { code: "xlsx_expansion_limit" });
  await assert.rejects(parseContactFile(zipFixture([workbook, ["xl/vbaProject.bin", "macro"]]), "macro.xlsx"), { code: "unsupported_xlsx_content" });
  await assert.rejects(parseContactFile(zipFixture([workbook, ["xl/worksheets/sheet1.xml", '<worksheet><dimension ref="A1:XFD1048576"/></worksheet>']]), "sparse.xlsx"), { code: "xlsx_dimensions_limit" });
});
