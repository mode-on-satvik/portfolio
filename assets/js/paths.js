/* ==========================================================================
   paths.js — resolve URLs so the SAME build works at any mount point.

   The site must serve correctly from BOTH:
     https://mode-on-satvik.github.io/portfolio/   (today, project Pages)
     https://satvik.is-a.dev/                      (later, custom domain)

   Root-absolute paths like "/assets/app.css" break on the first of those,
   which is the classic GitHub Pages subpath trap. So every page declares
   its own depth and we resolve against that — no build-time base injection,
   no per-environment config.

     <html data-depth="0">   →  /            or /portfolio/
     <html data-depth="2">   →  /work/formal-suit/

   Depth is the number of directory levels BELOW the site root.
   ========================================================================== */

const depth = Number(document.documentElement.dataset.depth ?? 0);

/** Prefix to climb back to the site root: "", "../", "../../" … */
export const ROOT = depth > 0 ? "../".repeat(depth) : "";

/** Resolve a site-root-relative path (no leading slash) for the current page. */
export function url(path) {
  return ROOT + String(path).replace(/^\/+/, "");
}

/** Absolute URL for canonical links, OG tags and sitemaps. */
export function absolute(path) {
  return new URL(url(path), document.baseURI).href;
}

/** Site origin + mount point, e.g. "https://…github.io/portfolio/" */
export function siteRoot() {
  return new URL(ROOT || ".", document.baseURI).href;
}
