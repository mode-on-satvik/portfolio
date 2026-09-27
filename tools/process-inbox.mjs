/* ==========================================================================
   process-inbox.mjs — turn staged uploads into published photos

   Runs in the GitHub Actions workflow (and locally, identically). For every
   image in _inbox/<slug>/ it:

     · generates AVIF + WebP + JPEG at 400/800/1200/2000
     · generates the 24px LQIP blur placeholder
     · records the real pixel dimensions (for aspect-ratio → zero CLS)
     · STRIPS ALL METADATA, including GPS
     · appends a photo record to data/categories/<slug>.json
     · rebuilds data/index.json with a fresh cache fingerprint
     · empties _inbox/

   Optional _inbox/job.json carries the metadata the admin panel collected:

     { "message": "Add 2 formal suit photos",
       "photos": { "IMG_4821.jpg": { "alt": "...", "caption": "...",
                                     "slug": "formal-suit", "featured": true } },
       "categories": { "formal-suit": { "published": true, "blurb": "..." } } }

   IDEMPOTENT BY DESIGN. _inbox/ is emptied only after every image has been
   written, so a run that dies half-way leaves the originals in place and
   re-running is always safe. That property is what makes "just click Re-run"
   honest advice in DEPLOY.md.

     node tools/process-inbox.mjs
   ========================================================================== */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { processImage, contentHash, probeImage } from "./lib/images.mjs";
import {
  INBOX,
  IMAGES,
  readCategory,
  writeCategory,
  catPath,
  rebuildIndex,
} from "./lib/catalog.mjs";

/* Files that are definitely not the photo we were handed, excluded by name
   before any bytes are read. Everything ELSE is offered to the decoder and
   accepted if it decodes, rather than matched against an extension whitelist.

   The extension is not evidence: an iPhone set to "Most Compatible" still
   writes HEIC into files named .jpg, a Windows rename changes .png to .jpeg
   without touching a byte, and a download can append .jpg to a PDF. Gating on
   the name therefore rejected real photos and admitted real non-photos. The
   decoder is asked instead — see probeImage. */
const IGNORE_NAMES = new Set(["job.json", ".gitkeep", ".ds_store", "thumbs.db", "desktop.ini"]);
const IGNORE_EXT = new Set([".json", ".md", ".txt", ".zip", ".mov", ".mp4", ".pdf"]);

const isCandidate = (name) =>
  !name.startsWith(".") &&
  !IGNORE_NAMES.has(name.toLowerCase()) &&
  !IGNORE_EXT.has(path.extname(name).toLowerCase());

/* A hard ceiling. GitHub Pages has a 1 GB soft repo limit, and a single
   accidental 200 MB RAW file would eat a fifth of it. */
const MAX_BYTES = 30 * 1024 * 1024;

const log = (...a) => console.log(...a);

/** Read _inbox/job.json if the admin panel left one. */
async function readJob() {
  const file = path.join(INBOX, "job.json");
  if (!existsSync(file)) return { photos: {}, categories: {} };
  try {
    const job = JSON.parse(await readFile(file, "utf8"));
    return { photos: job.photos ?? {}, categories: job.categories ?? {}, message: job.message };
  } catch (err) {
    // Bad metadata must not cost you the photos. Publish them with fallback
    // alt text and let a human fix the wording afterwards.
    console.warn(`warn: _inbox/job.json is not valid JSON (${err.message}) — ignoring it`);
    return { photos: {}, categories: {} };
  }
}

