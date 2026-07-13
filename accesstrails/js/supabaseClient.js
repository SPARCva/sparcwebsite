// Configured Supabase client for the Access Trails "Contribute a Park Review"
// form. No build step — the project URL and ANON/PUBLIC key are pasted here.
// The anon key is SAFE in the browser (that is its purpose); Row Level Security
// (see accesstrails/supabase/migrations/0002_rls.sql) is what protects the data.
// NEVER put the service-role key here. See accesstrails/.env.example.
//
// Reuses SPARC's existing Supabase project (same one the /access tool uses).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://ldxpockcgcxvsrbyhcnt.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_3tn2UadRVekIf5Pw6F5z-A_40ZbdvTm';

// Table + Storage bucket the Contribute form writes to.
export const SUBMISSIONS_TABLE = 'access_trails_submissions';
export const SUBMISSIONS_BUCKET = 'access-trails-submissions';

// GATE: keep false until the proposed migrations in
// accesstrails/supabase/migrations/ have been REVIEWED, APPROVED, and applied.
// While false, the form validates fully but does not attempt a write; it shows
// an honest "not accepting online submissions yet" notice with an email
// fallback. Flip to true once the table + bucket + RLS exist.
export const SUBMISSIONS_ENABLED = false;

// Fallback contact shown while submissions are disabled.
export const FALLBACK_EMAIL = 'debi@sparcsolutions.org';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
