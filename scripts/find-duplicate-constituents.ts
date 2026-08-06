/**
 * find-duplicate-constituents.ts — Phase 0 duplicate worklist (build brief §3.4).
 *
 * Rebuilds the merge worklist from the read-only snap_* snapshot (via the
 * crm_build_duplicate_candidates() DB function) and exports it to CSV sheets
 * for Erica to work top-down in Bloomerang's own merge UI.
 *
 * It makes ZERO Bloomerang API calls and writes NOTHING to Bloomerang. Its only
 * writes are to the crm_duplicate_candidate table (via the DB function); the
 * CSV export is read-only. Merging is always a manual, human, UI-only action —
 * this script produces worklists, never merges (§1.6).
 *
 * A cluster = 2+ constituent accounts sharing an exact email. Tiers:
 *   primary                same normalized name, same Type, all active — merge.
 *   low_confidence          near-miss name / mixed Type / plus-tag variant — review.
 *   spouse                  different people who cohabit — NOT a merge.
 *   shared_mailbox_review   office/gov shared mailbox — NOT a merge.
 *
 * Usage:
 *   SUPABASE_URL=https://ldxpockcgcxvsrbyhcnt.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx tsx find-duplicate-constituents.ts
 *
 * Env:
 *   SUPABASE_URL               project URL (required)
 *   SUPABASE_SERVICE_ROLE_KEY  service-role key (required; snap_* is service-role only)
 *   OUTPUT_DIR                 directory for the CSV sheets (default ./dedupe-output)
 *   SKIP_REBUILD               if "1", export the existing table without rebuilding
 */

import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "./dedupe-output";
const SKIP_REBUILD = process.env.SKIP_REBUILD === "1";

const HEADER_NOTE =
  "Merges cannot be undone. Export a full backup from Bloomerang Settings " +
  "before starting. Work top-down.";

// One CSV per tier. primary is the worklist to act on; low_confidence needs a
// careful human look; spouse and shared_mailbox_review are surfaced so Erica
// knows they were considered and deliberately excluded from merging.
const TIER_FILES: Record<string, string> = {
  primary: "01-primary-merge-worklist.csv",
  low_confidence: "02-low-confidence-review.csv",
  spouse: "03-spouse-family-do-not-merge.csv",
  shared_mailbox_review: "04-shared-mailbox-do-not-merge.csv",
};

const COLUMNS = [
  "cluster_id",
  "record_count",
  "normalized_name",
  "shared_email",
  "account_numbers",
  "recommended_survivor",
  "survivor_rationale",
  "flags",
  "lifetime_giving_combined",
  "crm_urls",
] as const;

interface Candidate {
  cluster_id: string;
  tier: string;
  record_count: number;
  normalized_name: string | null;
  shared_email: string | null;
  account_numbers: number[];
  recommended_survivor: number | null;
  survivor_rationale: string | null;
  flags: string[];
  lifetime_giving_combined: number | null;
  crm_urls: string[] | null;
}

/** RFC-4180 CSV escaping. */
function csvCell(v: unknown): string {
  let s: string;
  if (v == null) s = "";
  else if (Array.isArray(v)) s = v.join(" | ");
  else s = String(v);
  if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Sort within a sheet: unflagged first, then same_household, then otherwise
 * flagged (§3.4); ties broken by combined lifetime giving (highest first, so
 * the highest-stakes clusters sit near the top).
 */
function sortKey(c: Candidate): [number, number] {
  const f = c.flags ?? [];
  let rank: number;
  if (f.length === 0) rank = 0;
  else if (f.length === 1 && f[0] === "same_household") rank = 1;
  else rank = 2;
  return [rank, -(c.lifetime_giving_combined ?? 0)];
}

function toCsv(rows: Candidate[]): string {
  const lines: string[] = [];
  lines.push(csvCell(HEADER_NOTE)); // note row (single cell) for whoever opens it
  lines.push(""); // blank spacer row
  lines.push(COLUMNS.join(","));
  const sorted = [...rows].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
  for (const r of sorted) {
    lines.push(COLUMNS.map((c) => csvCell((r as Record<string, unknown>)[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  if (!SKIP_REBUILD) {
    console.log("Rebuilding worklist from snapshot (crm_build_duplicate_candidates)…");
    const { data, error } = await supabase.rpc("crm_build_duplicate_candidates");
    if (error) throw new Error(`crm_build_duplicate_candidates failed: ${error.message}`);
    for (const row of (data ?? []) as { tier: string; clusters: number }[]) {
      console.log(`  ${row.tier}: ${row.clusters}`);
    }
  }

  const { data, error } = await supabase
    .from("crm_duplicate_candidate")
    .select("*")
    .order("cluster_id");
  if (error) throw new Error(`select crm_duplicate_candidate failed: ${error.message}`);
  const all = (data ?? []) as Candidate[];

  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const [tier, file] of Object.entries(TIER_FILES)) {
    const rows = all.filter((c) => c.tier === tier);
    writeFileSync(join(OUTPUT_DIR, file), toCsv(rows));
    console.log(`  wrote ${rows.length.toString().padStart(3)} → ${file}`);
  }

  const known = new Set(Object.keys(TIER_FILES));
  const other = all.filter((c) => !known.has(c.tier));
  if (other.length) console.warn(`  ! ${other.length} rows with an unexpected tier were not exported`);

  console.log(
    `Done. ${all.length} clusters across ${Object.keys(TIER_FILES).length} sheets in ${OUTPUT_DIR}.`,
  );
}

main().catch((e) => {
  console.error(`\nWorklist build failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
