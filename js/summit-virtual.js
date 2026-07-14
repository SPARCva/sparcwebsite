/*
 * summit-virtual.js
 * -----------------
 * Wires up the free "Join Virtually" registration flow used in two places:
 *   - the standalone /virtualsummit page
 *   - the "Join Virtually for Free" modal on /summit
 *
 * Both use the same markup contract. Anywhere on the page, add:
 *
 *   <div data-vs-root>
 *     <form class="vs-form" data-source="virtualsummit">
 *       <input name="company" ... aria-hidden hidden>     <!-- honeypot -->
 *       <input name="name" required>
 *       <input name="email" type="email" required>
 *       <div class="vs-status" data-vs-status></div>
 *       <button type="submit" data-vs-submit>Join Virtually for Free</button>
 *     </form>
 *     <div class="vs-success" data-vs-success hidden>
 *       ...revealed on success; may contain [data-vs-name]...
 *     </div>
 *   </div>
 *
 * On a successful submission the form is hidden and the .vs-success block is
 * shown (with [data-vs-name] filled with the registrant's first name).
 */
(function () {
  "use strict";

  var ENDPOINT =
    "https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/virtual-summit-register";
  // Publishable (anon) key — safe in the browser; only used so the Supabase
  // gateway routes the request. RLS + the function's own validation protect data.
  var ANON_KEY = "sb_publishable_3tn2UadRVekIf5Pw6F5z-A_40ZbdvTm";

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function firstName(name) {
    return (name || "").trim().split(/\s+/)[0] || "";
  }

  function wire(root) {
    var form = root.querySelector(".vs-form");
    if (!form || form.dataset.vsWired === "1") return;
    form.dataset.vsWired = "1";

    var statusEl = root.querySelector("[data-vs-status]");
    var successEl = root.querySelector("[data-vs-success]");
    var submitBtn = form.querySelector("[data-vs-submit]");
    var source = form.getAttribute("data-source") || "virtualsummit";

    function setStatus(msg, isError) {
      if (!statusEl) return;
      statusEl.textContent = msg || "";
      statusEl.style.display = msg ? "block" : "none";
      statusEl.classList.toggle("is-error", !!isError);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      setStatus("");

      var name = (form.elements.name && form.elements.name.value || "").trim();
      var email = (form.elements.email && form.elements.email.value || "").trim();
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

      var originalLabel = submitBtn ? submitBtn.textContent : "";
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Registering…";
      }

      fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: ANON_KEY,
          Authorization: "Bearer " + ANON_KEY,
        },
        body: JSON.stringify({
          name: name,
          email: email,
          company: company,
          source: source,
        }),
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (r) {
          if (!r.ok || !r.data || r.data.ok !== true) {
            var msg =
              (r.data && r.data.error) ||
              "Something went wrong. Please try again.";
            setStatus(msg, true);
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = originalLabel;
            }
            return;
          }
          // Success — reveal the "you're in" panel with the live join button.
          if (successEl) {
            var nameSlots = successEl.querySelectorAll("[data-vs-name]");
            for (var i = 0; i < nameSlots.length; i++) {
              nameSlots[i].textContent = firstName(name);
            }
            form.style.display = "none";
            successEl.hidden = false;
            if (typeof successEl.scrollIntoView === "function") {
              successEl.scrollIntoView({ behavior: "smooth", block: "center" });
            }
            try {
              if (typeof gtag === "function") {
                gtag("event", "virtual_summit_register", { source: source });
              }
            } catch (err) { /* analytics is best-effort */ }
          }
        })
        .catch(function () {
          setStatus(
            "We couldn't reach the server. Please check your connection and try again.",
            true
          );
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalLabel;
          }
        });
    });
  }

  function init() {
    var roots = document.querySelectorAll("[data-vs-root]");
    for (var i = 0; i < roots.length; i++) wire(roots[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose for dynamically-inserted markup (e.g. modal opened later).
  window.SparcVirtualSummit = { init: init };
})();
