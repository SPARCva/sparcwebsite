// Creates and exports the configured Supabase client.
//
// This is a no-build static site, so there is no server-side env injection at
// runtime. The two values below are the project URL and the ANON / PUBLIC key.
// The anon key is SAFE to expose in the browser — that is its purpose; RLS
// (see supabase/migrations/0002_rls.sql) is what actually protects the data.
//
// NEVER put the service-role key here. See .env.example and README.md.
//
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Configured for the SPARC "Steps Toward Access" project.
// Publishable (anon) key — safe in the browser; RLS protects the data.
const SUPABASE_URL = 'https://ldxpockcgcxvsrbyhcnt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_3tn2UadRVekIf5Pw6F5z-A_40ZbdvTm';

if (SUPABASE_URL.includes('YOUR-PROJECT')) {
  console.warn(
    '[Steps Toward Access] Supabase is not configured yet. ' +
    'Set SUPABASE_URL and SUPABASE_ANON_KEY in access/js/supabaseClient.js. ' +
    'See access/README.md.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
