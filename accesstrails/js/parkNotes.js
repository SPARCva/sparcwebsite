// Per-page accessibility notes: feed + submission form, embedded on every
// SPARC-center page and every park page. This is the Access Trails
// counterpart of the /ART report form + community board, scoped to the page:
//   <div id="at-park-notes" data-location="arlington"
//        data-park="bluemont" data-park-name="Bluemont Park"></div>
// Notes come from both the public and the SPARC team (a signed-in roster
// member posts as "SPARC Team"), and appear the moment they're posted.
import { CommunityData } from './dataLayer.public.js';
import { renderNoteForm, esc } from './noteForm.js';
import { noteCard } from './noteCard.js';
import { getSession, getRole } from './auth.js';

const host = document.getElementById('at-park-notes');
if (host) init(host);

async function init(el) {
  const location = el.dataset.location || null;
  const park = el.dataset.park || null;
  const parkName = el.dataset.parkName || '';
  const scopeLabel = park ? parkName : 'the parks on this page';

  el.innerHTML = `
    <h2 id="at-notes-heading">Accessibility Notes from the SPARC Team &amp; Community</h2>
    <p class="at-lead" style="font-size:1.05rem">Detailed, up-to-date notes about what's accessible at ${esc(scopeLabel)} — added by SPARC team members in the field and by people like you. Know something that would help the next visitor? Add it below; it appears here right away.</p>
    <p id="at-notes-status" role="status" aria-live="polite" class="at-muted">Loading notes…</p>
    <div id="at-notes-list" class="at-note-list"></div>
    <p style="margin-top:18px">
      <button type="button" class="at-submit" id="at-notes-toggle" aria-expanded="false" aria-controls="at-notes-formwrap">Add an accessibility note</button>
    </p>
    <div id="at-notes-formwrap" hidden></div>`;

  const statusEl = el.querySelector('#at-notes-status');
  const listEl = el.querySelector('#at-notes-list');
  const toggle = el.querySelector('#at-notes-toggle');
  const formWrap = el.querySelector('#at-notes-formwrap');

  async function loadFeed() {
    try {
      const rows = await CommunityData.getFor({ location, park });
      if (!rows.length) {
        statusEl.textContent = 'No notes yet — be the first to add what you know.';
        listEl.innerHTML = '';
        return;
      }
      statusEl.textContent = `${rows.length} note${rows.length === 1 ? '' : 's'}.`;
      listEl.innerHTML = rows.map(r => noteCard(r, { showPark: !park })).join('');
    } catch (e) {
      console.error('[parkNotes] feed failed:', e);
      statusEl.textContent = 'Sorry — accessibility notes could not be loaded right now.';
    }
  }

  let formBuilt = false;
  toggle.addEventListener('click', async () => {
    const open = formWrap.hidden;
    formWrap.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !formBuilt) {
      formBuilt = true;
      // Staff who are signed in to the Team Console post as SPARC Team.
      let staff = null;
      try {
        const session = await getSession();
        if (session && session.user && session.user.email) {
          const role = await getRole();
          if (role) staff = { email: session.user.email, role };
        }
      } catch (e) { /* not signed in — post as public */ }
      renderNoteForm(formWrap, {
        location, parkSlug: park, parkName, staff,
        onSubmitted: loadFeed,
      });
      const first = formWrap.querySelector('input, select, textarea');
      if (first) first.focus();
    }
  });

  await loadFeed();
}
