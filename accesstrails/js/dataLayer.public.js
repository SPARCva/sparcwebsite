// Read-only DataLayer for public pages (anon key). Reads the PII-safe
// instant-display access_trails_community view (mirrors the /ART community
// board): every non-archived, non-spam note, only non-personal columns —
// RLS and the view definition enforce that nothing personal is ever exposed.
import { supabase, COMMUNITY_VIEW, SUBMISSIONS_BUCKET } from './supabaseClient.js';

function withPhotos(rows) {
  return (rows || []).map(r => ({
    ...r,
    photos: (r.photo_paths || []).map(
      p => supabase.storage.from(SUBMISSIONS_BUCKET).getPublicUrl(p).data.publicUrl
    ),
  }));
}

export const CommunityData = {
  // Notes for one geographic page. Pass park to narrow to a single park page.
  async getFor({ location, park, limit = 100 } = {}) {
    let q = supabase
      .from(COMMUNITY_VIEW)
      .select('id, find_type, feature_type, park_name, description, photo_paths, location_slug, park_slug, source, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (location) q = q.eq('location_slug', location);
    if (park) q = q.eq('park_slug', park);
    const { data, error } = await q;
    if (error) throw error;
    return withPhotos(data);
  },

  // Everything, newest first — the Community Submissions board.
  async getAll(limit = 200) {
    const { data, error } = await supabase
      .from(COMMUNITY_VIEW)
      .select('id, find_type, feature_type, park_name, description, photo_paths, location_slug, park_slug, source, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return withPhotos(data);
  },
};
