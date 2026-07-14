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
 *
 * Returning attendees:
 *   - Registration is remembered in localStorage, so on the same browser the
 *     join panel is revealed immediately on the next visit.
 *   - An "Already registered?" link (injected below the submit button) lets
 *     people on a new device enter just their email; the backend confirms the
 *     registration ({action:"lookup"}) and the join panel is revealed.
 */
(function () {
  "use strict";

  var ENDPOINT =
    "https://ldxpockcgcxvsrbyhcnt.supabase.co/functions/v1/virtual-summit-register";
  // Publishable (anon) key — safe in the browser; only used so the Supabase
  // gateway routes the request. RLS + the function's own validation protect data.
  var ANON_KEY = "sb_publishable_3tn2UadRVekIf5Pw6F5z-A_40ZbdvTm";

  var STORE_KEY = "sparc_vs_reg";
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function firstName(name) {
    return (name || "").trim().split(/\s+/)[0] || "";
  }

  function loadReg() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var reg = JSON.parse(raw);
      return reg && reg.email ? reg : null;
    } catch (err) {
      return null; // storage unavailable (private mode etc.)
    }
  }

  function saveReg(name, email) {
    try {
      window.localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ name: name, email: email, at: new Date().toISOString() })
      );
    } catch (err) { /* best effort */ }
  }

  function clearReg() {
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch (err) { /* best effort */ }
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
    var form = root.querySelector(".vs-form");
    if (!form || form.dataset.vsWired === "1") return;
    form.dataset.vsWired = "1";

    var statusEl = root.querySelector("[data-vs-status]");
    var successEl = root.querySelector("[data-vs-success]");
    var submitBtn = form.querySelector("[data-vs-submit]");
    var source = form.getAttribute("data-source") || "virtualsummit";

    var nameInput = form.elements.name || null;
    var nameField = nameInput
      ? nameInput.closest(".vs-field") || nameInput.parentElement
      : null;
    var registerLabel = submitBtn ? submitBtn.textContent : "";
    var lookupMode = false;

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

    function reveal(name, opts) {
      opts = opts || {};
      if (!successEl) return;
      var nameSlots = successEl.querySelectorAll("[data-vs-name]");
      for (var i = 0; i < nameSlots.length; i++) {
        nameSlots[i].textContent = firstName(name) || "friend";
      }
      form.style.display = "none";
      successEl.hidden = false;

      // Give returning visitors a way out if the remembered/looked-up
      // registration isn't theirs.
      if (!successEl.querySelector("[data-vs-reset]")) {
        var reset = document.createElement("p");
        reset.setAttribute("data-vs-reset", "");
        reset.style.cssText = "margin-top:14px;font-size:0.82rem;color:#8a9099;";
        reset.innerHTML =
          'Not you? <a href="#" style="color:#00539B;">Register a different attendee</a>';
        reset.querySelector("a").addEventListener("click", function (e) {
          e.preventDefault();
          clearReg();
          successEl.hidden = true;
          form.style.display = "";
          if (form.elements.name) form.elements.name.value = "";
          if (form.elements.email) form.elements.email.value = "";
          setLookupMode(false);
          setStatus("");
        });
        successEl.appendChild(reset);
      }

      if (opts.scroll && typeof successEl.scrollIntoView === "function") {
        successEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    function setLookupMode(on) {
      lookupMode = !!on;
      if (nameField) nameField.style.display = lookupMode ? "none" : "";
      if (nameInput) nameInput.required = !lookupMode;
      if (submitBtn) {
        submitBtn.textContent = lookupMode ? "Get My Join Link" : registerLabel;
      }
      if (toggleLink) {
        toggleLink.innerHTML = lookupMode
          ? 'New here? <a href="#">Register to join virtually</a>'
          : 'Already registered? <a href="#">Get your join link</a>';
      }
      setStatus("");
    }

    // Inject the "Already registered?" toggle below the submit button so both
    // the /virtualsummit page and the /summit modal get it with no HTML edits.
    var toggleLink = document.createElement("p");
    toggleLink.setAttribute("data-vs-toggle", "");
    toggleLink.style.cssText =
      "margin-top:12px;font-size:0.86rem;color:#666;text-align:center;";
    toggleLink.addEventListener("click", function (e) {
      var a = e.target.closest ? e.target.closest("a") : null;
      if (!a) return;
      e.preventDefault();
      setLookupMode(!lookupMode);
      var emailInput = form.elements.email;
      if (emailInput) emailInput.focus();
    });
    if (submitBtn && submitBtn.parentNode === form) {
      form.insertBefore(toggleLink, submitBtn.nextSibling);
    } else {
      form.appendChild(toggleLink);
    }
    setLookupMode(false);

    // Same-browser return visit: reveal the join panel immediately.
    var stored = loadReg();
    if (stored) {
      reveal(stored.name, { scroll: false });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      setStatus("");

      var name = (form.elements.name && form.elements.name.value || "").trim();
      var email = (form.elements.email && form.elements.email.value || "").trim();
      var company =
        (form.elements.company && form.elements.company.value || "").trim();

      if (!lookupMode && !name) {
        setStatus("Please enter your name.", true);
        return;
      }
      if (!EMAIL_RE.test(email)) {
        setStatus("Please enter a valid email address.", true);
        return;
      }

      var busyLabel = lookupMode ? "Checking…" : "Registering…";
      var idleLabel = lookupMode ? "Get My Join Link" : registerLabel;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = busyLabel;
      }

      var payload = lookupMode
        ? { action: "lookup", email: email }
        : { name: name, email: email, company: company, source: source };

      postJson(payload)
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

          if (lookupMode) {
            if (r.data.registered) {
              saveReg(r.data.name || "", email);
              reveal(r.data.name || "", { scroll: true });
              track("virtual_summit_return");
            } else {
              setLookupMode(false);
              setStatus(
                "We couldn't find a registration for that email — sign up below and you're all set.",
                true
              );
            }
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = lookupMode
                ? "Get My Join Link"
                : registerLabel;
            }
            return;
          }

          // Registration success — remember it and reveal the join panel.
          saveReg(name, email);
          reveal(name, { scroll: true });
          track("virtual_summit_register");
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
