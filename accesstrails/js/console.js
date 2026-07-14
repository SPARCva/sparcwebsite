// Access Trails Team Console — mirrors the /ART console for this guide:
//   • Community notes: triage queue with status tabs + area filter
//     (review, archive/spam to hide from the public pages, edit, delete)
//   • Add a field note: the team's own submission form (posts as SPARC Team,
//     live on the public pages immediately — like /ART console/submit)
//   • Team roster: admins manage the shared access_staff allow-list
// Email + password sign-in (signInWithPassword / signUp), no magic links, so
// no email service is needed. All access is gated by RLS on access_role();
// the UI just reflects what the DB allows.
import { onAuth, getRole, logIn, createPassword, signOut } from './auth.js';
import { AdminData } from './dataLayer.admin.js';
import { renderNoteForm, esc } from './noteForm.js';
import { LOCATIONS, FEATURE_LABEL } from './catalog.js';
import { noteDate } from './noteCard.js';

const authEl = document.getElementById('at-console-auth');
const appEl = document.getElementById('at-console-app');
const whoEl = document.getElementById('at-console-who');
const subsEl = document.getElementById('at-console-subs');
const tabsEl = document.getElementById('at-console-tabs');
const locsEl = document.getElementById('at-console-locs');
const submitPanel = document.getElementById('at-panel-submit');
const rosterWrap = document.getElementById('at-console-roster');
const rosterEl = document.getElementById('at-roster-list');
let currentRole = '';
let currentEmail = '';
let tab = 'new';
let locFilter = '';
let uiBuilt = false;

function toast(msg, ok = true) {
  const s = document.getElementById('at-console-status');
  s.className = 'at-formmsg at-formmsg--' + (ok ? 'ok' : 'err');
  s.textContent = msg;
  s.scrollIntoView({ block: 'nearest' });
}

// ---- sign in (email + password, like /ART) --------------------------------
const signinMsg = () => document.getElementById('at-signin-msg');
function creds() {
  return {
    email: document.getElementById('at-signin-email').value.trim(),
    password: document.getElementById('at-signin-password').value,
  };
}

document.getElementById('at-signin-form').addEventListener('submit', async e => {
  e.preventDefault();
  const { email, password } = creds();
  if (!email || !password) return;
  const { error } = await logIn(email, password);
  if (error) signinMsg().textContent = 'Could not sign in: ' + error.message + ' — first time here? Use "Create a password".';
  // success → onAuth fires and swaps the view.
});

document.getElementById('at-create-password').addEventListener('click', async () => {
  const { email, password } = creds();
  if (!email) { signinMsg().textContent = 'Enter your email first.'; return; }
  if (!password || password.length < 8) { signinMsg().textContent = 'Choose a password of at least 8 characters.'; return; }
  const { error } = await createPassword(email, password);
  if (error) {
    signinMsg().textContent = /registered|already/i.test(error.message)
      ? 'That email already has a password — log in above.'
      : 'Could not create the account: ' + error.message;
  } else {
    signinMsg().textContent = 'Password set. Signing you in…';
  }
});

document.getElementById('at-signout').addEventListener('click', signOut);

// ---- auth state -----------------------------------------------------------
onAuth(async session => {
  if (!session) { show(authEl); hide(appEl); return; }
  currentRole = await getRole();
  currentEmail = session.user.email;
  if (!currentRole) {
    authEl.querySelector('#at-signin-note').innerHTML =
      'You are signed in as <strong>' + esc(currentEmail) + '</strong> but that address is not on the Access Trails team roster. Ask an admin to add you.';
    show(authEl); hide(appEl);
    return;
  }
  whoEl.innerHTML = 'Signed in as <strong>' + esc(currentEmail) + '</strong> (' + esc(currentRole) + ')';
  hide(authEl); show(appEl);
  rosterWrap.hidden = currentRole !== 'admin';
  if (!uiBuilt) { buildFilters(); buildTeamSubmit(); uiBuilt = true; }
  await loadSubs();
  if (currentRole === 'admin') await loadRoster();
});
function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

