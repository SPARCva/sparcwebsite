// Public "Community Submissions" board — the Access Trails counterpart of the
// /ART community board. Instant display: every note posted anywhere on the
// guide (by the public or the SPARC team) appears here the moment it's sent,
// via the PII-safe access_trails_community view. Staff remove spam/off-topic
// notes from the Team Console (archive/spam), which hides them here.
import { CommunityData } from './dataLayer.public.js';
import { noteCard } from './noteCard.js';
import { LOCATIONS } from './catalog.js';

const listEl = document.getElementById('at-sub-list');
const statusEl = document.getElementById('at-sub-status');
const filterEl = document.getElementById('at-sub-filters');
let allRows = [];
let activeLoc = '';

if (listEl) init();

async function init() {
  if (filterEl) {
    const chips = [['', 'All areas'], ...Object.entries(LOCATIONS).map(([slug, l]) => [slug, l.name])];
    filterEl.innerHTML = chips.map(([v, label]) =>
      `<button type="button" class="at-chip${v === '' ? ' at-chip--on' : ''}" data-loc="${v}" aria-pressed="${v === ''}">${label}</button>`).join('');
    filterEl.addEventListener('click', e => {
      const btn = e.target.closest('[data-loc]');
      if (!btn) return;
      activeLoc = btn.dataset.loc;
      filterEl.querySelectorAll('.at-chip').forEach(c => {
        const on = c === btn;
        c.classList.toggle('at-chip--on', on);
        c.setAttribute('aria-pressed', String(on));
      });
      render();
    });
  }
  try {
    allRows = await CommunityData.getAll();
    render();
  } catch (e) {
    console.error('[submissions] load failed:', e);
    statusEl.textContent = 'Sorry — we could not load community submissions right now.';
  }
}

function render() {
  const rows = activeLoc ? allRows.filter(r => r.location_slug === activeLoc) : allRows;
  if (!rows.length) {
    statusEl.textContent = activeLoc
      ? `No notes for ${LOCATIONS[activeLoc].name} yet — be the first to contribute one!`
      : 'No community notes have been posted yet. Be the first to contribute one!';
    listEl.innerHTML = '';
    return;
  }
  statusEl.textContent = `${rows.length} note${rows.length === 1 ? '' : 's'}.`;
  listEl.innerHTML = rows.map(r => noteCard(r, { showPark: true })).join('');
}
