/* ==========================================================================
   home.js — marquee, ticker and category blocks
   ========================================================================== */

import {
  getIndex,
  getProfile,
  prefetchCategory,
  pictureHTML,
  escapeHTML,
} from "./data.js";
import { url } from "./paths.js";
import { initReveal } from "./reveal.js";
import { hold } from "./ready.js";

/** Placeholder tile: a styled box, so we never ship fake binary images. */
function tile(photo, { sizes, eager = false }) {
  if (!photo) return '<div class="ph" aria-hidden="true"></div>';
  if (photo.placeholder) {
    return `<div class="ph" role="img" aria-label="${escapeHTML(
      photo.alt
    )}"></div>`;
  }
  return pictureHTML(photo, { sizes, eager });
}

function renderMarquee(categories) {
  const track = document.querySelectorAll(".marquee__row");
  if (!track.length) return;

  const covers = categories.filter((c) => c.cover);
  if (!covers.length) return;

  // Row B is offset so the two rows never show the same image side by side.
  const rows = [covers, [...covers.slice(3), ...covers.slice(0, 3)]];

  track.forEach((row, rowIndex) => {
    const items = rows[rowIndex] ?? covers;

    // Duplicated EXACTLY once: the -50% translate then lands the copy where
    // the original began, which is what makes the loop seamless.
    const cells = [...items, ...items]
      .map((cat, i) => {
        // Only the first two images are eager — they are the LCP candidates.
        const eager = rowIndex === 0 && i < 2;
        return `<div class="marquee__cell">${tile(cat.cover, {
          sizes: "(max-width: 767px) 40vw, 17rem",
          eager,
        })}</div>`;
      })
      .join("");

    row.innerHTML = cells;
  });
}

function renderTicker(categories) {
  const track = document.querySelector(".ticker__track");
  if (!track) return;

  const labels = categories.map((c) => c.title);
  // Duplicated once for the same seamless-loop reason as the marquee.
  track.innerHTML = [...labels, ...labels]
    .map((l) => `<span class="ticker__item">${escapeHTML(l)}</span>`)
    .join("");
}

function renderCategories(categories) {
  const host = document.querySelector(".cats");
  if (!host) return;

  host.innerHTML = categories
    .map((cat, i) => {
      const href = url(`work/${cat.slug}/`);
      const n = String(i + 1).padStart(2, "0");
      const looks = cat.count === 1 ? "1 look" : `${cat.count} looks`;

      return `<article class="cat reveal" data-slug="${escapeHTML(cat.slug)}">
  <a class="cat__media" href="${href}" aria-label="${escapeHTML(
        cat.title
      )} — ${looks}" tabindex="-1">
    ${tile(cat.cover, {
      sizes: "(max-width: 1023px) 100vw, 50vw",
    })}
  </a>
  <div class="cat__body">
    <span class="cat__num">${n}</span>
    <h2 class="cat__title">${escapeHTML(cat.title)}</h2>
    <p class="cat__sub">${escapeHTML(cat.subtitle)}</p>
    <p class="cat__blurb">${escapeHTML(cat.blurb)}</p>
    <div class="cat__meta">
      <a class="link-arrow" href="${href}">View ${escapeHTML(
        cat.title
      )}<span class="sr-only"> — ${looks}</span></a>
      <span class="t-micro">${looks}</span>
    </div>
  </div>
</article>`;
    })
    .join("");

  /* Prefetch a gallery on hover or first touch, so the JSON is usually
     already cached by the time the click lands. `once` — no point repeating.
     touchstart is passive: it must never delay scrolling. */
  for (const el of host.querySelectorAll(".cat")) {
    const slug = el.dataset.slug;
    const warm = () => prefetchCategory(slug);
    el.addEventListener("mouseenter", warm, { once: true });
    el.addEventListener("touchstart", warm, { once: true, passive: true });
  }

  initReveal(host);
}

/**
 * Split the hero name into per-word spans for the staggered entrance.
 *
 * Must run AFTER app.js has bound the name from profile.json — app.js sets
 * textContent, which would otherwise wipe these spans out. We await the
 * profile here so both modules read the same cached JSON and the ordering is
 * explicit rather than a race between two independent module loads.
 */
async function animateHeroName() {
  const el = document.querySelector(".hero__name");
  if (!el) return;

  try {
    const profile = await getProfile();
    if (profile.firstName) el.textContent = profile.firstName;
  } catch {
    /* keep whatever the markup already says */
  }

  const words = el.textContent.trim().split(/\s+/);
  el.innerHTML = words
    .map(
      (w, i) =>
        `<span class="hero__word" style="--i:${i}">${escapeHTML(w)}</span>`
    )
    .join(" ");
}

export async function initHome() {
  // Claim the reveal barrier before any await — see ready.js.
  const done = hold();
  try {
    await renderAll();
  } finally {
    done();
  }
}

async function renderAll() {
  await animateHeroName();

  try {
    const { categories } = await getIndex();
    const live = categories
      .filter((c) => c.published !== false)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    renderMarquee(live);
    renderTicker(live);
    renderCategories(live);
  } catch (err) {
    console.error("Could not load portfolio index:", err);
    const host = document.querySelector(".cats");
    if (host) {
      host.innerHTML = `<p class="t-body">Portfolio is being updated — please check back shortly.</p>`;
    }
  }
}

initHome();
