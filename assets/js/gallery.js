/* ==========================================================================
   gallery.js — masonry rendering for /work/<slug>/
   ========================================================================== */

import { getIndex, getCategory, pictureHTML, escapeAttr, escapeHTML } from "./data.js";
import { url } from "./paths.js";
import { initReveal } from "./reveal.js";
import { hold } from "./ready.js";
import {
  open as openLightbox,
  close as closeLightbox,
  indexFromHash,
} from "./lightbox.js";

/* These two MUST match --row and --gap-grid as resolved in gallery.css, or
   the computed spans will not match the rendered rows. Read from the
   cascade rather than duplicated as literals, so the CSS stays the single
   source of truth. */
function gridMetrics(host) {
  const styles = getComputedStyle(host);
  const row = parseFloat(styles.gridAutoRows) || 8;
  const gap = parseFloat(styles.columnGap) || 8;
  return { row, gap };
}

/**
 * Span count for a tile of a given aspect ratio.
 *
 * The tile's height is unknown in CSS terms (it depends on the rendered
 * column width), but the RATIO is known from the JSON. So: measure one
 * column's width once, derive the height, convert to rows.
 */
function spanFor(photo, colWidth, { row, gap }) {
  const ratio = photo.h / photo.w;
  const height = colWidth * ratio + gap;
  return Math.max(1, Math.round(height / row));
}

/** The slug comes from the folder name: /work/formal-suit/ → formal-suit. */
function slugFromPath() {
  const parts = location.pathname.split("/").filter(Boolean);
  const i = parts.indexOf("work");
  if (i !== -1 && parts[i + 1]) return parts[i + 1];
  // Fallback for a flat ?c=slug URL, so the page is not brittle if moved.
  return new URLSearchParams(location.search).get("c");
}

function tileHTML(photo, i) {
  const label = escapeAttr(photo.alt || `Photo ${i + 1}`);
  const inner = photo.placeholder
    ? `<div class="ph" role="img" aria-label="${label}"></div>`
    : pictureHTML(photo, {
        sizes:
          "(max-width: 767px) 100vw, (max-width: 1023px) 50vw, (max-width: 1439px) 33vw, 25vw",
        // The first few tiles are above the fold on every viewport.
        eager: i < 2,
      });

  const caption = photo.caption
    ? `<p class="tile__cap" aria-hidden="true">${escapeHTML(photo.caption)}</p>`
    : "";

  /* A <button>, not a <div> with a click handler: it is keyboard-focusable,
     Enter/Space activate it for free, and it announces as a control. */
  return `<div class="tile reveal" style="--span:${photo._span}">
  <button class="tile__btn" type="button" data-i="${i}"
          aria-label="Open ${label} in viewer">${inner}</button>
  ${caption}
</div>`;
}

function renderHead(cat, count) {
  const set = (sel, text) => {
    const el = document.querySelector(sel);
    if (el && text) el.textContent = text;
  };

  set("[data-g-title]", cat.title);
  set("[data-g-sub]", cat.subtitle);
  set("[data-g-blurb]", cat.blurb);
  set(
    "[data-g-count]",
    count === 1 ? "1 look" : `${count} looks`
  );

  const meta = [cat.subtitle, cat.setting, cat.year].filter(Boolean).join(" · ");
  set("[data-g-meta]", meta);

  document.title = `${cat.title} — Satvik`;
  const tpl = document.documentElement.dataset.titleTpl;
  if (tpl) document.title = tpl.replace("{category}", cat.title);
}

/** Link to the next category, wrapping to the first — a reading loop. */
function renderNext(categories, slug) {
  const host = document.querySelector("[data-g-next]");
  if (!host || categories.length < 2) return;

  const i = categories.findIndex((c) => c.slug === slug);
  const next = categories[(i + 1) % categories.length];
  if (!next || next.slug === slug) return;

  host.innerHTML = `<a class="gnext__link" href="${url(`work/${next.slug}/`)}">
  <span class="gnext__label">Next category</span>
  <span class="gnext__title">${escapeHTML(next.title)} &rarr;</span>
</a>`;
}

function renderGrid(photos) {
  const host = document.querySelector(".masonry");
  if (!host) return;

  const metrics = gridMetrics(host);
  // One column's width, measured after the grid is in the document so the
  // template columns have actually resolved.
  const cols = getComputedStyle(host).gridTemplateColumns.split(" ").length;
  const colWidth = (host.clientWidth - metrics.gap * (cols - 1)) / cols;

  for (const photo of photos) photo._span = spanFor(photo, colWidth, metrics);

  host.innerHTML = photos.map(tileHTML).join("");

  host.addEventListener("click", (e) => {
    const btn = e.target.closest(".tile__btn");
    if (!btn) return;
    openLightbox(photos, Number(btn.dataset.i), btn);
  });

  /* Deters casual saving only — anyone can use devtools. Included because
     it is expected of a portfolio, not because it protects anything. */
  host.addEventListener("contextmenu", (e) => {
    if (e.target.closest("img")) e.preventDefault();
  });
  host.addEventListener("dragstart", (e) => {
    if (e.target.closest("img")) e.preventDefault();
  });

  initReveal(host);

  /* Column count changes on resize, so the spans must be recomputed.
     Debounced, and only when the count actually changed — a resize that
     stays within a breakpoint needs no work. */
  let lastCols = cols;
  let timer = null;
  window.addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const now = getComputedStyle(host).gridTemplateColumns.split(" ").length;
      if (now === lastCols) return;
      lastCols = now;

      const m = gridMetrics(host);
      const w = (host.clientWidth - m.gap * (now - 1)) / now;
      const tiles = host.querySelectorAll(".tile");
      photos.forEach((photo, i) => {
        const span = spanFor(photo, w, m);
        tiles[i]?.style.setProperty("--span", span);
      });
    }, 150);
  });
}

async function initGallery() {
  // Claim the reveal barrier before any await, so app.js cannot fade the
  // page in while the grid is still empty.
  const done = hold();
  try {
    await renderAll();
  } finally {
    // Released even on failure — an unreleased hold would leave the page
    // invisible until the timeout.
    done();
  }
}

async function renderAll() {
  const slug = slugFromPath();
  const host = document.querySelector(".masonry");

  if (!slug) {
    if (host) host.innerHTML = `<p class="t-body">Category not specified.</p>`;
    return;
  }

  try {
    const [cat, index] = await Promise.all([
      getCategory(slug),
      getIndex().catch(() => ({ categories: [] })),
    ]);

    const photos = (cat.photos ?? [])
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    renderHead(cat, photos.length);
    renderGrid(photos);
    renderNext(
      (index.categories ?? [])
        .filter((c) => c.published !== false)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      slug
    );

    // A shared #p=3 link should land straight on that photo.
    const deep = indexFromHash();
    if (deep !== null && deep < photos.length) openLightbox(photos, deep);

    /* Also react to hash changes on an ALREADY-LOADED page: pasting a #p=5
       link into the address bar while on this gallery changes only the hash,
       which does not reload the document. Without this, such a link silently
       does nothing — and browser back/forward would not reopen the viewer
       either. */
    window.addEventListener("hashchange", () => {
      const i = indexFromHash();
      if (i !== null && i < photos.length) openLightbox(photos, i);
      else closeLightbox();
    });
  } catch (err) {
    console.error(`Could not load category "${slug}":`, err);
    if (host) {
      host.innerHTML = `<p class="t-body">This category is unavailable. <a class="link-arrow" href="${url(
        ""
      )}">Back to all work</a></p>`;
    }
  }
}

initGallery();
