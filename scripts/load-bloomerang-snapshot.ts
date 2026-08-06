/**
 * load-bloomerang-snapshot.ts — Phase 0 snapshot loader (build brief §3.2).
 *
 * Loads a Bloomerang CSV export (the folder Erica exports from Bloomerang and
 * downloads locally — e.g. "DataExport-2026-08-06", Drive id
 * 1h_469LwkMKNMs1_eI0k4oqCuvP2uTJY7) into the read-only snap_* reference
 * tables, then rebuilds the sender map / collision tables (§3.3).
 *
 * It is a truncate-and-reload: every run starts by calling snap_reset(), so it
 * is safe to re-run and is exactly what the pre-Phase-3 refresh (§3.2) uses.
 *
 * This writes ONLY to Supabase snap_ and crm_sender_ tables. It never touches
 * Bloomerang. All snap_ tables are service-role only under RLS, so this must
 * run with the service-role key.
 *
 * Usage:
 *   EXPORT_DIR=./DataExport-2026-08-06 \
 *   SUPABASE_URL=https://ldxpockcgcxvsrbyhcnt.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx tsx load-bloomerang-snapshot.ts
 *
 *   # Parse + map + report only, no DB connection, no writes:
 *   EXPORT_DIR=./DataExport-2026-08-06 npx tsx load-bloomerang-snapshot.ts --dry-run
 *
 * Env:
 *   EXPORT_DIR                 directory containing the exported *.csv (required)
 *   SUPABASE_URL               project URL (required unless --dry-run)
 *   SUPABASE_SERVICE_ROLE_KEY  service-role key (required unless --dry-run)
 *   SNAPSHOT_DATE              YYYY-MM-DD stamped on every row (default: today)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const EXPORT_DIR = process.env.EXPORT_DIR ?? "";
const SNAPSHOT_DATE =
  process.env.SNAPSHOT_DATE ?? new Date().toISOString().slice(0, 10);
const BATCH = 500;

type Row = Record<string, string>;

// --- field coercion helpers ------------------------------------------------

/** Bloomerang exports booleans as the literal strings "True"/"False". */
function bool(v: string | undefined): boolean {
  return (v ?? "").trim().toLowerCase() === "true";
}

function num(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: string | undefined): number | null {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}

