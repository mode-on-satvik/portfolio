/* ==========================================================================
   lib/catalog.mjs — read/write the JSON catalogue

   `data/index.json` is derived data: every field in it comes from the category
   files. Keeping the derivation in ONE place means make-dummies.mjs and
   process-inbox.mjs cannot drift apart and produce subtly different indexes.
   ========================================================================== */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DATA = path.join(ROOT, "data");
export const CATS = path.join(DATA, "categories");
export const IMAGES = path.join(ROOT, "images");
export const INBOX = path.join(ROOT, "_inbox");

const readJSON = (p) => readFile(p, "utf8").then(JSON.parse);
const writeJSON = (p, v) => writeFile(p, JSON.stringify(v, null, 2) + "\n");

export const catPath = (slug) => path.join(CATS, `${slug}.json`);
export const readCategory = (slug) => readJSON(catPath(slug));
export const writeCategory = (slug, cat) => writeJSON(catPath(slug), cat);

/** Every category slug that has a JSON file, whether published or not. */
export async function allSlugs() {
  const files = await readdir(CATS);
  return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
}

/**
 * Rebuild data/index.json from the category files.
 *
 * Returns the new index so callers can log what changed.
 */
export async function rebuildIndex() {
  const indexPath = path.join(DATA, "index.json");
  const index = await readJSON(indexPath);

  for (const entry of index.categories ?? []) {
    const file = catPath(entry.slug);
    if (!existsSync(file)) continue;

    const cat = await readJSON(file);
    const photos = (cat.photos ?? [])
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    // Mirror the editable fields back, so the category file is the single
    // place a human edits copy and the index follows.
    entry.title = cat.title ?? entry.title;
    entry.subtitle = cat.subtitle ?? entry.subtitle;
    entry.blurb = cat.blurb ?? entry.blurb;
    entry.published = cat.published !== false;
    entry.count = photos.length;

    /* `order` too, and this one was missing. The admin panel's reorder arrows
       write `order` into the two affected CATEGORY files and nothing else, but
       the home page reads the index — so without this line a reorder made from
       the panel is silently discarded, forever. The live data had already
       drifted this way: formal-suit and sporty-basketball were swapped in the
       category files and still in the old order on the site. */
    entry.order = cat.order ?? entry.order;

    const cover = photos.find((p) => p.featured) ?? photos[0];
    if (!cover) {
      entry.cover = null;
      continue;
    }

    entry.rev = cover.base.split("-").pop(); // content hash of the cover file
    entry.cover = {
      base: cover.base,
      w: cover.w,
      h: cover.h,
      lqip: cover.lqip,
      alt: cover.alt,
      /* Carry both flags through, or the homepage emits <picture> markup for
         files that do not exist and 404s once per category. */
      ...(cover.placeholder ? { placeholder: true } : {}),
      ...(cover.sample ? { sample: true } : {}),
    };
  }

  index.categories?.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  /* The cache-version stamp. This MUST change whenever any category content
     changes, or a browser with the site already open keeps serving the
     previous generation out of sessionStorage for the life of the tab.

     A date is NOT enough: two publishes on the same day collide, which is
     exactly how the first batch of sample images came out invisible. So it is
     a content fingerprint. */
  index.rev = createHash("sha256")
    .update(JSON.stringify(index.categories))
    .digest("hex")
    .slice(0, 8);
  index.updated = new Date().toISOString().slice(0, 10);

  await writeJSON(indexPath, index);
  return index;
}
