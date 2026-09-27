/* ==========================================================================
   lightbox.js — fullscreen viewer: keyboard, swipe, deep-link, focus trap
   ========================================================================== */

import { WIDTHS, escapeAttr } from "./data.js";
import { url } from "./paths.js";

let photos = [];
let index = 0;
let lastFocus = null;
let root = null;
let els = {};

/* The largest variant is plenty for a fullscreen view and far cheaper than
   the 2000w on a phone. `sizes="100vw"` lets the browser pick correctly. */
const LB_SIZES = "100vw";

function build() {
  root = document.createElement("div");
  root.className = "lb";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Photo viewer");

  root.innerHTML = `
    <div class="lb__bar">
      <span class="lb__count" data-lb-count aria-live="polite"></span>
      <button class="lb__btn" type="button" data-lb-close aria-label="Close viewer">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>

    <div class="lb__stage" data-lb-stage>
      <button class="lb__btn lb__nav lb__nav--prev" type="button" data-lb-prev
              aria-label="Previous photo">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
      </button>
      <picture data-lb-pic></picture>
      <button class="lb__btn lb__nav lb__nav--next" type="button" data-lb-next
              aria-label="Next photo">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
      </button>
    </div>

    <p class="lb__cap" data-lb-cap></p>`;

  document.body.append(root);

  els = {
    count: root.querySelector("[data-lb-count]"),
    pic: root.querySelector("[data-lb-pic]"),
    cap: root.querySelector("[data-lb-cap]"),
    prev: root.querySelector("[data-lb-prev]"),
    next: root.querySelector("[data-lb-next]"),
    close: root.querySelector("[data-lb-close]"),
    stage: root.querySelector("[data-lb-stage]"),
  };

  els.close.addEventListener("click", close);
  els.prev.addEventListener("click", () => go(index - 1));
  els.next.addEventListener("click", () => go(index + 1));

  // Click the backdrop (but not the photo or a control) to dismiss.
  els.stage.addEventListener("click", (e) => {
    if (e.target === els.stage) close();
  });

  bindSwipe();
}

/** Horizontal swipe on touch. Vertical drags are left alone for scrolling. */
function bindSwipe() {
  let x0 = null;
  let y0 = null;

  els.stage.addEventListener(
    "touchstart",
    (e) => {
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    },
    { passive: true }
  );

  els.stage.addEventListener(
    "touchend",
    (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      x0 = y0 = null;

      // Require both a decent distance and a mostly-horizontal gesture, or
      // a slightly diagonal scroll would flick through the photos.
      if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy)) return;
      go(dx < 0 ? index + 1 : index - 1);
    },
    { passive: true }
  );
}

function render() {
  const photo = photos[index];
  if (!photo) return;

  els.count.textContent = `${index + 1} / ${photos.length}`;
  els.cap.textContent = photo.caption || "";
  els.prev.disabled = index === 0;
  els.next.disabled = index === photos.length - 1;

  if (photo.placeholder) {
    // Never emit <picture> for files that do not exist yet.
    els.pic.innerHTML = `<div class="ph lb__img is-shown" role="img"
      aria-label="${escapeAttr(photo.alt || "")}"
      style="width:min(70vw,420px);aspect-ratio:${photo.w} / ${photo.h}"></div>`;
  } else {
    const base = url(photo.base);
    const set = (ext) =>
      WIDTHS.map((w) => `${base}-${w}.${ext} ${w}w`).join(", ");

    els.pic.innerHTML = `
      <source type="image/avif" srcset="${set("avif")}" sizes="${LB_SIZES}">
      <source type="image/webp" srcset="${set("webp")}" sizes="${LB_SIZES}">
      <img class="lb__img" src="${base}-1200.jpg" srcset="${set("jpg")}"
           sizes="${LB_SIZES}" width="${photo.w}" height="${photo.h}"
           alt="${escapeAttr(photo.alt || "")}" decoding="async">`;

    const img = els.pic.querySelector("img");
    // Fade in only once decoded, so we never flash a half-painted image.
    if (img.complete) img.classList.add("is-shown");
    else img.addEventListener("load", () => img.classList.add("is-shown"), { once: true });
  }

  prefetchNeighbours();
  syncHash();
}

/** Warm the adjacent photos so arrow-keying through feels instant. */
function prefetchNeighbours() {
  for (const i of [index + 1, index - 1]) {
    const photo = photos[i];
    if (!photo || photo.placeholder) continue;
    const img = new Image();
    img.decoding = "async";
    img.src = `${url(photo.base)}-1200.jpg`;
  }
}

/* Deep-linkable as #p=3 (1-based, so it reads naturally when shared).
   replaceState, not pushState: paging through 20 photos should not bury the
   gallery under 20 history entries that all have to be backed out of. */
function syncHash() {
  const hash = `#p=${index + 1}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function clearHash() {
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}

function go(i) {
  if (i < 0 || i >= photos.length) return;
  index = i;
  render();
}

function onKeydown(e) {
  switch (e.key) {
    case "Escape":
      close();
      break;
    case "ArrowRight":
      go(index + 1);
      break;
    case "ArrowLeft":
      go(index - 1);
      break;
    case "Home":
      go(0);
      break;
    case "End":
      go(photos.length - 1);
      break;
    case "Tab":
      trapTab(e);
      break;
    default:
      return;
  }
  // Arrow keys would otherwise scroll the gallery behind the overlay.
  if (e.key !== "Tab") e.preventDefault();
}

/** Keep focus inside the dialog — required for an aria-modal overlay. */
function trapTab(e) {
  const focusable = [...root.querySelectorAll("button:not([disabled])")];
  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export function open(list, i = 0, opener = null) {
  if (!root) build();

  photos = list;
  index = Math.min(Math.max(i, 0), list.length - 1);
  lastFocus = opener || document.activeElement;

  render();
  root.classList.add("is-open");

  /* Lock the page behind the overlay. Compensating for the scrollbar width
     avoids the content jumping sideways as it disappears. */
  const sbw = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.overflow = "hidden";
  if (sbw > 0) document.body.style.paddingRight = `${sbw}px`;

  document.addEventListener("keydown", onKeydown);
  els.close.focus();
}

export function close() {
  if (!root?.classList.contains("is-open")) return;

  root.classList.remove("is-open");
  document.body.style.overflow = "";
  document.body.style.paddingRight = "";
  document.removeEventListener("keydown", onKeydown);
  clearHash();

  // Return focus to the tile that opened it, or the keyboard user is
  // dumped back at the top of the document.
  lastFocus?.focus?.();
  lastFocus = null;
}

/** Read #p=N on load so a shared link opens straight onto that photo. */
export function indexFromHash() {
  const match = /^#p=(\d+)$/.exec(location.hash);
  if (!match) return null;
  const n = Number(match[1]) - 1;
  return Number.isInteger(n) && n >= 0 ? n : null;
}
