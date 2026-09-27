/* ==========================================================================
   app.js — shared entry point for every public page
   Page-specific logic lives in home.js / gallery.js and is loaded by the
   page that needs it.
   ========================================================================== */

import { initTheme } from "./theme.js";
import { initNav } from "./nav.js";
import { initReveal } from "./reveal.js";
import { getProfile } from "./data.js";
import { escapeHTML } from "./data.js";
import { whenReady } from "./ready.js";

/** Fill any [data-bind="key.path"] element from profile.json. */
function bindProfile(profile) {
  for (const el of document.querySelectorAll("[data-bind]")) {
    const value = el.dataset.bind
      .split(".")
      .reduce((obj, key) => obj?.[key], profile);
    if (value === undefined || value === null) continue;
    el.textContent = Array.isArray(value) ? value.join(" · ") : String(value);
  }

  // Contact email is a link, not just text — bind href as well.
  if (profile.contactEmail) {
    for (const el of document.querySelectorAll("[data-bind-email]")) {
      el.href = `mailto:${profile.contactEmail}`;
      if (!el.textContent.trim()) el.textContent = profile.contactEmail;
    }
  }

  // Document title is templated so each page gets the real name once loaded.
  const tpl = document.documentElement.dataset.titleTpl;
  if (tpl) {
    document.title = tpl
      .replace("{name}", profile.firstName || "Portfolio")
      .replace("{tagline}", profile.tagline || "");
  }
}

async function main() {
  document.documentElement.classList.remove("no-js");

  initTheme();
  initNav();

  // Reveal before data lands so static content animates immediately.
  initReveal();

  try {
    const profile = await getProfile();
    bindProfile(profile);
  } catch (err) {
    // A failed profile fetch must not blank the page — the markup already
    // contains sensible placeholder text, so we log and carry on.
    console.warn("profile.json unavailable:", err.message);
  }

  /* Wait for page modules (home.js, gallery.js) to finish rendering before
     revealing. Otherwise the fade runs against an empty grid and the content
     pops in afterwards. */
  await whenReady();

  document.body.classList.remove("is-loading");
  document.body.classList.add("is-ready");
}

// The module is deferred by nature, so the DOM is parsed by the time this
// runs; no DOMContentLoaded wrapper needed.
main();

export { escapeHTML };
