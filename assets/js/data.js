/* ==========================================================================
   data.js — JSON loading, caching, prefetch, and <picture> markup
   ========================================================================== */

import { url } from "./paths.js";

const CACHE_PREFIX = "pf:";
const inflight = new Map();

/* --- Cache versioning ---------------------------------------------------
   A session cache with no version key is a correctness bug, not just a
   stale-data annoyance: after a publish, every already-open tab keeps
   serving the old JSON for the life of the tab — including broken image
   paths for photos that were replaced.

   So: the two small always-needed files (index, profile) are fetched from
   the network every page load — a few KB, and the HTTP cache absorbs
   repeats. The large per-category files are cached under the `updated`
   stamp from index.json, so a publish invalidates them automatically. */
let version = null;

function setVersion(stamp) {
  if (!stamp || stamp === version) return;
  version = stamp;

  // Drop every entry from a previous publish, or storage fills with
  // orphaned generations that are never read again.
  try {
    const keep = `${CACHE_PREFIX}${version}:`;
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(CACHE_PREFIX) && !key.startsWith(keep)) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    /* storage unavailable — nothing to prune */
  }
}

/**
 * Fetch JSON, optionally through a version-keyed sessionStorage layer.
 *
 * @param {string} path      site-relative path
 * @param {boolean} cacheable false = always hit the network
 */
async function getJSON(path, cacheable = true) {
  // Unversioned data must not be cached: without a stamp we have no way to
  // know whether the entry is current.
  const key = cacheable && version ? `${CACHE_PREFIX}${version}:${path}` : null;

  if (key) {
    try {
      const hit = sessionStorage.getItem(key);
      if (hit) return JSON.parse(hit);
    } catch {
      /* storage unavailable — fall through to network */
    }
  }

  // De-duplicate concurrent requests for the same file (prefetch + click).
  if (inflight.has(path)) return inflight.get(path);

  const req = fetch(url(path), { credentials: "omit" })
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status} loading ${path}`);
      return res.json();
    })
    .then((json) => {
      if (key) {
        try {
          sessionStorage.setItem(key, JSON.stringify(json));
        } catch {
          /* quota exceeded — cache is an optimisation, not a requirement */
        }
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

export const getProfile = () => getJSON("data/profile.json", false);

export async function getIndex() {
  const index = await getJSON("data/index.json", false);
  /* Prefer `rev` (a content fingerprint) over `updated` (a date). A date
     cannot distinguish two publishes on the same day, which silently serves
     stale category JSON to any tab that is already open. */
  setVersion(index.rev || index.updated);
  return index;
}

/**
 * A gallery needs the version stamp to cache under, so ensure the index has
 * been read first. It is nearly always already resolved and in-flight
 * de-duplicated by this point, so this costs nothing in practice.
 */
export async function getCategory(slug) {
  if (!version) await getIndex().catch(() => {});
  return getJSON(`data/categories/${slug}.json`);
}

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

  /* Use the widths the PROCESSOR actually wrote, never the full wishlist. A
     1400px source has no -2000 variant, so emitting a `2000w` candidate both
     404s and lies to the browser's selection maths. */
  const widths = photo.widths?.length ? photo.widths : WIDTHS;
  const set = (ext) => widths.map((w) => `${base}-${w}.${ext} ${w}w`).join(", ");

  // Fallback `src` for browsers that ignore srcset: the mid-size variant if it
  // exists, otherwise the widest one that does.
  const fallback = widths.includes(800) ? 800 : widths.at(-1);

  const alt = escapeAttr(photo.alt || "");
  const lqip = photo.lqip ? `background-image:url('${photo.lqip}')` : "";
  const loading = eager ? "eager" : "lazy";
  const priority = eager ? 'fetchpriority="high"' : "";

  return `<picture class="${className}">
  <source type="image/avif" srcset="${set("avif")}" sizes="${sizes}">
  <source type="image/webp" srcset="${set("webp")}" sizes="${sizes}">
  <img src="${base}-${fallback}.jpg" srcset="${set("jpg")}" sizes="${sizes}"
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
