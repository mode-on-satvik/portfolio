/* ==========================================================================
   build-pages.mjs — generate /work/<slug>/index.html for every category

   GitHub Pages cannot rewrite URLs, so a pretty path like /work/formal-suit/
   has to be a real directory containing a real index.html. One small file per
   category, generated from data/index.json.

   Every generated page sets data-depth="2" so paths.js resolves assets with
   "../../" — which is what lets the same build serve from both
   /portfolio/ (project page) and a bare custom domain.

     node tools/build-pages.mjs
   ========================================================================== */

import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const read = (p) => readFile(path.join(ROOT, p), "utf8").then(JSON.parse);

const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** One gallery page. `depth` is 2 for /work/<slug>/. */
function page(cat, profile) {
  const name = profile.firstName || "Portfolio";
  const title = `${cat.title} — ${name}`;
  const desc =
    cat.blurb ||
    `${cat.title} — portfolio of ${name}, child model based in ${profile.city}.`;

  return `<!doctype html>
<html lang="en" data-depth="2" data-theme="dark" class="no-js"
      data-title-tpl="{category} — ${esc(name)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />

    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}" />

    <meta name="robots" content="index, follow, noai, noimageai, max-image-preview:standard" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />

    <meta property="og:type" content="article" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta name="twitter:card" content="summary_large_image" />

    <link rel="canonical" href="./" />
    <link rel="icon" href="../../assets/img/favicon.svg" type="image/svg+xml" />

    <!-- Theme before first paint, or a dark-theme visitor sees a white flash -->
    <script>
      (function () {
        try {
          var saved = localStorage.getItem("pf-theme");
          var prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
          document.documentElement.dataset.theme =
            saved || (prefersLight ? "light" : "dark");
        } catch (e) {}
      })();
    </script>

    <link rel="preload" href="../../assets/fonts/fraunces-var.woff2" as="font"
          type="font/woff2" crossorigin />
    <link rel="preload" href="../../data/categories/${cat.slug}.json" as="fetch" crossorigin />

    <link rel="stylesheet" href="../../assets/css/tokens.css" />
    <link rel="stylesheet" href="../../assets/css/base.css" />
    <link rel="stylesheet" href="../../assets/css/layout.css" />
    <link rel="stylesheet" href="../../assets/css/gallery.css" />
    <link rel="stylesheet" href="../../assets/css/lightbox.css" />

    <script type="module" src="../../assets/js/app.js"></script>
    <script type="module" src="../../assets/js/gallery.js"></script>
  </head>

  <body class="is-loading">
    <a class="skip-link" href="#main">Skip to content</a>

    <header class="nav">
      <a class="nav__brand" href="../../" data-bind="firstName">${esc(name)}</a>

      <div class="nav__right">
        <nav class="nav__links" aria-label="Primary">
          <a class="nav__link" href="../../" aria-current="page">Work</a>
          <a class="nav__link" href="../../about/">About</a>
          <a class="nav__link" href="../../contact/">Contact</a>
        </nav>

        <button class="nav__icon" data-theme-toggle type="button"
                aria-label="Switch to light theme">
          <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
          <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        </button>

        <button class="nav__icon nav__burger" type="button" aria-label="Open menu"
                aria-expanded="false" aria-controls="menu">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18M3 12h18M3 17h18" /></svg>
        </button>
      </div>
    </header>

    <nav class="menu" id="menu" aria-hidden="true" aria-label="Menu">
      <a class="menu__link" href="../../" style="--i: 0"><span class="menu__num">01</span> Work</a>
      <a class="menu__link" href="../../about/" style="--i: 1"><span class="menu__num">02</span> About</a>
      <a class="menu__link" href="../../contact/" style="--i: 2"><span class="menu__num">03</span> Contact</a>
    </nav>

    <main id="main" class="wrap">
      <header class="ghead">
        <a class="ghead__back" href="../../">&larr; All work</a>

        <div class="ghead__row">
          <h1 class="ghead__title" data-g-title>${esc(cat.title)}</h1>
          <span class="ghead__count" data-g-count></span>
        </div>

        <p class="ghead__meta" data-g-meta></p>
        <p class="ghead__blurb t-body" data-g-blurb>${esc(cat.blurb)}</p>
      </header>

      <div class="masonry">
        <!-- Rendered by gallery.js -->
      </div>

      <section class="gnext" data-g-next aria-label="Next category"></section>
    </main>

    <footer class="footer">
      <div class="wrap">
        <div class="footer__bottom">
          <span class="t-micro">
            &copy; <span data-bind="firstName">${esc(name)}</span> &mdash;
            <span data-bind="city">${esc(profile.city)}</span>,
            <span data-bind="country">${esc(profile.country)}</span>
          </span>
          <a class="t-micro" href="mailto:${esc(profile.contactEmail)}" data-bind-email>Enquiries</a>
        </div>
      </div>
    </footer>
  </body>
</html>
`;
}

async function main() {
  const [index, profile] = await Promise.all([
    read("data/index.json"),
    read("data/profile.json"),
  ]);

  const workDir = path.join(ROOT, "work");
  const live = (index.categories ?? []).filter((c) => c.published !== false);
  const slugs = new Set(live.map((c) => c.slug));

  await mkdir(workDir, { recursive: true });

  for (const cat of live) {
    const dir = path.join(workDir, cat.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), page(cat, profile));
    console.log(`write  work/${cat.slug}/index.html`);
  }

  /* Remove pages for categories that were deleted or unpublished. Without
     this, an unpublished category stays reachable by direct URL and keeps
     appearing in search results. */
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(workDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || slugs.has(entry.name)) continue;
    await rm(path.join(workDir, entry.name), { recursive: true, force: true });
    console.log(`remove work/${entry.name}/  (no longer published)`);
  }

  if (!existsSync(path.join(ROOT, ".nojekyll"))) {
    console.warn("warn: .nojekyll missing — Jekyll may strip _inbox/");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
