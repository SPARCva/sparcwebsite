// Configured Supabase client for the Access Trails "Contribute a Park Review"
// form, the public Community Submissions page, and the staff Team Console.
// No build step — the project URL and ANON/PUBLIC key are pasted here.
// The anon key is SAFE in the browser (that is its purpose); Row Level Security
// protects the data. NEVER put the service-role key here. See .env.example.
//
// Reuses SPARC's existing Supabase project (the same one the /access tool uses),
// including its access_staff roster + access_role() staff-gating.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://ldxpockcgcxvsrbyhcnt.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_3tn2UadRVekIf5Pw6F5z-A_40ZbdvTm';

// Contribute form intake table, PII-safe public view, and photo bucket.
export const SUBMISSIONS_TABLE = 'access_trails_submissions';
export const PUBLIC_VIEW = 'access_trails_public';
export const SUBMISSIONS_BUCKET = 'access-trails-photos';
export const ROSTER_TABLE = 'access_staff';

// Backend is live (migration applied 2026-07). The public form accepts
// anonymous submissions; staff triage them in the Team Console.
export const SUBMISSIONS_ENABLED = true;

// Fallback contact shown if a submission fails.
export const FALLBACK_EMAIL = 'debi@sparcsolutions.org';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,       // needed for the Team Console magic-link session
    autoRefreshToken: true,
    detectSessionInUrl: true,   // completes magic-link sign-in on return
  },
});
