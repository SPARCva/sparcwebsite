// Email + password auth for the Team Console — mirrors the /ART app
// (signInWithPassword / signUp). No magic links, so NO email service (Resend)
// is required: sign-in sends no email, and this project has email confirmation
// disabled so first-time sign-up returns an active session immediately.
//
// Access is authorized separately: only emails on the access_staff roster
// (checked via access_role()) can read/triage anything — RLS enforces it.
import { supabase } from './supabaseClient.js';

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

// Current caller's Access role ('admin' | 'editor' | 'contributor' | '').
export async function getRole() {
  const { data, error } = await supabase.rpc('access_role');
  return error ? '' : (data || '');
}

export async function logIn(email, password) {
  return supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
}

// First-time users set their own password here. Works without email because
// email confirmation is disabled on this project (same as /ART).
export async function createPassword(email, password) {
  return supabase.auth.signUp({ email: email.trim().toLowerCase(), password });
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.reload();
}

export function onAuth(cb) {
  supabase.auth.onAuthStateChange((_e, session) => cb(session));
  getSession().then(cb);
}
