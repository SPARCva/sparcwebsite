// Full CRUD DataLayer for the Team Console (requires an authenticated session).
//
// Keeps the exact object shape the console already consumes/produces:
//   {id,label,party,email,status,published,x,y,
//    photos:[{src,alt,caption}], events:[{when,dir,txt}]}
//
// `when` (front-end) maps to `when_label` (DB) inside this layer so the form
// code stays as-is.
import { supabase } from './supabaseClient.js';

const LOCATION_SELECT =
  'id,label,party,email,published,status,x,y,' +
  ' photos(src,alt,caption,sort), events(when_label,dir,txt,sort)';

function shape(l) {
  return {
    ...l,
    photos: [...l.photos].sort((a, b) => a.sort - b.sort)
      .map(p => ({ src: p.src, alt: p.alt, caption: p.caption || '' })),
    events: [...l.events].sort((a, b) => a.sort - b.sort)
      .map(e => ({ when: e.when_label, dir: e.dir, txt: e.txt })),
  };
}

export const DataLayer = {
  // Staff see everything, drafts included (no `published` filter).
  async getAll() {
    const { data, error } = await supabase
      .from('access_locations')
      .select(LOCATION_SELECT)
      .order('created_at');
    if (error) throw error;
    return data.map(shape);
  },

  // Upsert the location row, then replace its photos and events.
  // (Simplest correct approach: delete existing children, re-insert the
  //  current arrays with sort = index.)
  async save(loc) {
    const row = {
      id: loc.id,
      label: loc.label,
      party: loc.party,
      email: loc.email || null,
      status: loc.status,
      published: loc.published,
      x: loc.x,
      y: loc.y,
    };

    const { data: saved, error } = await supabase
      .from('access_locations')
      .upsert(row)
      .select('id')
      .single();
    if (error) throw error;
    const id = saved.id;

    // Replace children.
    const { error: dpe } = await supabase.from('access_photos').delete().eq('location_id', id);
    if (dpe) throw dpe;
    const { error: dee } = await supabase.from('access_events').delete().eq('location_id', id);
    if (dee) throw dee;

    if (loc.photos.length) {
      const { error: pe } = await supabase.from('access_photos').insert(
        loc.photos.map((p, i) => ({
          location_id: id,
          src: p.src,
          alt: p.alt,
          caption: p.caption || null,
          sort: i,
        }))
      );
      if (pe) throw pe;
    }

    if (loc.events.length) {
      const { error: ee } = await supabase.from('access_events').insert(
        loc.events.map((e, i) => ({
          location_id: id,
          when_label: e.when,
          dir: e.dir,
          txt: e.txt,
          sort: i,
        }))
      );
      if (ee) throw ee;
    }

    return { ...loc, id };
  },

  async remove(id) {
    // Best-effort Storage cleanup — photos are grouped under `${id}/`.
    try {
      const { data: files } = await supabase.storage.from('barrier-photos').list(id);
      if (files && files.length) {
        await supabase.storage
          .from('barrier-photos')
          .remove(files.map(f => `${id}/${f.name}`));
      }
    } catch (e) {
      console.warn('Storage cleanup failed (DB rows still cascade-deleted):', e);
    }
    // DB children cascade via the foreign keys.
    const { error } = await supabase.from('access_locations').delete().eq('id', id);
    if (error) throw error;
  },

  // Upload to Storage and return the public URL. Files are named
  // `${location_id}/${uuid}-${safeName}` so they group by location.
  async uploadPhoto(file, locationId) {
    const id = locationId || crypto.randomUUID();
    const safeName = (file.name || 'photo').replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${id}/${crypto.randomUUID()}-${safeName}`;
    const { error } = await supabase.storage
      .from('barrier-photos')
      .upload(path, file, { cacheControl: '3600', upsert: false });
    if (error) throw error;
    return supabase.storage.from('barrier-photos').getPublicUrl(path).data.publicUrl;
  },
};