/** Slug directories inside _inbox/, each holding staged images. */
async function inboxCategories() {
  if (!existsSync(INBOX)) return [];
  const entries = await readdir(INBOX, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function processCategory(slug, job) {
  const dir = path.join(INBOX, slug);

  if (!existsSync(catPath(slug))) {
    console.warn(
      `warn: _inbox/${slug}/ has no data/categories/${slug}.json — skipping.\n` +
        `      Create the category first, or check the folder name is the slug.`
    );
    return 0;
  }

  const entries = (await readdir(dir)).sort();
  const files = entries.filter(isCandidate);

  for (const f of entries.filter((f) => !isCandidate(f))) {
    console.warn(`warn: skipping non-image file _inbox/${slug}/${f}`);
  }

  if (!files.length) return 0;

  const cat = await readCategory(slug);
  const photos = cat.photos ?? [];

  /* The sample/placeholder records exist only so the layout is viewable
     before real photography. The moment a real photo lands, they go — leaving
     them would mix "NOT FINAL ARTWORK" frames into a live portfolio. */
  const kept = photos.filter((p) => !p.placeholder && !p.sample);
  const droppedFakes = photos.length - kept.length;
  if (droppedFakes) {
    log(`  dropping ${droppedFakes} placeholder/sample record(s) — real photos are arriving`);
  }

  const outDir = path.join(IMAGES, slug);
  let order = kept.reduce((max, p) => Math.max(max, p.order ?? 0), 0);
  const consumed = [];

  for (const file of files) {
    const src = path.join(dir, file);
    const { size } = await stat(src);

    if (size > MAX_BYTES) {
      console.warn(
        `warn: skipping ${file} — ${(size / 1048576).toFixed(1)} MB exceeds the ` +
          `${MAX_BYTES / 1048576} MB limit. Resize it before uploading.`
      );
      continue;
    }

    const buf = await readFile(src);

    /* Ask the decoder what this actually is, before spending any time on it.
       Reporting the real format is the useful part of the message: "photo.jpg
       — unsupported image format (heif)" tells a parent exactly what to do
       (re-save as JPEG), where "skipping photo.jpg" would look like a bug. */
    const probe = await probeImage(buf);
    if (!probe.ok) {
      console.warn(
        `warn: skipping ${file} — ${probe.reason}.\n` +
          `      If this came off an iPhone, set Settings → Camera → Formats to\n` +
          `      "Most Compatible", or re-save it as JPEG or PNG and upload again.`
      );
      continue;
    }

    const hash = await contentHash(buf);
    const meta = job.photos[file] ?? job.photos[`${slug}/${file}`] ?? {};

    /* The filename stem carries a content hash, which makes every output file
       immutable: the same bytes always produce the same name, and different
       bytes always produce a different one. That is what lets us treat images
       as cacheable forever despite Pages' fixed 10-minute header. */
    const stem = `${slug}-${String(order + 1).padStart(2, "0")}-${hash}`;

    let info;
    try {
      info = await processImage(buf, outDir, stem);
    } catch (err) {
      // One corrupt file must not abort the batch and strand the rest.
      console.warn(`warn: could not process ${file} — ${err.message}`);
      continue;
    }

    order += 1;
    consumed.push(src);

    kept.push({
      id: hash,
      base: `images/${slug}/${stem}`,
      w: info.w,
      h: info.h,
      lqip: info.lqip,
      formats: info.formats,
      widths: info.widths,
      /* Alt text is required by the admin uploader. This fallback exists only
         for the hand-drop route, and is deliberately written to look
         unfinished so it gets corrected rather than shipped. */
      alt: meta.alt || `${cat.title} — ${cat.subtitle} (alt text needed)`,
      caption: meta.caption || `${cat.subtitle} · ${String(order).padStart(2, "0")}`,
      order,
      featured: meta.featured === true,
      ...(meta.watermark ? { watermark: true } : {}),
    });

    log(`  ${stem}  ${info.w}×${info.h}  (${(size / 1024).toFixed(0)} KB source)`);
  }

  if (!consumed.length) return [];

  // Exactly one cover. An explicit `featured` wins; otherwise the first photo.
  if (!kept.some((p) => p.featured)) kept[0].featured = true;
  else {
    let seen = false;
    for (const p of kept) {
      if (p.featured && seen) p.featured = false;
      else if (p.featured) seen = true;
    }
  }

  Object.assign(cat, job.categories[slug] ?? {});
  cat.photos = kept;
  await writeCategory(slug, cat);
  log(
    `write  data/categories/${slug}.json  (${kept.length} photos, +${consumed.length})`
  );

  return consumed;
}

async function main() {
  const slugs = await inboxCategories();

  if (!slugs.length) {
    log("_inbox/ is empty — nothing to process.");
    return;
  }

  const job = await readJob();
  const consumed = [];

  for (const slug of slugs) {
    log(`\n${slug}`);
    consumed.push(...(await processCategory(slug, job)));
  }

  if (!consumed.length) {
    log("\nNo images were published. Leaving _inbox/ untouched so nothing is lost.");
    return;
  }

  const index = await rebuildIndex();
  log(`\nwrite  data/index.json  (rev ${index.rev})`);

  /* Clear the staging area ONLY now, after every write succeeded — and only
     the files we actually published.

     Deleting the whole directory would be simpler and wrong: anything skipped
     above (too large, corrupt, unsupported) would be destroyed without ever
     appearing on the site. Silently eating a photo because it was 31 MB is the
     worst possible failure here, since the parent may have no other copy. */
  for (const file of consumed) await rm(file, { force: true });
  await rm(path.join(INBOX, "job.json"), { force: true });

  // Remove now-empty slug directories; keep any that still hold skipped files.
  const leftovers = [];
  for (const slug of slugs) {
    const dir = path.join(INBOX, slug);
    if (!existsSync(dir)) continue;
    const rest = await readdir(dir);
    if (rest.length) leftovers.push(`_inbox/${slug}/ (${rest.join(", ")})`);
    else await rm(dir, { recursive: true, force: true });
  }

  log(`clear  _inbox/  (${consumed.length} published file(s) removed)`);
  if (leftovers.length) {
    log("\nLEFT IN PLACE — these were skipped, not published:");
    for (const l of leftovers) log(`  ${l}`);
  }

  log(`\nPublished ${consumed.length} photo(s). Next: node tools/build-pages.mjs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
