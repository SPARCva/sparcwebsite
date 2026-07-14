// Shared accessibility-note form — the Access Trails counterpart of the /ART
// report form. Used three ways:
//   - embedded on each SPARC-center page (park picker for that area)
//   - embedded on each park page (park pre-selected)
//   - in the Team Console ("Add a field note", posts as SPARC Team)
// Mirrors /ART behavior: grouped type picker with hints, plain-language
// description, optional photo + contact, honeypot + client rate limit, and
// INSTANT display — the note appears on the public page the moment it's sent.
import {
  supabase, SUBMISSIONS_TABLE, SUBMISSIONS_BUCKET, FALLBACK_EMAIL,
} from './supabaseClient.js';
import { LOCATIONS, parksFor, FEATURE_GROUPS, FIND_TYPES } from './catalog.js';

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function featureFieldset(prefix) {
  const groups = FEATURE_GROUPS.map(g => {
    const items = g.items.map(t => `
        <label class="at-typecard">
          <input type="radio" name="feature_type" value="${esc(t.id)}" required>
          <span class="at-typecard-label">${esc(t.label)}</span>
          ${t.hint ? `<span class="at-typecard-hint">${esc(t.hint)}</span>` : ''}
        </label>`).join('');
    return `${g.group ? `<h4 class="at-typegroup">${esc(g.group)}</h4>` : ''}
      <div class="at-typegrid">${items}</div>`;
  }).join('');
  return `<fieldset class="at-fieldset">
      <legend>1. Which part of the park is it about? <span class="at-req" aria-hidden="true">*</span></legend>
      ${groups}
      <p class="at-error" id="${prefix}-feature_type-err" hidden>Please choose the part of the park your note is about.</p>
    </fieldset>`;
}

function findFieldset(prefix) {
  const radios = FIND_TYPES.map(f => `
      <label class="at-choice"><input type="radio" name="find_type" value="${esc(f.value)}" required> ${esc(f.label)}</label>`).join('');
  return `<fieldset class="at-fieldset">
      <legend>2. Is it working, or does it need work? <span class="at-req" aria-hidden="true">*</span></legend>
      ${radios}
      <p class="at-error" id="${prefix}-find_type-err" hidden>Please choose one option.</p>
    </fieldset>`;
}

