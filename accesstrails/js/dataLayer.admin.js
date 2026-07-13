// Full DataLayer for the Team Console (requires an authenticated staff session;
// RLS gates every call on access_role()). Handles submission triage and — for
// admins — the shared access_staff roster (add/remove authorized emails).
import { supabase, SUBMISSIONS_TABLE, SUBMISSIONS_BUCKET, ROSTER_TABLE } from './supabaseClient.js';

function photoUrls(paths) {
  return (paths || []).map(p => supabase.storage.from(SUBMISSIONS_BUCKET).getPublicUrl(p).data.publicUrl);
}

export const AdminData = {
  // Submissions --------------------------------------------------------------
  async list() {
    const { data, error } = await supabase
      .from(SUBMISSIONS_TABLE)
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(r => ({ ...r, photos: photoUrls(r.photo_paths) }));
  },

  async update(id, fields) {
    const { error } = await supabase.from(SUBMISSIONS_TABLE).update(fields).eq('id', id);
    if (error) throw error;
  },

  // Publish / unpublish, stamping shown_at.
  async setShown(id, shown) {
    return this.update(id, { shown_publicly: shown, shown_at: shown ? new Date().toISOString() : null });
  },
  async setStatus(id, status) { return this.update(id, { status }); },
  async setNote(id, team_note) { return this.update(id, { team_note: team_note || null }); },

  async remove(id) {
    const { error } = await supabase.from(SUBMISSIONS_TABLE).delete().eq('id', id);
    if (error) throw error;
  },

  // Roster (access_staff) — admins only (enforced by the "admin manages roster"
  // RLS policy; non-admins get an error, which the UI surfaces). ---------------
  async listRoster() {
    const { data, error } = await supabase
      .from(ROSTER_TABLE).select('email, role, display_name, added_at').order('role');
    if (error) throw error;
    return data || [];
  },

  async addPerson({ email, role, display_name }) {
    const { error } = await supabase.from(ROSTER_TABLE)
      .upsert({ email: email.trim().toLowerCase(), role, display_name: display_name || null },
              { onConflict: 'email' });
    if (error) throw error;
  },

  async removePerson(email) {
    const { error } = await supabase.from(ROSTER_TABLE).delete().eq('email', email);
    if (error) throw error;
  },
};
