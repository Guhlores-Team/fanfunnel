// Bulk fan import: CSV text → rows the import route accepts. Pure so the
// parsing rules are unit-tested. Columns: name, spins, amount (dollars,
// optional). A header row is optional.
//
// Fields follow RFC 4180: a quoted field may hold commas, line breaks and ""
// for a literal quote. An unquoted amount written with thousands separators
// ("$1,200") is also read as one amount, since it can only be the last column.

export interface ParsedRow {
  name: string;
  spins: number;
  amountCents?: number;
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Rows that were skipped, and why. */
  errors: string[];
  /** Rows that import, but deserve a second look (a duplicate name, the cap). */
  warnings: string[];
  skippedHeader: boolean;
}

export const MAX_IMPORT_ROWS = 500;
const MAX_SPINS = 1_000_000;
const MAX_DOLLARS = 1_000_000;

/** Split CSV text into records of fields, with the 1-based line each starts on. */
export function csvRecords(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  let any = false;
  const endRecord = () => {
    cells.push(cell);
    if (any || cells.some((c) => c.trim() !== "")) out.push({ line: start, cells: cells.map((c) => c.trim()) });
    cells = [];
    cell = "";
    any = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === "") { cell = ""; quoted = true; any = true; continue; }
    if (ch === ",") { cells.push(cell); cell = ""; continue; }
    if (ch === "\r" && text[i + 1] === "\n") continue;
    if (ch === "\n" || ch === "\r") { endRecord(); line++; start = line; continue; }
    cell += ch;
  }
  if (cell !== "" || cells.length > 0 || any) endRecord();
  return out;
}

/** "$1,200.50" / "1200" / "1,200" → cents; null when it is not a plain amount. */
export function parseDollars(raw: string): number | null {
  const value = raw.replace(/^\$/, "").trim();
  if (!/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(value)) return null;
  return Math.round(Number(value.replace(/,/g, "")) * 100);
}

/** A whole number of spins; null when the cell is not one. */
export function parseSpins(raw: string): number | null {
  const value = raw.trim();
  if (!/^-?(\d{1,3}(,\d{3})+|\d+)$/.test(value)) return null;
  return Number(value.replace(/,/g, ""));
}

const normName = (name: string) => name.trim().replace(/^@/, "").toLowerCase();

export function parseFanCsv(text: string, existingNames: readonly string[] = []): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const records = csvRecords(text);

  let skippedHeader = false;
  const first = records[0];
  if (first && parseSpins(first.cells[1] ?? "") === null && !/^-?[\d.,]+$/.test(first.cells[1] ?? "")) {
    records.shift();
    skippedHeader = true;
  }

  const existing = new Map<string, string>();
  for (const name of existingNames) existing.set(normName(name), name);
  const seen = new Map<string, number>();
  const rows: ParsedRow[] = [];
  for (const { line, cells: raw } of records) {
    // An unquoted "$1,200" splits into "$1" and "200": rejoin the tail when it
    // reads as one amount with thousands separators.
    let cells = raw;
    if (cells.length > 3) {
      const tail = cells.slice(2).join(",");
      if (parseDollars(tail) !== null) cells = [cells[0], cells[1], tail];
    }
    const name = cells[0] ?? "";
    const where = name ? `Line ${line} (${name})` : `Line ${line}`;
    if (!name) { errors.push(`${where}: missing name. Skipped.`); continue; }
    if (cells.length > 3) {
      errors.push(`${where}: ${cells.length} columns, expected name, spins, amount. Put a name with a comma in "quotes". Skipped.`);
      continue;
    }
    const spinsRaw = cells[1] ?? "";
    const spins = parseSpins(spinsRaw);
    if (spinsRaw === "" || spins === null) { errors.push(`${where}: spins must be a whole number, got "${spinsRaw}". Skipped.`); continue; }
    if (spins < 0) { errors.push(`${where}: spins can't be negative (${spinsRaw}). Skipped.`); continue; }
    if (spins > MAX_SPINS) { errors.push(`${where}: at most ${MAX_SPINS.toLocaleString("en-US")} spins per fan. Skipped.`); continue; }

    let amountCents: number | undefined;
    const amountRaw = cells[2] ?? "";
    if (amountRaw !== "") {
      const cents = parseDollars(amountRaw);
      if (cents === null) { errors.push(`${where}: amount must be dollars like 25 or $1,200.50, got "${amountRaw}". Skipped.`); continue; }
      if (cents < 0) { errors.push(`${where}: amount can't be negative (${amountRaw}). Skipped.`); continue; }
      if (cents > MAX_DOLLARS * 100) { errors.push(`${where}: amount can be at most $${MAX_DOLLARS.toLocaleString("en-US")}. Skipped.`); continue; }
      amountCents = cents;
    }

    const key = normName(name);
    const earlier = seen.get(key);
    if (earlier !== undefined) warnings.push(`${where}: same name as line ${earlier}. This creates a second fan.`);
    else if (existing.has(key)) warnings.push(`${where}: you already have a fan named “${existing.get(key)}”. This creates a second fan, not a top-up.`);
    if (earlier === undefined) seen.set(key, line);
    rows.push({ name, spins, amountCents });
  }

  if (rows.length > MAX_IMPORT_ROWS) warnings.push(`Only the first ${MAX_IMPORT_ROWS} rows will be imported (cap reached).`);
  return { rows: rows.slice(0, MAX_IMPORT_ROWS), errors, warnings, skippedHeader };
}
