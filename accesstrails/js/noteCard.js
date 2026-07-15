// Renders one community/team accessibility note as an article card.
// Shared by the per-page notes feed (parkNotes.js), the Community
// Submissions board (submissions.js), and the Team Console (console.js).
import { esc } from './noteForm.js';
import { FEATURE_LABEL, FIND_BADGE, LOCATIONS } from './catalog.js';

export function noteDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) { return ''; }
}

export function noteCard(r, { showPark = false } = {}) {
  const srcBadge = r.source === 'team'
    ? '<span class="at-notesrc at-notesrc--team">SPARC Team</span>'
    : '<span class="at-notesrc at-notesrc--community">Community</span>';
  const feature = r.feature_type
    ? `<span class="at-notechip">${esc(FEATURE_LABEL[r.feature_type] || r.feature_type)}</span>` : '';
  const find = r.find_type
    ? `<span class="at-badge at-badge--${FIND_BADGE[r.find_type] || 'partially-accessible'}" style="font-size:.8rem">${esc(r.find_type)}</span>` : '';
  const where = showPark && r.park_name
    ? `<p class="at-muted" style="margin:6px 0 0">${
        r.park_slug
          ? `<a href="/accesstrails/parks/${esc(r.park_slug)}/">${esc(r.park_name)}</a>`
          : esc(r.park_name)
      }${r.location_slug && LOCATIONS[r.location_slug] ? ` · ${esc(LOCATIONS[r.location_slug].name)}` : ''}</p>` : '';
  const photos = (r.photos || []).map(u =>
    `<img src="${esc(u)}" alt="Photo submitted with this accessibility note about ${esc(r.park_name)}" loading="lazy" decoding="async">`).join('');
  return `<article class="at-note-card">
      <div class="at-note-meta">${srcBadge}${feature}${find}<span class="at-note-date">${esc(noteDate(r.created_at))}</span></div>
      ${where}
      <p class="at-note-body">${esc(r.description)}</p>
      ${photos ? `<div class="at-note-photos">${photos}</div>` : ''}
    </article>`;
}
