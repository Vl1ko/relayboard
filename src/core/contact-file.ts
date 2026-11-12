import { extname } from "node:path";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import yauzl from "yauzl";
import { isSupportedCountry, parsePhoneNumberWithError, type CountryCode } from "libphonenumber-js";
import { z } from "zod";

export const IMPORT_LIMITS = { bytes: 5 * 1024 * 1024, rows: 10000, columns: 100, cells: 100000, sheets: 20,
  expandedBytes: 32 * 1024 * 1024, entryBytes: 16 * 1024 * 1024, zipEntries: 512 };
export class ContactImportError extends Error {
  constructor(public readonly code: string, public readonly status = 400) { super(code); }
}
export type SourceRow = { rowNumber: number; cells: string[]; errors: Record<number, string> };
export type SourceSheet = { name: string; headers: string[]; rows: SourceRow[] };
export type ContactFile = { filename: string; sheets: SourceSheet[] };
export const columnMappingSchema = z.object({
  sheetName: z.string().min(1).max(255), phoneColumn: z.number().int().min(0).max(99),
  nameColumn: z.number().int().min(0).max(99).optional(),
  commentColumn: z.number().int().min(0).max(99).optional(),
  stageColumn: z.number().int().min(0).max(99).optional(),
  defaultCountry: z.string().length(2).refine(isSupportedCountry).optional(),
});
export type ColumnMapping = z.infer<typeof columnMappingSchema>;
export type ImportRow = { rowNumber: number; phone?: string; name?: string; comment?: string; stage?: string;
  outcome: "new" | "duplicate" | "invalid"; reason?: string };
export type ImportSummary = { total: number; new: number; duplicate: number; invalid: number };
export function summarize(rows: ImportRow[]): ImportSummary {
  return { total: rows.length, new: rows.filter(r => r.outcome === "new").length,
    duplicate: rows.filter(r => r.outcome === "duplicate").length, invalid: rows.filter(r => r.outcome === "invalid").length };
}

