// Read-only DataLayer for the public page (uses the anon key).
//
// Returns barriers in the exact shape the public app already consumes:
//   {id,label,party,status,x,y,
//    photos:[{src,alt,caption}], events:[{when,dir,txt}]}
//
// The `published` filter below is belt-and-suspenders — Row Level Security
// also enforces that anon can only ever read published rows.
import { supabase } from './supabaseClient.js';

export const DataLayer = {
  async getLocations() {
    const { data, error } = await supabase
      .from('access_locations')
      .select('id,label,party,status,x,y, photos(src,alt,caption,sort), events(when_label,dir,txt,sort)')
      .eq('published', true)
      .order('created_at');
    if (error) throw error;
    return data.map(l => ({
      ...l,
      photos: l.photos.sort((a, b) => a.sort - b.sort),
      events: l.events
        .sort((a, b) => a.sort - b.sort)
        .map(e => ({ when: e.when_label, dir: e.dir, txt: e.txt })),
    }));
  },
};
