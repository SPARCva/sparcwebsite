// Public "Community Submissions" page: shows submissions SPARC staff have
// published (shown_publicly = true), via the PII-safe view. No personal data.
import { PublicData } from './dataLayer.public.js';

const listEl = document.getElementById('at-sub-list');
const statusEl = document.getElementById('at-sub-status');
if (listEl) load();

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function load() {
  try {
    const rows = await PublicData.getPublished();
    if (!rows.length) {
      statusEl.textContent = 'No community submissions have been published yet. Be the first to contribute one!';
      return;
    }
    statusEl.textContent = `${rows.length} community submission${rows.length === 1 ? '' : 's'}.`;
    listEl.innerHTML = rows.map(card).join('');
  } catch (e) {
    console.error('[submissions] load failed:', e);
    statusEl.textContent = 'Sorry — we could not load community submissions right now.';
  }
}

function card(r) {
  const img = r.photos && r.photos[0]
    ? `<img src="${esc(r.photos[0])}" alt="Photo submitted for ${esc(r.park_name)}" loading="lazy" decoding="async">` : '';
  const type = r.find_type ? `<p class="at-badge at-badge--partially-accessible" style="border-radius:6px">${esc(r.find_type)}</p>` : '';
  return `<article class="at-park-card">
      ${img}
      <div class="at-park-card-body">
        <h3>${esc(r.park_name)}</h3>
        ${type}
        <p>${esc(r.description)}</p>
      </div>
    </article>`;
}