// ---- triage: status tabs + area filter (mirrors /ART console/community) ----
const TABS = [['new', 'New'], ['reviewed', 'Reviewed'], ['archived', 'Archived'], ['spam', 'Spam']];

function buildFilters() {
  tabsEl.innerHTML = TABS.map(([v, l]) =>
    `<button type="button" role="tab" aria-selected="${v === tab}" class="at-chip${v === tab ? ' at-chip--on' : ''}" data-tab="${v}">${l}<span class="at-chip-count" data-count="${v}"></span></button>`).join('');
  tabsEl.addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    tabsEl.querySelectorAll('[data-tab]').forEach(c => {
      const on = c.dataset.tab === tab;
      c.classList.toggle('at-chip--on', on);
      c.setAttribute('aria-selected', String(on));
    });
    loadSubs();
  });
  const locChips = [['', 'All areas'], ...Object.entries(LOCATIONS).map(([s, l]) => [s, l.name]), ['none', 'No area set']];
  locsEl.innerHTML = locChips.map(([v, l]) =>
    `<button type="button" class="at-chip${v === '' ? ' at-chip--on' : ''}" data-loc="${v}" aria-pressed="${v === ''}">${l}</button>`).join('');
  locsEl.addEventListener('click', e => {
    const b = e.target.closest('[data-loc]');
    if (!b) return;
    locFilter = b.dataset.loc;
    locsEl.querySelectorAll('[data-loc]').forEach(c => {
      const on = c.dataset.loc === locFilter;
      c.classList.toggle('at-chip--on', on);
      c.setAttribute('aria-pressed', String(on));
    });
    loadSubs();
  });
}

async function refreshCounts() {
  try {
    const counts = await AdminData.counts();
    tabsEl.querySelectorAll('[data-count]').forEach(el => {
      const n = counts[el.dataset.count] || 0;
      el.textContent = n ? ` ${n}` : '';
    });
  } catch (e) { /* non-fatal */ }
}

async function loadSubs() {
  subsEl.setAttribute('aria-busy', 'true');
  try {
    let rows = await AdminData.list({ status: tab });
    if (locFilter === 'none') rows = rows.filter(r => !r.location_slug);
    else if (locFilter) rows = rows.filter(r => r.location_slug === locFilter);
    subsEl.innerHTML = rows.length ? rows.map(subRow).join('')
      : `<p class="at-muted">Nothing in “${TABS.find(([v]) => v === tab)[1]}”${locFilter ? ' for this area' : ''}.</p>`;
    rows.forEach(wireSub);
    refreshCounts();
  } catch (e) { toast('Could not load submissions: ' + e.message, false); }
  subsEl.removeAttribute('aria-busy');
}

function whereLine(r) {
  const bits = [];
  if (r.park_slug) bits.push(`<a href="/accesstrails/parks/${esc(r.park_slug)}/">${esc(r.park_name)}</a>`);
  else if (r.park_name) bits.push(esc(r.park_name));
  if (r.location_slug && LOCATIONS[r.location_slug]) bits.push(esc(LOCATIONS[r.location_slug].name) + ' area');
  return bits.join(' · ') || '<span class="at-muted">No park/area set</span>';
}

