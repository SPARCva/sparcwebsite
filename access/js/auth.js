// Magic-link sign-in + session guard for the Team Console.
//
// Only the admin console uses auth. The public page never imports this.
import { supabase } from './supabaseClient.js';

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Send a magic sign-in link. The link returns the user to this same page,
// where detectSessionInUrl (see supabaseClient.js) completes the sign-in.
export async function sendMagicLink(email) {
  const redirectTo = window.location.origin + window.location.pathname;
  return supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  });
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.reload();
}

// Calls cb(session) now (after resolving any link in the URL) and again on
// every future auth state change.
export function onAuth(cb) {
  supabase.auth.onAuthStateChange((_event, session) => cb(session));
  getSession().then(cb);
}
