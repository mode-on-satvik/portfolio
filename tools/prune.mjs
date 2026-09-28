/* ==========================================================================
   prune.mjs — delete image files no category still references, then rebuild
   the index

   The admin panel deletes a photo by rewriting one file: the photo's entry
   comes out of data/categories/<slug>.json and that is the whole commit. It
   deliberately does NOT delete the 12 image variants itself, for two reasons.

   One: the panel commits through the Contents API, one request per file, so
   removing the variants from the browser would be 12 more commits for a single
   tap — and a batch interrupted half way would leave a category pointing at
   files that are already gone.

   Two, and the real reason: data/index.json is DERIVED. Its `count`, `cover`
   and cache-busting `rev` all come from the category files via
   rebuildIndex(). A panel that edited the category file and stopped would
   leave the index advertising a cover photo that no longer exists — which is
   precisely the failure already visible on the live site, where index.json
   names a cover base with no files behind it and the home page renders three
   broken images.

   So deletion is finished here instead, on the same run that publishes. The
   category files are the source of truth; anything in images/ that no category
   references is garbage, and this collects it.

   Idempotent and safe to run when nothing has been deleted: with no orphans it
   still rebuilds the index, which is a no-op write if nothing changed.

     node tools/prune.mjs [--dry-run]
   ========================================================================== */

import { readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  IMAGES,
  allSlugs,
  readCategory,
  rebuildIndex,
} from "./lib/catalog.mjs";

const DRY = process.argv.includes("--dry-run");
const log = (...a) => console.log(...a);

/**
 * Every `base` any category still references, as a Set.
 *
 * A photo's `base` is the filename stem shared by all 12 of its variants —
 * `images/sporty-basketball/sporty-basketball-01-ba48c6`, to which the
 * pipeline appends `-400.avif` and so on. Matching on the stem means this does
 * not need to know which widths or formats were generated, which matters
 * because that varies per photo: a source narrower than 2000px produces fewer
 * widths (see WIDTHS.filter in lib/images.mjs).
 */
async function referencedBases() {
  const keep = new Set();

  for (const slug of await allSlugs()) {
    const cat = await readCategory(slug);
    for (const photo of cat.photos ?? []) {
      if (photo.base) keep.add(photo.base);
    }
  }

  return keep;
}

/**
 * Split one variant filename back into the base it belongs to.
 *
 * `sporty-basketball-01-ba48c6-400.avif` → `sporty-basketball-01-ba48c6`.
 * Returns null for anything that is not shaped like a generated variant, so an
 * unrecognised file is LEFT ALONE rather than assumed to be junk. Deleting a
 * file we cannot explain is the one outcome worth avoiding here — the raw
 * camera originals sitting in images/formal-suit/ do not match this shape, and
 * must survive until a human decides what to do with them.
 */
function baseOf(filename) {
  const m = /^(.+)-(\d+)\.(avif|webp|jpg)$/.exec(filename);
  return m ? m[1] : null;
}

async function main() {
  if (!existsSync(IMAGES)) {
    log("images/ does not exist — nothing to prune.");
    return;
  }

  const keep = await referencedBases();
  log(`${keep.size} photo(s) referenced by the catalogue.`);

  const orphans = [];
  const unrecognised = [];

  for (const entry of await readdir(IMAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(IMAGES, entry.name);

    for (const file of await readdir(dir)) {
      const stem = baseOf(file);
      if (!stem) {
        unrecognised.push(`images/${entry.name}/${file}`);
        continue;
      }
      if (!keep.has(`images/${entry.name}/${stem}`)) {
        orphans.push(path.join(dir, file));
      }
    }
  }

  if (orphans.length) {
    log(`\n${orphans.length} orphaned variant file(s):`);
    for (const file of orphans) {
      log(`  ${DRY ? "would remove" : "remove"}  ${path.relative(IMAGES, file)}`);
      if (!DRY) await rm(file, { force: true });
    }
  } else {
    log("No orphaned image files.");
  }

  /* Report, do not delete. These are files this script cannot account for —
     most likely originals committed by hand, bypassing the pipeline. Naming
     them is useful; guessing at them is not. */
  if (unrecognised.length) {
    log(
      `\n${unrecognised.length} file(s) in images/ are not generated variants ` +
        `— left in place:`
    );
    for (const f of unrecognised.slice(0, 20)) log(`  ${f}`);
    if (unrecognised.length > 20) log(`  …and ${unrecognised.length - 20} more`);
  }

  /* Always rebuild, even with nothing pruned. A delete that removed the cover
     photo changes `cover` and `rev` in the index without touching a single
     image file, and skipping the rebuild there is the whole bug this exists to
     prevent. */
  if (DRY) {
    log("\n--dry-run: index.json not rewritten.");
    return;
  }

  const index = await rebuildIndex();
  log(`\nwrite  data/index.json  (rev ${index.rev})`);

  const empty = (index.categories ?? []).filter((c) => !c.cover);
  if (empty.length) {
    log(
      `\nnote: ${empty.length} categor${empty.length === 1 ? "y has" : "ies have"} ` +
        `no photos left: ${empty.map((c) => c.slug).join(", ")}`
    );
  }
}

main().catch((err) => {
  console.error(`\nprune failed: ${err.message}`);
  process.exit(1);
});