function subRow(r) {
  const photos = (r.photos || []).map(u => `<img src="${esc(u)}" alt="Photo submitted for ${esc(r.park_name)}" style="max-width:160px;border-radius:6px;margin:4px">`).join('');
  const contact = r.source === 'team'
    ? `Field note by <strong>${esc(r.submitted_by || 'SPARC Team')}</strong>`
    : (r.may_contact
      ? `Contact OK — ${esc(r.contact_method || '')}: ${esc(r.contact_detail || '')} ${esc([r.reporter_first, r.reporter_last].filter(Boolean).join(' '))}`
      : 'No contact requested');
  const visible = (r.status === 'new' || r.status === 'reviewed')
    ? '<span class="at-badge at-badge--mostly-accessible">Live on public pages</span>'
    : '<span class="at-badge at-badge--mostly-inaccessible">Hidden from public pages</span>';
  const srcBadge = r.source === 'team'
    ? '<span class="at-notesrc at-notesrc--team">SPARC Team</span>'
    : '<span class="at-notesrc at-notesrc--community">Community</span>';
  const feature = r.feature_type ? `<span class="at-notechip">${esc(FEATURE_LABEL[r.feature_type] || r.feature_type)}</span>` : '';
  return `<article class="at-cat" data-id="${r.id}">
    <div class="at-cat-head"><h3>${esc(r.park_name)}</h3>${visible}</div>
    <div class="at-note-meta">${srcBadge}${feature}<span class="at-note-date">${esc(noteDate(r.created_at))}</span></div>
    <p>${whereLine(r)}</p>
    <p><strong>${esc(r.find_type || '—')}</strong></p>
    <p class="js-desc" style="white-space:pre-wrap">${esc(r.description)}</p>
    <p class="at-muted">${contact}</p>
    ${photos ? `<div>${photos}</div>` : ''}
    <div class="js-editwrap" hidden>
      <div class="at-field"><label>Park name<input class="at-input js-edit-park" value="${esc(r.park_name)}"></label></div>
      <div class="at-field"><label>Description<textarea class="at-textarea js-edit-desc" rows="4">${esc(r.description)}</textarea></label></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button type="button" class="at-submit js-edit-save">Save changes</button>
        <button type="button" class="at-btnlink js-edit-cancel" style="background:var(--medium-gray)">Cancel</button>
      </div>
    </div>
    <div class="at-field"><label>Team note (internal — never shown publicly)
      <textarea class="at-textarea js-note" rows="2">${esc(r.team_note || '')}</textarea></label></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button type="button" class="at-btnlink js-save">Save team note</button>
      ${r.status === 'new' ? '<button type="button" class="at-submit js-review">Mark reviewed</button>' : ''}
      ${(r.status === 'new' || r.status === 'reviewed')
        ? '<button type="button" class="js-archive at-btn-danger">Archive (hide)</button><button type="button" class="js-spam at-btn-danger">Spam</button>'
        : '<button type="button" class="at-submit js-restore">Restore to “New” (show publicly)</button>'}
      <button type="button" class="at-btnlink js-edit" style="background:var(--medium-gray)">Edit</button>
      <button type="button" class="js-del at-btn-danger">Delete</button>
    </div>
  </article>`;
}

function wireSub(r) {
  const el = subsEl.querySelector(`[data-id="${r.id}"]`);
  if (!el) return;
  const on = (sel, fn) => { const b = el.querySelector(sel); if (b) b.addEventListener('click', fn); };
  on('.js-save', async () => {
    try { await AdminData.setNote(r.id, el.querySelector('.js-note').value); toast('Team note saved.'); }
    catch (e) { toast('Save failed: ' + e.message, false); }
  });
  on('.js-review', async () => {
    try { await AdminData.setStatus(r.id, 'reviewed'); await loadSubs(); toast('Marked reviewed — still live on the public pages.'); }
    catch (e) { toast('Failed: ' + e.message, false); }
  });
  on('.js-archive', async () => {
    try { await AdminData.setStatus(r.id, 'archived'); await loadSubs(); toast('Archived — hidden from the public pages.'); }
    catch (e) { toast('Failed: ' + e.message, false); }
  });
  on('.js-spam', async () => {
    try { await AdminData.setStatus(r.id, 'spam'); await loadSubs(); toast('Marked as spam — hidden from the public pages.'); }
    catch (e) { toast('Failed: ' + e.message, false); }
  });
  on('.js-restore', async () => {
    try { await AdminData.setStatus(r.id, 'new'); await loadSubs(); toast('Restored — live on the public pages again.'); }
    catch (e) { toast('Failed: ' + e.message, false); }
  });
  on('.js-edit', () => { el.querySelector('.js-editwrap').hidden = false; el.querySelector('.js-desc').hidden = true; });
  on('.js-edit-cancel', () => { el.querySelector('.js-editwrap').hidden = true; el.querySelector('.js-desc').hidden = false; });
  on('.js-edit-save', async () => {
    try {
      await AdminData.update(r.id, {
        park_name: el.querySelector('.js-edit-park').value.trim() || r.park_name,
        description: el.querySelector('.js-edit-desc').value.trim() || r.description,
      });
      await loadSubs(); toast('Saved.');
    } catch (e) { toast('Save failed: ' + e.message, false); }
  });
  on('.js-del', async () => {
    if (!confirm('Delete this note permanently? This can\'t be undone.')) return;
    try { await AdminData.remove(r.id); await loadSubs(); toast('Deleted.'); }
    catch (e) { toast('Delete failed: ' + e.message, false); }
  });
}