// Verify actual expanded byte counts before ExcelJS sees the archive; no files are extracted.
async function inspectZip(buffer: Buffer) {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(new ContactImportError("invalid_xlsx")); return; }
      let count = 0, declared = 0, actual = 0, cells = 0, workbook = false, ended = false;
      const fail = (code: string) => { if (!ended) { ended = true; zip.close(); reject(new ContactImportError(code)); } };
      zip.on("error", () => fail("invalid_xlsx"));
      zip.on("end", () => { if (!ended) { ended = true; workbook ? resolve() : reject(new ContactImportError("invalid_xlsx")); } });
      zip.on("entry", entry => {
        if (++count > IMPORT_LIMITS.zipEntries || (declared += entry.uncompressedSize) > IMPORT_LIMITS.expandedBytes
          || entry.uncompressedSize > IMPORT_LIMITS.entryBytes) return fail("xlsx_expansion_limit");
        if (/(^|\/)\.\.(\/|$)|\\|^\//.test(entry.fileName) || entry.generalPurposeBitFlag & 1) return fail("unsafe_xlsx");
        if (/vbaProject|embeddings\//i.test(entry.fileName)) return fail("unsupported_xlsx_content");
        if (entry.fileName === "xl/workbook.xml") workbook = true;
        if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail("invalid_xlsx");
          let entryActual = 0;
          const chunks: Buffer[] = [];
          stream.on("error", () => fail("invalid_xlsx"));
          stream.on("data", (chunk: Buffer) => {
            actual += chunk.length; entryActual += chunk.length;
            if (actual > IMPORT_LIMITS.expandedBytes || entryActual > IMPORT_LIMITS.entryBytes) {
              stream.destroy(); fail("xlsx_expansion_limit"); return;
            }
            if (/\.(xml|rels)$/i.test(entry.fileName)) chunks.push(chunk);
          });
          stream.on("end", () => {
            if (ended) return;
            if (chunks.length) {
              const xml = Buffer.concat(chunks).toString("utf8");
              if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return fail("unsafe_xml");
              if (/^xl\/worksheets\/[^/]+\.xml$/i.test(entry.fileName)) {
                for (const tag of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?(?:c|row|dimension|mergeCell|autoFilter)\b[^>]*>/g)) {
                  if (/^<(?:[A-Za-z_][\w.-]*:)?c\b/.test(tag[0]) && ++cells > IMPORT_LIMITS.cells) return fail("xlsx_dimensions_limit");
                  for (const attribute of tag[0].matchAll(/(?:^|\s)(?:r|ref)\s*=\s*["']([^"']+)["']/g)) {
                    for (const reference of attribute[1].split(":")) {
                      if (/^[0-9]+$/.test(reference)) { if (Number(reference) > IMPORT_LIMITS.rows + 1) return fail("xlsx_dimensions_limit"); continue; }
                      const match = /^([A-Z]{1,3})([0-9]+)$/.exec(reference);
                      if (!match) return fail("invalid_xlsx");
                      let column = 0; for (const c of match[1]) column = column * 26 + c.charCodeAt(0) - 64;
                      if (column > IMPORT_LIMITS.columns || Number(match[2]) > IMPORT_LIMITS.rows + 1) return fail("xlsx_dimensions_limit");
                    }
                  }
                }
              }
            }
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function validateSheets(file: ContactFile) {
  if (!file.sheets.length || file.sheets.length > IMPORT_LIMITS.sheets) throw new ContactImportError("invalid_sheet_count");
  let rows = 0, cells = 0;
  for (const sheet of file.sheets) {
    rows += sheet.rows.length; cells += sheet.headers.length + sheet.rows.reduce((n, r) => n + r.cells.length, 0);
    if (!sheet.headers.length || sheet.headers.length > IMPORT_LIMITS.columns
      || sheet.rows.some(r => r.cells.length > IMPORT_LIMITS.columns)) throw new ContactImportError("column_limit");
  }
  if (rows > IMPORT_LIMITS.rows || cells > IMPORT_LIMITS.cells) throw new ContactImportError("row_or_cell_limit");
  return file;
}

export async function parseContactFile(buffer: Buffer, filename: string): Promise<ContactFile> {
  if (!buffer.length || buffer.length > IMPORT_LIMITS.bytes) throw new ContactImportError("file_size_limit", 413);
  const extension = extname(filename).toLowerCase();
  filename = filename.slice(0, 255);
  if (extension === ".csv") {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { throw new ContactImportError("csv_requires_utf8"); }
    let records: { record: string[]; info: { lines: number } }[];
    try {
      // Probe only the first logical record with each delimiter, preserving quoted newlines.
      const options = [",", ";", "\t"].map(delimiter => {
        try { return { delimiter, width: (parse(text, { delimiter, bom: true, to: 1, relax_column_count: true, max_record_size: 32768 })[0] as string[] | undefined)?.length ?? 0 }; }
        catch { return { delimiter, width: 0 }; }
      });
      const delimiter = options.sort((a, b) => b.width - a.width)[0].delimiter;
      records = parse(text, { delimiter, bom: true, info: true, relax_column_count: true, max_record_size: 32768, to: IMPORT_LIMITS.rows + 2 }) as unknown as typeof records;
    } catch { throw new ContactImportError("invalid_csv"); }
    if (records.length > IMPORT_LIMITS.rows + 1) throw new ContactImportError("row_or_cell_limit");
    const header = records.shift();
    if (!header) throw new ContactImportError("empty_file");
    let previousLine = header.info.lines;
    const rows = records.map(item => {
      const row = { rowNumber: previousLine + 1, cells: item.record, errors: {} }; previousLine = item.info.lines; return row;
    });
    return validateSheets({ filename, sheets: [{ name: "CSV", headers: header.record, rows }] });
  }
  if (extension !== ".xlsx") throw new ContactImportError("unsupported_file_type");
  await inspectZip(buffer);
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheets = workbook.worksheets.filter(s => s.rowCount > 0).map(sheet => {
      if (sheet.rowCount > IMPORT_LIMITS.rows + 1 || sheet.columnCount > IMPORT_LIMITS.columns) throw new ContactImportError("xlsx_dimensions_limit");
      const readRow = (number: number): SourceRow => {
        const errors: Record<number, string> = {}, cells: string[] = [];
        const row = sheet.getRow(number);
        for (let col = 1; col <= sheet.columnCount; col++) {
          const value = row.getCell(col).value; let text = "";
          if (value === null || value === undefined) text = "";
          else if (typeof value === "string") text = value;
          else if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
          else if (typeof value === "object" && "richText" in value) text = value.richText.map(r => r.text).join("");
          else { errors[col - 1] = typeof value === "object" && ("formula" in value || "sharedFormula" in value) ? "formula_not_allowed" : "unsupported_cell_type"; }
          cells.push(text);
        }
        return { rowNumber: number, cells, errors };
      };
      return { name: sheet.name, headers: readRow(1).cells,
        rows: Array.from({ length: sheet.rowCount - 1 }, (_, i) => readRow(i + 2)) };
    });
    return validateSheets({ filename, sheets });
  } catch (error) { if (error instanceof ContactImportError) throw error; throw new ContactImportError("invalid_xlsx"); }
}

export function normalizeImportPhone(raw: string, country?: string): string {
  let text = raw.trim();
  if (!text) throw new ContactImportError("phone_required");
  if (text.startsWith("00")) text = "+" + text.slice(2);
  if (!/^[+0-9().\s-]+$/.test(text) || (text.match(/\+/g)?.length ?? 0) > 1) throw new ContactImportError("invalid_phone");
  if (!text.startsWith("+") && !country) throw new ContactImportError("country_required");
  if (country && !isSupportedCountry(country)) throw new ContactImportError("invalid_country");
  try {
    const phone = parsePhoneNumberWithError(text, { defaultCountry: country as CountryCode | undefined, extract: false });
    if (!phone.isValid() || phone.ext) throw new Error();
    return phone.number;
  } catch { throw new ContactImportError("invalid_phone"); }
}

export function mapContactRows(file: ContactFile, input: ColumnMapping): ImportRow[] {
  const mapping = columnMappingSchema.parse(input);
  const sheet = file.sheets.find(s => s.name === mapping.sheetName);
  if (!sheet) throw new ContactImportError("sheet_not_found");
  const columns = [mapping.phoneColumn, mapping.nameColumn, mapping.commentColumn, mapping.stageColumn].filter((n): n is number => n !== undefined);
  if (new Set(columns).size !== columns.length || columns.some(n => n >= sheet.headers.length)) throw new ContactImportError("invalid_column_mapping");
  const seen = new Set<string>();
  return sheet.rows.map(row => {
    try {
      if (row.cells.length > sheet.headers.length) throw new ContactImportError("extra_columns");
      for (const col of columns) if (row.errors[col]) throw new ContactImportError(row.errors[col]);
      const value = (col?: number) => col === undefined ? "" : (row.cells[col] ?? "").trim();
      const phone = normalizeImportPhone(value(mapping.phoneColumn), mapping.defaultCountry);
      const name = value(mapping.nameColumn), comment = value(mapping.commentColumn), stage = value(mapping.stageColumn);
      if (name.length > 256 || stage.length > 256 || comment.length > 2000) throw new ContactImportError("field_too_long");
      const duplicate = seen.has(phone); seen.add(phone);
      return { rowNumber: row.rowNumber, phone, name, comment, stage, outcome: duplicate ? "duplicate" : "new", reason: duplicate ? "duplicate_in_file" : undefined };
    } catch (error) {
      return { rowNumber: row.rowNumber, outcome: "invalid", reason: error instanceof ContactImportError ? error.code : "invalid_row" };
    }
  });
}
