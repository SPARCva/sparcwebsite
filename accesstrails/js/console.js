// Access Trails Team Console: magic-link sign-in, submission triage, and
// (for admins) roster management of the shared access_staff allow-list —
// mirroring the /access admin console. All access is gated by RLS on
// access_role(); the UI just reflects what the DB allows.
import { onAuth, getRole, logIn, createPassword, signOut } from './auth.js';
import { AdminData } from './dataLayer.admin.js';

const authEl = document.getElementById('at-console-auth');
const appEl = document.getElementById('at-console-app');
const whoEl = document.getElementById('at-console-who');
const subsEl = document.getElementById('at-console-subs');
const rosterWrap = document.getElementById('at-console-roster');
const rosterEl = document.getElementById('at-roster-list');
let currentRole = '';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
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

// Log in (existing password).
document.getElementById('at-signin-form').addEventListener('submit', async e => {
  e.preventDefault();
  const { email, password } = creds();
  if (!email || !password) return;
  const { error } = await logIn(email, password);
  if (error) signinMsg().textContent = 'Could not sign in: ' + error.message + ' — first time here? Use "Create a password".';
  // success → onAuth fires and swaps the view.
});

// Create a password (first-time users).
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
  if (!currentRole) {
    authEl.querySelector('#at-signin-note').innerHTML =
      'You are signed in as <strong>' + esc(session.user.email) + '</strong> but that address is not on the Access Trails team roster. Ask an admin to add you.';
    show(authEl); hide(appEl);
    return;
  }
  whoEl.innerHTML = 'Signed in as <strong>' + esc(session.user.email) + '</strong> (' + esc(currentRole) + ')';
  hide(authEl); show(appEl);
  rosterWrap.hidden = currentRole !== 'admin';
  await loadSubs();
  if (currentRole === 'admin') await loadRoster();
});
function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

// ---- submissions triage ---------------------------------------------------
const STATUSES = ['new', 'reviewed', 'archived', 'spam'];
async function loadSubs() {
  subsEl.setAttribute('aria-busy', 'true');
  try {
    const rows = await AdminData.list();
    subsEl.innerHTML = rows.length ? rows.map(subRow).join('')
      : '<p class="at-muted">No submissions yet.</p>';
    rows.forEach(wireSub);
  } catch (e) { toast('Could not load submissions: ' + e.message, false); }
  subsEl.removeAttribute('aria-busy');
}

function subRow(r) {
  const photos = (r.photos || []).map(u => `<img src="${esc(u)}" alt="Photo submitted for ${esc(r.park_name)}" style="max-width:160px;border-radius:6px;margin:4px">`).join('');
  const contact = r.may_contact
    ? `Contact OK — ${esc(r.contact_method || '')}: ${esc(r.contact_detail || '')} ${esc([r.reporter_first, r.reporter_last].filter(Boolean).join(' '))}`
    : 'No contact requested';
  const opts = STATUSES.map(s => `<option value="${s}"${s === r.status ? ' selected' : ''}>${s}</option>`).join('');
  return `<article class="at-cat" data-id="${r.id}">
    <div class="at-cat-head"><h3>${esc(r.park_name)}</h3>
      <span class="at-badge at-badge--${r.shown_publicly ? 'mostly-accessible' : 'mostly-inaccessible'}">${r.shown_publicly ? 'Published' : 'Not published'}</span></div>
    <p><strong>${esc(r.find_type || '—')}</strong></p>
    <p>${esc(r.description)}</p>
    <p class="at-muted">${esc(contact)}</p>
    ${photos ? `<div>${photos}</div>` : ''}
    <div class="at-field"><label>Status
      <select class="at-select js-status">${opts}</select></label></div>
    <div class="at-field"><label>Team note (internal)
      <textarea class="at-textarea js-note" rows="2">${esc(r.team_note || '')}</textarea></label></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button type="button" class="at-btnlink js-save">Save note & status</button>
      <button type="button" class="at-submit js-pub">${r.shown_publicly ? 'Unpublish' : 'Publish to public page'}</button>
      <button type="button" class="js-del" style="background:none;border:1.5px solid #8a1c12;color:#8a1c12;border-radius:8px;padding:8px 14px;cursor:pointer">Delete</button>
    </div>
  </article>`;
}

function wireSub(r) {
  const el = subsEl.querySelector(`[data-id="${r.id}"]`);
  if (!el) return;
  el.querySelector('.js-save').addEventListener('click', async () => {
    try {
      await AdminData.setStatus(r.id, el.querySelector('.js-status').value);
      await AdminData.setNote(r.id, el.querySelector('.js-note').value);
      toast('Saved.');
    } catch (e) { toast('Save failed: ' + e.message, false); }
  });
  el.querySelector('.js-pub').addEventListener('click', async () => {
    try { await AdminData.setShown(r.id, !r.shown_publicly); await loadSubs(); toast(r.shown_publicly ? 'Unpublished.' : 'Published to the public page.'); }
    catch (e) { toast('Publish failed: ' + e.message, false); }
  });
  el.querySelector('.js-del').addEventListener('click', async () => {
    if (!confirm('Delete this submission permanently?')) return;
    try { await AdminData.remove(r.id); await loadSubs(); toast('Deleted.'); }
    catch (e) { toast('Delete failed: ' + e.message, false); }
  });
}

// ---- roster (admins) ------------------------------------------------------
const ROLES = ['contributor', 'editor', 'admin'];
async function loadRoster() {
  try {
    const people = await AdminData.listRoster();
    rosterEl.innerHTML = people.map(p => `<li style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #d9dee3">
      <span>${esc(p.email)} <span class="at-muted">(${esc(p.role || 'contributor')}${p.display_name ? ' · ' + esc(p.display_name) : ''})</span></span>
      <button type="button" class="js-remove" data-email="${esc(p.email)}" style="background:none;border:1px solid #8a1c12;color:#8a1c12;border-radius:6px;padding:4px 10px;cursor:pointer">Remove</button>
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
    toast('Added ' + email + '. They can now sign in with a magic link.');
  } catch (e2) { toast('Add failed: ' + e2.message, false); }
});