// ---- team field note (mirrors /ART console/submit) --------------------------
function buildTeamSubmit() {
  submitPanel.innerHTML = `
    <p class="at-muted">Document something you found in the field. Your note posts as <strong>SPARC Team</strong> and appears on the matching park/area page and the Community Submissions board right away.</p>
    <div class="at-field" style="max-width:340px">
      <label for="at-team-loc">SPARC center area</label>
      <select class="at-select" id="at-team-loc">
        <option value="">Choose an area…</option>
        ${Object.entries(LOCATIONS).map(([s, l]) => `<option value="${s}">${esc(l.name)} — ${esc(l.center)}</option>`).join('')}
      </select>
    </div>
    <div id="at-team-form"></div>`;
  const locSel = submitPanel.querySelector('#at-team-loc');
  const formHost = submitPanel.querySelector('#at-team-form');
  locSel.addEventListener('change', () => {
    formHost.innerHTML = '';
    if (!locSel.value) return;
    renderNoteForm(formHost, {
      location: locSel.value,
      parkSlug: null,
      parkName: '',
      staff: { email: currentEmail, role: currentRole },
      onSubmitted: () => { loadSubs(); },
    });
  });
}

// ---- roster (admins) ------------------------------------------------------
async function loadRoster() {
  try {
    const people = await AdminData.listRoster();
    rosterEl.innerHTML = people.map(p => `<li style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #d9dee3">
      <span>${esc(p.email)} <span class="at-muted">(${esc(p.role || 'contributor')}${p.display_name ? ' · ' + esc(p.display_name) : ''})</span></span>
      <button type="button" class="js-remove at-btn-danger" data-email="${esc(p.email)}" style="padding:4px 10px">Remove</button>
    </li>`).join('');
    rosterEl.querySelectorAll('.js-remove').forEach(b => b.addEventListener('click', async () => {
      const email = b.dataset.email;
      if (!confirm(`Remove ${email} from the roster?`)) return;
      try { await AdminData.removePerson(email); await loadRoster(); toast('Removed ' + email); }
      catch (e) { toast('Remove failed: ' + e.message, false); }
    }));
  } catch (e) { toast('Could not load roster: ' + e.message, false); }
}

document.getElementById('at-roster-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('at-roster-email').value.trim();
  const role = document.getElementById('at-roster-role').value;
  const display_name = document.getElementById('at-roster-name').value.trim();
  if (!email) return;
  try {
    await AdminData.addPerson({ email, role, display_name });
    e.target.reset();
    await loadRoster();
    toast('Added ' + email + '. They can now sign in: enter this email at the console, choose a password, and select "Create a password".');
  } catch (e2) { toast('Add failed: ' + e2.message, false); }
});
