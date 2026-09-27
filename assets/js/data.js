/* ==========================================================================
   data.js — JSON loading, caching, prefetch, and <picture> markup
   ========================================================================== */

import { url } from "./paths.js";

const CACHE_PREFIX = "pf:";
const inflight = new Map();

/* --- Fetch with a sessionStorage layer ---------------------------------
   Back-navigation should be instant. GitHub Pages pins Cache-Control to
   ~10 minutes and we cannot change response headers, so we keep our own
   session-lifetime cache rather than relying on the HTTP cache. */
async function getJSON(path) {
  const key = CACHE_PREFIX + path;

  try {
    const hit = sessionStorage.getItem(key);
    if (hit) return JSON.parse(hit);
  } catch {
    /* storage unavailable — fall through to network */
  }

  // De-duplicate concurrent requests for the same file (prefetch + click).
  if (inflight.has(path)) return inflight.get(path);

  const req = fetch(url(path), { credentials: "omit" })
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status} loading ${path}`);
      return res.json();
    })
    .then((json) => {
      try {
        sessionStorage.setItem(key, JSON.stringify(json));
      } catch {
        /* quota exceeded — cache is an optimisation, not a requirement */
      }
      inflight.delete(path);
      return json;
    })
    .catch((err) => {
      inflight.delete(path);
      throw err;
    });

  inflight.set(path, req);
  return req;
}

export const getProfile = () => getJSON("data/profile.json");
export const getIndex = () => getJSON("data/index.json");
export const getCategory = (slug) => getJSON(`data/categories/${slug}.json`);

/** Warm the cache for a gallery before the click lands. */
export function prefetchCategory(slug) {
  getCategory(slug).catch(() => {
    /* Prefetch is best-effort and must stay silent: a failure here is
       invisible to the user, and the real click will surface any error. */
  });
}

/* --- Image markup ------------------------------------------------------- */

export const WIDTHS = [400, 800, 1200, 2000];

/**
 * Build a <picture> for a photo record.
 *
 * `sizes` is the single highest-impact line on the page: it tells the
 * browser how wide the image will RENDER, so a phone downloads the 400w
 * file instead of the 2000w one — routinely a 10x saving.
 */
export function pictureHTML(photo, { sizes, eager = false, className = "" }) {
  const base = url(photo.base);
  const set = (ext) =>
    WIDTHS.map((w) => `${base}-${w}.${ext} ${w}w`).join(", ");

  const alt = escapeAttr(photo.alt || "");
  const lqip = photo.lqip ? `background-image:url('${photo.lqip}')` : "";
  const loading = eager ? "eager" : "lazy";
  const priority = eager ? 'fetchpriority="high"' : "";

  return `<picture class="${className}">
  <source type="image/avif" srcset="${set("avif")}" sizes="${sizes}">
  <source type="image/webp" srcset="${set("webp")}" sizes="${sizes}">
  <img src="${base}-800.jpg" srcset="${set("jpg")}" sizes="${sizes}"
       width="${photo.w}" height="${photo.h}" alt="${alt}"
       loading="${loading}" decoding="async" ${priority}
       style="${lqip}">
</picture>`;
}

export function escapeAttr(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export const escapeHTML = escapeAttr;
