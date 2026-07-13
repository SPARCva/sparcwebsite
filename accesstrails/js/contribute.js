// Contribute form: accessible client-side validation, honeypot + rate-limit
// spam mitigation, and anonymous insert into Supabase (when enabled).
import {
  supabase, SUBMISSIONS_TABLE, SUBMISSIONS_BUCKET,
  SUBMISSIONS_ENABLED, FALLBACK_EMAIL,
} from './supabaseClient.js';

const form = document.getElementById('at-contribute');
const statusEl = document.getElementById('at-form-status');
if (form) init();

function init() {
  form.addEventListener('submit', onSubmit);
}

function setError(id, show) {
  const err = document.getElementById(id + '-err');
  if (err) err.hidden = !show;
  const field = document.getElementById(id) || form.querySelector(`[name="${id}"]`);
  if (field && field.setAttribute) field.setAttribute('aria-invalid', show ? 'true' : 'false');
}

function firstInvalidFocus(name) {
  const el = document.getElementById(name) || form.querySelector(`[name="${name}"]`);
  if (el && el.focus) el.focus();
}

function validate() {
  let ok = true, firstBad = null;
  const bad = (name, cond) => {
    setError(name, cond);
    if (cond) { ok = false; if (!firstBad) firstBad = name; }
  };
  bad('find_type', !form.querySelector('[name="find_type"]:checked'));
  bad('park_name', !form.park_name.value.trim());
  bad('description', !form.description.value.trim());
  bad('may_contact', !form.querySelector('[name="may_contact"]:checked'));
  bad('contact_method', !form.contact_method.value);
  const photo = form.photo.files[0];
  bad('photo', !!photo && photo.size > 20 * 1024 * 1024);
  if (firstBad) firstInvalidFocus(firstBad);
  return ok;
}

function showStatus(kind, html) {
  statusEl.innerHTML = `<div class="at-formmsg at-formmsg--${kind}">${html}</div>`;
  statusEl.scrollIntoView({ block: 'nearest' });
}

// simple client-side rate limit: one submit per 30s per browser
function rateLimited() {
  try {
    const last = +localStorage.getItem('at_contribute_last') || 0;
    if (Date.now() - last < 30000) return true;
    localStorage.setItem('at_contribute_last', String(Date.now()));
  } catch (e) { /* localStorage blocked — ignore */ }
  return false;
}

async function onSubmit(e) {
  e.preventDefault();

  // honeypot: real users never fill this
  if (form.website && form.website.value) { showStatus('ok', 'Thank you!'); form.reset(); return; }

  if (!validate()) {
    showStatus('err', 'Please fix the highlighted fields and try again.');
    return;
  }
  if (rateLimited()) {
    showStatus('err', 'You just submitted a review. Please wait a moment before sending another.');
    return;
  }

  const payload = {
    find_type: form.find_type.value,
    park_name: form.park_name.value.trim(),
    description: form.description.value.trim(),
    may_contact: form.querySelector('[name="may_contact"]:checked').value === 'Yes',
    first_name: form.first_name.value.trim() || null,
    last_name: form.last_name.value.trim() || null,
    contact_method: form.contact_method.value,
    contact_detail: form.contact_detail.value.trim() || null,
  };

  if (!SUBMISSIONS_ENABLED) {
    showStatus('ok',
      'Thanks for your interest! Online submissions are not live yet while we finish setting up the review database. ' +
      'For now, please email your suggestion to <a href="mailto:' + FALLBACK_EMAIL + '">' + FALLBACK_EMAIL + '</a>.');
    return;
  }

  const btn = form.querySelector('.at-submit');
  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const photo = form.photo.files[0];
    let photo_path = null;
    if (photo) {
      const safe = photo.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      photo_path = `${Date.now()}-${Math.round(performance.now())}-${safe}`;
      const up = await supabase.storage.from(SUBMISSIONS_BUCKET).upload(photo_path, photo, { upsert: false });
      if (up.error) throw up.error;
    }
    const { error } = await supabase.from(SUBMISSIONS_TABLE).insert({ ...payload, photo_path });
    if (error) throw error;
    form.reset();
    showStatus('ok', 'Thank you! Your review has been submitted and will help improve this guide.');
  } catch (err) {
    console.error('[contribute] submission failed:', err);
    showStatus('err',
      'Sorry — something went wrong submitting your review. Please try again, or email ' +
      '<a href="mailto:' + FALLBACK_EMAIL + '">' + FALLBACK_EMAIL + '</a>.');
  } finally {
    btn.disabled = false; btn.textContent = 'Submit review';
  }
}
