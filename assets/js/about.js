/* ==========================================================================
   about.js — stats table, experience list, comp-card assembly

   app.js already fills every [data-bind] from profile.json. This module
   handles the parts that are LISTS rather than single values, so they cannot
   be expressed as a data-bind attribute.
   ========================================================================== */

import { getProfile, getIndex, escapeHTML, pictureHTML } from "./data.js";
import { url } from "./paths.js";
import { initReveal } from "./reveal.js";
import { hold } from "./ready.js";

/* Order is deliberate and fixed rather than Object.keys(): a casting
   director scans these in a conventional sequence, and JSON key order is
   not a contract. Anything present in profile.stats but not listed here is
   appended, so adding a stat to the JSON never silently drops it. */
const STAT_LABELS = {
  age: "Age",
  height: "Height",
  clothing: "Clothing size",
  shoe: "Shoe size",
  hair: "Hair",
  eyes: "Eyes",
};

function renderStats(profile) {
  const host = document.querySelector("[data-stats]");
  if (!host) return;

  const stats = profile.stats ?? {};
  const known = Object.keys(STAT_LABELS).filter((k) => stats[k]);
  const extra = Object.keys(stats).filter((k) => !(k in STAT_LABELS));
  const keys = [...known, ...extra];

  if (!keys.length) {
    host.innerHTML = `<p class="t-body">Measurements available on request.</p>`;
    return;
  }

  const rows = keys.map((k) => {
    const label = STAT_LABELS[k] ?? k.replace(/^./, (c) => c.toUpperCase());
    return `<div class="stats__row">
  <dt class="stats__k t-meta">${escapeHTML(label)}</dt>
  <dd class="stats__v">${escapeHTML(stats[k])}</dd>
</div>`;
  });

  // Languages live outside `stats` but belong in the same table.
  if (Array.isArray(profile.languages) && profile.languages.length) {
    rows.push(`<div class="stats__row">
  <dt class="stats__k t-meta">Languages</dt>
  <dd class="stats__v">${escapeHTML(profile.languages.join(" · "))}</dd>
</div>`);
  }

  host.innerHTML = rows.join("");
}

function renderExperience(profile) {
  const host = document.querySelector("[data-experience]");
  if (!host) return;

  const items = Array.isArray(profile.experience) ? profile.experience : [];

  /* An empty experience list is the honest state for a new portfolio, and
     must not render an empty box. Say something useful instead. */
  if (!items.length) {
    host.innerHTML = `<p class="t-body">New to professional work — first bookings in progress.</p>`;
    return;
  }

  // Most recent first. Year is a string in the JSON, so compare numerically.
  const sorted = [...items].sort(
    (a, b) => Number(b.year ?? 0) - Number(a.year ?? 0)
  );

  host.innerHTML = sorted
    .map(
      (item) => `<div class="exp__row">
  <span class="exp__year">${escapeHTML(item.year ?? "")}</span>
  <h3 class="exp__title">${escapeHTML(item.title ?? "")}</h3>
  <span class="exp__client">${escapeHTML(item.client ?? "")}</span>
</div>`
    )
    .join("");
}

/**
 * Build the print-only comp card: headshot plus three looks, drawn from the
 * category covers already in index.json.
 *
 * Deliberately built from the index rather than a curated list — it stays
 * correct as categories are added or reordered, with no second thing to
 * maintain. The card is display:none on screen and only laid out by
 * print.css.
 */
async function renderCompCard(profile) {
  const host = document.querySelector("[data-comp]");
  if (!host) return;

  let covers = [];
  try {
    const { categories } = await getIndex();
    covers = (categories ?? [])
      .filter((c) => c.published !== false && c.cover)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((c) => c.cover)
      .slice(0, 4);
  } catch {
    /* No covers — the card still prints its name, stats and contact block,
       which is more useful than failing outright. */
  }

  const shot = (cover, i) => {
    if (!cover) return "";
    const main = i === 0 ? " comp__shot--main" : "";
    // Print needs real pixels, not a 400w thumbnail: ask for a size that
    // holds up at 300dpi on a 5x7 card.
    const img = cover.placeholder
      ? `<div class="ph"></div>`
      : pictureHTML(cover, { sizes: "3in", className: "" });
    return `<div class="comp__shot${main}">${img}</div>`;
  };

  const stats = profile.stats ?? {};
  const statBits = ["age", "height", "clothing", "shoe"]
    .filter((k) => stats[k])
    .map(
      (k) =>
        `<span class="comp__stat"><b>${escapeHTML(
          k === "clothing" ? "Size" : k === "shoe" ? "Shoe" : k === "age" ? "Age" : "Height"
        )}</b> ${escapeHTML(stats[k])}</span>`
    )
    .join("");

  host.innerHTML = `<div class="comp__head">
  <span class="comp__name">${escapeHTML(profile.firstName ?? "")}</span>
  <span class="comp__role">${escapeHTML(profile.tagline ?? "")}</span>
</div>
<div class="comp__grid">${covers.map(shot).join("")}</div>
<div class="comp__foot">
  <div class="comp__stats">${statBits}</div>
  <div>${escapeHTML(profile.contactEmail ?? "")}</div>
</div>`;
}

function wirePrintButton() {
  const btn = document.querySelector("[data-print]");
  if (!btn) return;
  btn.addEventListener("click", () => window.print());
}

async function initAbout() {
  // Claim the reveal barrier before any await — see ready.js.
  const done = hold();
  try {
    const profile = await getProfile();
    renderStats(profile);
    renderExperience(profile);
    wirePrintButton();
    // The card is print-only, so a failure here must never block the page.
    await renderCompCard(profile).catch(() => {});
    initReveal();
  } catch (err) {
    /* The markup carries readable fallback copy, so a failed fetch degrades
       to a static page rather than an empty one. */
    console.warn("about: profile unavailable —", err.message);
    wirePrintButton();
  } finally {
    done();
  }
}

initAbout();