function parkField(prefix, { location, parkSlug, parkName }) {
  if (parkSlug) {
    return `<input type="hidden" name="park_slug" value="${esc(parkSlug)}">
      <input type="hidden" name="park_name" value="${esc(parkName)}">`;
  }
  const opts = parksFor(location).map(p => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('');
  const areaName = LOCATIONS[location] ? LOCATIONS[location].name : 'this area';
  return `<div class="at-field">
      <label for="${prefix}-park">Which park? <span class="at-req" aria-hidden="true">*</span></label>
      <select class="at-select" id="${prefix}-park" name="park_pick" required aria-describedby="${prefix}-park-err">
        <option value="">Choose a park…</option>
        ${opts}
        <option value="__other">Another park near ${esc(areaName)}</option>
      </select>
      <input class="at-input" type="text" id="${prefix}-park-other" name="park_other"
             placeholder="Park name and city" aria-label="Other park name and city" hidden style="margin-top:10px">
      <p class="at-error" id="${prefix}-park-err" hidden>Please choose a park (or name one).</p>
    </div>`;
}

/**
 * Render the form into containerEl and wire it up.
 * opts: {
 *   location   — 'alexandria' | 'arlington' | 'leesburg' | 'mclean' (required)
 *   parkSlug   — pre-selected park slug, or null (center pages / console)
 *   parkName   — display name matching parkSlug
 *   staff      — { email, role } when posting as SPARC Team, else null
 *   heading    — optional heading text override
 *   onSubmitted(row) — called after a successful insert
 * }
 */
export function renderNoteForm(containerEl, opts) {
  const prefix = 'atn';
  const staffNote = opts.staff
    ? `<p class="at-formmsg at-formmsg--ok" style="margin-bottom:18px">Posting as <strong>SPARC Team</strong> (${esc(opts.staff.email)}). Your note appears on the public page right away, labeled “SPARC Team.”</p>`
    : '';
  const contactBlock = opts.staff ? '' : `
      <div class="at-field">
        <label for="${prefix}-name">Your name <span class="at-muted">(optional — never shown publicly)</span></label>
        <input class="at-input" type="text" id="${prefix}-name" name="reporter_name" autocomplete="name">
      </div>
      <div class="at-field">
        <label for="${prefix}-contact">Email or phone <span class="at-muted">(optional — only if SPARC may follow up)</span></label>
        <input class="at-input" type="text" id="${prefix}-contact" name="contact_detail" autocomplete="email">
      </div>`;
  containerEl.innerHTML = `
    <div id="${prefix}-status" role="status" aria-live="polite"></div>
    <form class="at-form at-noteform" id="${prefix}-form" novalidate>
      ${staffNote}
      ${featureFieldset(prefix)}
      ${findFieldset(prefix)}
      ${parkField(prefix, opts)}
      <div class="at-field">
        <label for="${prefix}-description">3. Describe it in detail <span class="at-req" aria-hidden="true">*</span></label>
        <span class="at-hint">What's there, and what does it help you do — or stop you from doing? Say it the way you'd tell a friend.</span>
        <textarea class="at-textarea" id="${prefix}-description" name="description" required
                  aria-describedby="${prefix}-description-err"></textarea>
        <p class="at-error" id="${prefix}-description-err" hidden>Please add a short description.</p>
      </div>
      <div class="at-field">
        <label for="${prefix}-photo">Photo <span class="at-muted">(optional, max 20 MB)</span></label>
        <input class="at-input" type="file" id="${prefix}-photo" name="photo" accept="image/*"
               aria-describedby="${prefix}-photo-err">
        <p class="at-error" id="${prefix}-photo-err" hidden>Please choose an image under 20 MB.</p>
      </div>
      ${contactBlock}
      <div class="at-honey" aria-hidden="true">
        <label>Leave this field empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
      </div>
      <p class="at-hint">Your note appears on this page right away. SPARC reviews notes and may remove anything off-topic. Names and contact details are never shown publicly.</p>
      <button class="at-submit" type="submit">Post my note</button>
    </form>`;

  const form = containerEl.querySelector(`#${prefix}-form`);
  const statusEl = containerEl.querySelector(`#${prefix}-status`);

  const parkPick = form.querySelector('[name="park_pick"]');
  if (parkPick) {
    parkPick.addEventListener('change', () => {
      const other = form.querySelector('[name="park_other"]');
      other.hidden = parkPick.value !== '__other';
      if (other.hidden) other.value = '';
    });
  }

  function setErr(id, show) {
    const el = containerEl.querySelector(`#${prefix}-${id}-err`);
    if (el) el.hidden = !show;
  }
  function showStatus(kind, html) {
    statusEl.innerHTML = `<div class="at-formmsg at-formmsg--${kind}">${html}</div>`;
    statusEl.scrollIntoView({ block: 'nearest' });
  }

  function rateLimited() {
    try {
      const last = +localStorage.getItem('at_note_last') || 0;
      if (Date.now() - last < 30000) return true;
      localStorage.setItem('at_note_last', String(Date.now()));
    } catch (e) { /* localStorage blocked — ignore */ }
    return false;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (form.website && form.website.value) { showStatus('ok', 'Thank you!'); form.reset(); return; }

    let ok = true, focusEl = null;
    const need = (cond, id, el) => { setErr(id, !cond); if (!cond) { ok = false; if (!focusEl) focusEl = el; } };
    need(form.querySelector('[name="feature_type"]:checked'), 'feature_type', form.querySelector('[name="feature_type"]'));
    need(form.querySelector('[name="find_type"]:checked'), 'find_type', form.querySelector('[name="find_type"]'));
    let parkSlug = opts.parkSlug || null;
    let parkName = opts.parkName || '';
    if (parkPick) {
      if (parkPick.value === '__other') {
        parkSlug = null;
        parkName = form.park_other.value.trim();
        need(!!parkName, 'park', form.park_other);
      } else {
        parkSlug = parkPick.value || null;
        parkName = parkPick.value ? parkPick.options[parkPick.selectedIndex].text : '';
        need(!!parkSlug, 'park', parkPick);
      }
    }
    need(form.description.value.trim(), 'description', form.description);
    const photo = form.photo.files[0];
    need(!photo || photo.size <= 20 * 1024 * 1024, 'photo', form.photo);
    if (!ok) {
      showStatus('err', 'Please fix the highlighted fields and try again.');
      if (focusEl && focusEl.focus) focusEl.focus();
      return;
    }
    if (rateLimited()) {
      showStatus('err', 'You just posted a note. Please wait a moment before sending another.');
      return;
    }

    const contact = opts.staff ? '' : (form.contact_detail ? form.contact_detail.value.trim() : '');
    const name = opts.staff ? '' : (form.reporter_name ? form.reporter_name.value.trim() : '');
    const [first, ...rest] = name.split(/\s+/);
    const payload = {
      find_type: form.find_type.value,
      feature_type: form.feature_type.value,
      park_name: parkName,
      description: form.description.value.trim(),
      location_slug: opts.location || null,
      park_slug: parkSlug,
      source: opts.staff ? 'team' : 'public',
      submitted_by: opts.staff ? opts.staff.email : null,
      status: opts.staff ? 'reviewed' : 'new',
      may_contact: !!contact,
      reporter_first: first || null,
      reporter_last: rest.join(' ') || null,
      contact_method: contact ? (contact.includes('@') ? 'Email' : 'Phone call') : null,
      contact_detail: contact || null,
    };

    const btn = form.querySelector('.at-submit');
    btn.disabled = true; btn.textContent = 'Posting…';
    try {
      let photo_paths = null;
      if (photo) {
        const safe = photo.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${Date.now()}-${Math.round(performance.now())}-${safe}`;
        const up = await supabase.storage.from(SUBMISSIONS_BUCKET).upload(path, photo, { upsert: false });
        if (up.error) throw up.error;
        photo_paths = [path];
      }
      // No .select(): anon has no SELECT policy on the base table, and
      // PostgREST would reject the whole insert if we asked for RETURNING.
      const { error } = await supabase.from(SUBMISSIONS_TABLE)
        .insert({ ...payload, photo_paths });
      if (error) throw error;
      form.reset();
      if (parkPick) form.park_other.hidden = true;
      showStatus('ok', '<strong>Your note is live.</strong> It now appears in the accessibility notes on this page — thank you for making this guide better.');
      if (opts.onSubmitted) opts.onSubmitted();
    } catch (err) {
      console.error('[noteForm] submission failed:', err);
      showStatus('err',
        'Sorry — something went wrong posting your note. Please try again, or email ' +
        '<a href="mailto:' + FALLBACK_EMAIL + '">' + FALLBACK_EMAIL + '</a>.');
    } finally {
      btn.disabled = false; btn.textContent = 'Post my note';
    }
  });
}
