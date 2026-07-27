/*
 * volunteer-apply.js
 * ------------------
 * Wires up the volunteer application form on /volunteer. Posts to the
 * `volunteer-register` Supabase edge function, which saves the application and
 * relays it to the Apps Script mailer (applicant confirmation + staff notice).
 *
 * Markup contract:
 *
 *   <div data-va-root>
 *     <form class="va-form" data-source="volunteer" novalidate>
 *       <input name="company" ... hidden>            <!-- honeypot -->
 *       <input name="name" required>
 *       <input name="email" type="email" required>
 *       <input name="phone">                          <!-- optional -->
 *       <input type="checkbox" name="interests" value="Program Support"> ...
 *       <input name="availability">                   <!-- optional -->
 *       <textarea name="message"></textarea>          <!-- optional -->
 *       <div class="va-status" data-va-status></div>
 *       <button type="submit" data-va-submit>Submit Application</button>
 *     </form>
 *     <div class="va-success" data-va-success hidden>
 *       ...revealed on success; may contain [data-va-name]...
 *     </div>
 *   </div>
 */
(function () {
  "use strict";

  var ENDPOINT =
    "https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/volunteer-register";
  // Publishable (anon) key — safe in the browser; only used so the Supabase
  // gateway routes the request. RLS + the function's own validation protect data.
  var ANON_KEY = "sb_publishable_3tn2UadRVekIf5Pw6F5z-A_40ZbdvTm";

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function firstName(name) {
    return (name || "").trim().split(/\s+/)[0] || "";
  }

  function postJson(body) {
    return fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: "Bearer " + ANON_KEY,
      },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, data: data };
      });
    });
  }

  function wire(root) {
    var form = root.querySelector(".va-form");
    if (!form || form.dataset.vaWired === "1") return;
    form.dataset.vaWired = "1";

    var statusEl = root.querySelector("[data-va-status]");
    var successEl = root.querySelector("[data-va-success]");
    var submitBtn = form.querySelector("[data-va-submit]");
    var source = form.getAttribute("data-source") || "volunteer";
    var idleLabel = submitBtn ? submitBtn.textContent : "";

    function setStatus(msg, isError) {
      if (!statusEl) return;
      statusEl.textContent = msg || "";
      statusEl.style.display = msg ? "block" : "none";
      statusEl.classList.toggle("is-error", !!isError);
    }

    function track(eventName) {
      try {
        if (typeof gtag === "function") {
          gtag("event", eventName, { source: source });
        }
      } catch (err) { /* analytics is best-effort */ }
    }

    function selectedInterests() {
      var out = [];
      var boxes = form.querySelectorAll('input[name="interests"]:checked');
      for (var i = 0; i < boxes.length; i++) out.push(boxes[i].value);
      return out;
    }

    function reveal(name) {
      if (!successEl) return;
      var slots = successEl.querySelectorAll("[data-va-name]");
      for (var i = 0; i < slots.length; i++) {
        slots[i].textContent = firstName(name) || "friend";
      }
      form.style.display = "none";
      successEl.hidden = false;
      if (typeof successEl.scrollIntoView === "function") {
        successEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      setStatus("");

      var name = (form.elements.name && form.elements.name.value || "").trim();
      var email = (form.elements.email && form.elements.email.value || "").trim();
      var phone = (form.elements.phone && form.elements.phone.value || "").trim();
      var availability =
        (form.elements.availability && form.elements.availability.value || "").trim();
      var message =
        (form.elements.message && form.elements.message.value || "").trim();
      var company =
        (form.elements.company && form.elements.company.value || "").trim();

      if (!name) {
        setStatus("Please enter your name.", true);
        return;
      }
      if (!EMAIL_RE.test(email)) {
        setStatus("Please enter a valid email address.", true);
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Submitting…";
      }

      postJson({
        name: name,
        email: email,
        phone: phone,
        interests: selectedInterests(),
        availability: availability,
        message: message,
        company: company,
        source: source,
      })
        .then(function (r) {
          if (!r.ok || !r.data || r.data.ok !== true) {
            var msg =
              (r.data && r.data.error) ||
              "Something went wrong. Please try again.";
            setStatus(msg, true);
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = idleLabel;
            }
            return;
          }
          reveal(name);
          track("volunteer_apply");
        })
        .catch(function () {
          setStatus(
            "We couldn't reach the server. Please check your connection and try again.",
            true
          );
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = idleLabel;
          }
        });
    });
  }

  function init() {
    var roots = document.querySelectorAll("[data-va-root]");
    for (var i = 0; i < roots.length; i++) wire(roots[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
