// Read-only DataLayer for the public Community Submissions page (anon key).
// Reads the PII-safe access_trails_public view (only staff-published rows,
// only non-personal columns). RLS + the view's WHERE shown_publicly enforce
// that nothing unpublished or personal is ever exposed here.
import { supabase, PUBLIC_VIEW, SUBMISSIONS_BUCKET } from './supabaseClient.js';

export const PublicData = {
  async getPublished() {
    const { data, error } = await supabase
      .from(PUBLIC_VIEW)
      .select('id, find_type, park_name, description, photo_paths, created_at, shown_at')
      .order('shown_at', { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) throw error;
    return (data || []).map(r => ({
      ...r,
      photos: (r.photo_paths || []).map(
        p => supabase.storage.from(SUBMISSIONS_BUCKET).getPublicUrl(p).data.publicUrl
      ),
    }));
  },
};