function str(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Bloomerang dates look like "12/2/2011 12:00:00 AM" (M/D/YYYY, 12-hour clock)
 * or occasionally a bare "M/D/YYYY". Returns an ISO 8601 string, or null.
 * Parsed explicitly rather than via Date.parse so M/D ordering is never
 * mistaken for D/M.
 */
function usDateTime(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  const m = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?)?/i,
  );
  if (!m) return null;
  const [, mo, d, y, hh, mm, ss, ap] = m;
  let hour = hh ? parseInt(hh, 10) : 0;
  if (ap) {
    const upper = ap.toUpperCase();
    if (upper === "PM" && hour !== 12) hour += 12;
    if (upper === "AM" && hour === 12) hour = 0;
  }
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(parseInt(y, 10), 4)}-${p(parseInt(mo, 10))}-${p(parseInt(d, 10))}` +
    `T${p(hour)}:${p(mm ? parseInt(mm, 10) : 0)}:${p(ss ? parseInt(ss, 10) : 0)}`
  );
}

/** Date-only (YYYY-MM-DD) form of a Bloomerang date, or null. */
function usDate(v: string | undefined): string | null {
  const iso = usDateTime(v);
  return iso ? iso.slice(0, 10) : null;
}

// --- table configs ---------------------------------------------------------
// Each maps one export CSV to one snap_* table. `transform` turns parsed rows
// into records ready to insert (usually 1:1; households expand). `pk`, when
// set, is de-duplicated client-side so a repeated natural key never aborts a
// batch. Every record carries `raw` (the full CSV row) and `snapshot_date`.

interface TableConfig {
  file: string;
  table: string;
  pk?: string;
  transform: (rows: Row[]) => Record<string, unknown>[];
}

const withMeta = (rec: Record<string, unknown>, raw: Row) => ({
  ...rec,
  raw,
  snapshot_date: SNAPSHOT_DATE,
});

const CONFIGS: TableConfig[] = [
  {
    file: "Constituents.csv",
    table: "snap_constituents",
    pk: "account_number",
    transform: (rows) =>
      rows.map((r) =>
        withMeta(
          {
            account_number: int(r["AccountNumber"]),
            constituent_type: str(r["Type"]),
            status: str(r["Status"]),
            is_inactive: (str(r["Status"]) ?? "").toLowerCase() === "inactive",
            is_deceased: (str(r["Status"]) ?? "").toLowerCase() === "deceased",
            first_name: str(r["First"]),
            middle_name: str(r["Middle"]),
            last_name: str(r["Last"]),
            full_name: str(r["FullName"]),
            organization_name:
              str(r["Type"])?.toLowerCase() === "organization"
                ? str(r["FullName"])
                : null,
            role_at_sparc: str(r["Custom: Role at SPARC"]),
            created_date: usDateTime(r["CreatedDate"]),
          },
          r,
        ),
      ),
  },
  {
    file: "Emails.csv",
    table: "snap_emails",
    transform: (rows) =>
      rows.map((r) =>
        withMeta(
          {
            account_number: int(r["AccountNumber"]),
            email: str(r["Value"]),
            email_type: str(r["TypeName"]),
            is_primary: bool(r["IsPrimary"]),
          },
          r,
        ),
      ),
  },
  {
    file: "Phones.csv",
    table: "snap_phones",
    transform: (rows) =>
      rows.map((r) =>
        withMeta(
          {
            account_number: int(r["AccountNumber"]),
            number: str(r["Number"]),
            phone_type: str(r["TypeName"]),
            is_primary: bool(r["IsPrimary"]),
          },
          r,
        ),
      ),
  },
  {
    file: "Addresses.csv",
    table: "snap_addresses",
    transform: (rows) =>
      rows.map((r) =>
        withMeta(
          {
            account_number: int(r["AccountNumber"]),
            street: str(r["Street"]),
            city: str(r["City"]),
            state: str(r["State"]),
            postal_code: str(r["PostalCode"]),
            country: str(r["Country"]),
            address_type: str(r["TypeName"]),
            is_primary: bool(r["IsPrimary"]),
          },
          r,
        ),
      ),
  },
  {
    // Households are keyed by the household's own AccountNumber, with a Head
    // account and a pipe-delimited Members list. Expand to one row per member
    // account so the dedupe spouse/household guard (§3.4) can ask "are these
    // two accounts in the same household?".
    file: "Households.csv",
    table: "snap_households",
    transform: (rows) => {
      const out: Record<string, unknown>[] = [];
      for (const r of rows) {
        const householdId = int(r["AccountNumber"]);
        const head = int(r["Head"]);
        const members = (r["Members"] ?? "")
          .split("|")
          .map((s) => int(s))
          .filter((n): n is number => n != null);
        const all = new Set<number>(members);
        if (head != null) all.add(head);
        const name = str(r["FullName"]);
        for (const acct of all) {
          out.push(
            withMeta(
              {
                household_id: householdId,
                account_number: acct,
                household_name: name,
                is_head: acct === head,
              },
              r,
            ),
          );
        }
      }
      return out;
    },
  },
  {
    file: "Relationships.csv",
    table: "snap_relationships",
    transform: (rows) =>
      rows.map((r) =>
        withMeta(
          {
            account_number: int(r["AccountNumber1"]),
            related_account_number: int(r["AccountNumber2"]),
            relationship_type: str(r["Role1"]),
          },
          r,
        ),
      ),
  },
  {
    file: "Transactions.csv",
    table: "snap_transactions",
    pk: "transaction_id",
    transform: (rows) =>
      rows.map((r) =>
        withMeta(
          {
            transaction_id: int(r["TransactionNumber"]),
            account_number: int(r["AccountNumber"]),
            transaction_type: null, // not present in Transactions.csv
            amount: num(r["Amount"]),
            transaction_date: usDate(r["Date"]),
            method: str(r["Method"]),
          },
          r,
        ),
      ),
  },
  {
    file: "Interactions.csv",
    table: "snap_interactions",
    pk: "interaction_id",
    transform: (rows) =>
      rows.map((r) =>
        withMeta(
          {
            interaction_id: int(r["Id"]),
            account_number: int(r["AccountNumber"]),
            subject: str(r["Subject"]),
            note: str(r["Note"]),
            channel: str(r["Channel"]),
            interaction_date: usDateTime(r["Date"]),
          },
          r,
        ),
      ),
  },
  {
    file: "Notes.csv",
    table: "snap_notes",
    pk: "note_id",
    transform: (rows) =>
      rows.map((r) =>
        withMeta(
          {
            note_id: int(r["Id"]),
            account_number: int(r["AccountNumber"]),
            note: str(r["Note"]),
            note_date: usDateTime(r["Date"]),
          },
          r,
        ),
      ),
  },
  {
    // FileAttachments.csv has no AccountNumber and no id column; attachments
    // link via InteractionId / NoteId / TaskId / TransactionNumber (all kept
    // in raw). Assign a surrogate id per row; account stays null. Novelty
    // checks (§7.5) only need the filename.
    file: "FileAttachments.csv",
    table: "snap_attachments",
    transform: (rows) =>
      rows.map((r, i) =>
        withMeta(
          {
            attachment_id: i + 1,
            account_number: null,
            filename: str(r["Name"]),
            note: str(r["Url"]),
          },
          r,
        ),
      ),
  },
  {
    // Tributes.csv has no id or AccountNumber; surrogate id, everything in raw.
    file: "Tributes.csv",
    table: "snap_tributes",
    transform: (rows) =>
      rows.map((r, i) =>
        withMeta({ tribute_id: i + 1, account_number: null }, r),
      ),
  },
];

// --- io ---------------------------------------------------------------------

/** Find a file in EXPORT_DIR case-insensitively (exports vary in casing). */
function findFile(name: string): string | null {
  const want = name.toLowerCase();
  for (const entry of readdirSync(EXPORT_DIR)) {
    if (entry.toLowerCase() === want) return join(EXPORT_DIR, entry);
  }
  return null;
}

function readRows(path: string): Row[] {
  const content = readFileSync(path, "utf8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    bom: true, // Bloomerang prepends a UTF-8 BOM
    relax_column_count: true, // tolerate an occasional trailing note row
    trim: false, // keep values verbatim; coercion helpers trim as needed
  }) as Row[];
}

function dedupe(
  records: Record<string, unknown>[],
  pk: string,
): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  const out: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const rec of records) {
    const key = rec[pk];
    if (key == null) {
      out.push(rec); // never drop rows with a null natural key
      continue;
    }
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    out.push(rec);
  }
  if (dropped > 0) {
    console.log(`    (de-duped ${dropped} row(s) on ${pk})`);
  }
  return out;
}

async function insertAll(
  supabase: SupabaseClient,
  table: string,
  records: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < records.length; i += BATCH) {
    const chunk = records.slice(i, i + BATCH);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) {
      throw new Error(
        `insert into ${table} failed at rows ${i}-${i + chunk.length}: ${error.message}`,
      );
    }
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  if (!EXPORT_DIR) {
    throw new Error("EXPORT_DIR is required (directory of exported *.csv).");
  }
  console.log(
    `Bloomerang snapshot load — export dir: ${EXPORT_DIR}, snapshot_date: ${SNAPSHOT_DATE}` +
      (DRY_RUN ? "  [DRY RUN — no DB connection, no writes]" : ""),
  );

  let supabase: SupabaseClient | null = null;
  if (!DRY_RUN) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (omit only with --dry-run).",
      );
    }
    supabase = createClient(url, key, { auth: { persistSession: false } });

    console.log("Truncating snap_* + sender tables (snap_reset)…");
    const { error } = await supabase.rpc("snap_reset");
    if (error) throw new Error(`snap_reset failed: ${error.message}`);
  }

  // Parse + map every table first so a bad file fails before any writes.
  const prepared = CONFIGS.map((cfg) => {
    const path = findFile(cfg.file);
    if (!path) {
      console.warn(`  ! ${cfg.file} not found in export dir — skipping`);
      return { cfg, records: [] as Record<string, unknown>[], missing: true };
    }
    const rows = readRows(path);
    let records = cfg.transform(rows);
    if (cfg.pk) records = dedupe(records, cfg.pk);
    console.log(
      `  ${cfg.file} → ${cfg.table}: ${rows.length} csv rows → ${records.length} records`,
    );
    if (DRY_RUN && records.length) {
      const sample = { ...records[0] } as Record<string, unknown>;
      delete sample.raw; // raw is the whole row; omit from the sample preview
      console.log(`      sample: ${JSON.stringify(sample)}`);
    }
    return { cfg, records, missing: false };
  });

  if (DRY_RUN) {
    console.log("Dry run complete — parsed and mapped, nothing written.");
    return;
  }

  for (const { cfg, records, missing } of prepared) {
    if (missing || !records.length) continue;
    process.stdout.write(`Loading ${cfg.table} (${records.length})… `);
    await insertAll(supabase!, cfg.table, records);
    console.log("done");
  }

  console.log("Seeding sender map / collisions (crm_seed_sender_map)…");
  const { data, error } = await supabase!.rpc("crm_seed_sender_map");
  if (error) throw new Error(`crm_seed_sender_map failed: ${error.message}`);
  const seed = Array.isArray(data) ? data[0] : data;
  console.log(
    `  sender_map: ${seed?.sender_count ?? "?"}, collisions: ${seed?.collision_count ?? "?"}`,
  );

  console.log("Snapshot load complete.");
}

main().catch((e) => {
  console.error(`\nLoad failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
