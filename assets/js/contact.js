/* ==========================================================================
   contact.js — enquiry form

   GitHub Pages serves static files and runs no server code, so there is no
   endpoint to POST to. The options were:

     1. A third-party form service (Formspree, Getform, …) — rejected: it
        routes a child's portfolio enquiries, and the sender's details,
        through someone else's server, which contradicts the privacy stance
        the rest of this site is built on.
     2. mailto: composition — chosen. The form validates input, then opens
        the visitor's own mail client with a pre-filled, well-structured
        message. Nothing is transmitted anywhere by this page.

   The trade-off is stated plainly in the UI rather than hidden: the visitor
   can see it becomes an email they send themselves. The direct address is
   also shown, because a visitor with webmail-only may have no mail client
   registered, and a mailto: that does nothing is a dead end.
   ========================================================================== */

import { getProfile } from "./data.js";
import { hold } from "./ready.js";
import { initReveal } from "./reveal.js";

/** Address collected from profile.json; the form is inert until it lands. */
let contactEmail = null;

function setStatus(text, kind = "") {
  const el = document.querySelector("[data-form-status]");
  if (!el) return;
  el.textContent = text;
  el.className = `form__status${kind ? ` form__status--${kind}` : ""}`;
}

/**
 * Compose the mailto: URL.
 *
 * Every field is encodeURIComponent'd. That is not cosmetic: an unencoded
 * newline or ampersand in the body silently truncates the message at that
 * character in most mail clients, so the recipient would receive a partial
 * enquiry with no indication anything was lost.
 *
 * Exported and taking `to` explicitly so the encoding can be tested directly.
 * `window.location.assign` is a non-writable property, so a test cannot stub it
 * to capture the composed URL — the composition has to be reachable on its own.
 */
export function mailtoURL({ name, email, org, message }, to = contactEmail) {
  const subject = `Booking enquiry — ${name}${org ? ` (${org})` : ""}`;

  const body = [
    `Name: ${name}`,
    email ? `Reply to: ${email}` : null,
    org ? `Company / production: ${org}` : null,
    "",
    message,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return `mailto:${to}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`;
}

function initForm() {
  const form = document.querySelector("[data-form]");
  if (!form) return;

  form.addEventListener("submit", (e) => {
    // Always prevent default: this form has no action and must never
    // navigate, which would drop the visitor on a blank page.
    e.preventDefault();

    /* Only paint invalid fields after an attempt — see .was-submitted in
       pages.css. Styling :invalid from the start scolds the visitor for
       not having typed yet. */
    form.classList.add("was-submitted");

    if (!form.reportValidity()) {
      setStatus("Please complete the required fields.", "err");
      return;
    }

    if (!contactEmail) {
      setStatus(
        "The contact address is still loading — please try again in a moment.",
        "err"
      );
      return;
    }

    const data = new FormData(form);
    const values = {
      name: String(data.get("name") ?? "").trim(),
      email: String(data.get("email") ?? "").trim(),
      org: String(data.get("org") ?? "").trim(),
      message: String(data.get("message") ?? "").trim(),
    };

    setStatus("Opening your email app…", "ok");

    /* location.assign rather than window.open: a popup blocker will silently
       swallow window.open for a mailto:, leaving the visitor with no
       feedback and no email. */
    window.location.assign(mailtoURL(values));

    /* If no mail client is registered, nothing visible happens — so after a
       moment, point at the address they can copy instead. Deliberately not
       phrased as an error: in the common case the mail client DID open and
       this is simply a fallback note. */
    window.setTimeout(() => {
      setStatus(
        `If your email app did not open, write to ${contactEmail} directly.`,
        ""
      );
    }, 2500);
  });
}

async function initContact() {
  const done = hold();
  try {
    const profile = await getProfile();
    contactEmail = profile.contactEmail || null;
    initReveal();
  } catch (err) {
    console.warn("contact: profile unavailable —", err.message);
  } finally {
    /* Wire the form regardless: with no address it reports a clear message
       rather than appearing to work and doing nothing. */
    initForm();
    done();
  }
}

initContact();
