/* ==========================================================================
   make-dummies.mjs — generate sample photographs so the layout can be seen

   Real image files, in real formats, at real sizes — so the masonry, the
   srcset/sizes selection, the LQIP blur-up and the lightbox can all be
   judged properly. What a grey box cannot show you is whether the grid
   rhythm actually works.

   Every frame is visibly marked SAMPLE and carries the category name, so it
   can never be mistaken for the child's real photography.

     node tools/make-dummies.mjs            # all categories
     node tools/make-dummies.mjs formal-suit
     node tools/make-dummies.mjs --clean    # remove them again

   Replacing these with real photos is just an upload through /admin/ — the
   JSON records are overwritten and the `sample` flag disappears.
   ========================================================================== */

import sharp from "sharp";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { processImage, contentHash } from "./lib/images.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CATS = path.join(ROOT, "data", "categories");
const IMAGES = path.join(ROOT, "images");

/* A palette per category, chosen to sit against the dark editorial ground
   rather than fight it. Deliberately muted — a portfolio of neon test cards
   tells you nothing about how the real thing will look. */
const PALETTES = {
  "formal-suit": { bg: "#1b2333", fg: "#8fa2c4", accent: "#c8b18a" },
  "sporty-basketball": { bg: "#2b2118", fg: "#d69a5c", accent: "#e8c9a0" },
  "ethnic-jacket-set": { bg: "#2a1d24", fg: "#c08aa0", accent: "#e0bfa8" },
  "ethnic-festive": { bg: "#33241a", fg: "#e0a765", accent: "#f0d2a4" },
  "sporty-scooter": { bg: "#1a2a2b", fg: "#7bb5b8", accent: "#cfe3d8" },
  "cultural-striped-shirt": { bg: "#232a20", fg: "#9db482", accent: "#dbe0c0" },
};

const FALLBACK = { bg: "#242424", fg: "#8c8c8c", accent: "#d0c4b0" };

/* Five shapes, matching the placeholder records seeded earlier, so the
   masonry is exercised against portrait, landscape and square tiles. */
const SHAPES = [
  [1200, 1500], // 4:5 portrait
  [1200, 1600], // 3:4 portrait
  [1600, 1200], // 4:3 landscape
  [1200, 1200], // square
  [1200, 1800], // 2:3 tall
];

const esc = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * An SVG "photograph": soft vignette, an off-centre subject mass roughly
 * where a standing figure would be, and a film-style caption bar. Enough
 * structure that the grid reads like a real contact sheet.
 */
function frameSVG(w, h, n, title, pal) {
  const cx = w / 2;
  // Vary the subject position per frame so the sheet is not mechanical.
  const offset = [(n % 3) - 1] * 0.08 * w;
  const figX = cx + offset;
  const figW = w * 0.34;
  const figH = h * 0.62;
  const figY = h * 0.3;
  const label = esc(title.toUpperCase());
  const num = String(n).padStart(2, "0");

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="${pal.bg}" stop-opacity="1"/>
      <stop offset="60%" stop-color="${pal.bg}" stop-opacity="0.82"/>
      <stop offset="100%" stop-color="#0b0a0a" stop-opacity="1"/>
    </linearGradient>
    <radialGradient id="key" cx="50%" cy="34%" r="62%">
      <stop offset="0%"   stop-color="${pal.fg}" stop-opacity="0.34"/>
      <stop offset="100%" stop-color="${pal.fg}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="subject" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="${pal.fg}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${pal.fg}" stop-opacity="0.16"/>
    </linearGradient>
  </defs>

  <rect width="${w}" height="${h}" fill="url(#ground)"/>
  <rect width="${w}" height="${h}" fill="url(#key)"/>

  <!-- Subject mass: a soft rounded column where a figure would stand -->
  <rect x="${figX - figW / 2}" y="${figY}" width="${figW}" height="${figH}"
        rx="${figW / 2}" fill="url(#subject)"/>
  <circle cx="${figX}" cy="${figY - h * 0.055}" r="${w * 0.072}"
          fill="${pal.fg}" fill-opacity="0.42"/>

  <!-- Frame rule and slate, like a contact sheet -->
  <rect x="${w * 0.04}" y="${h * 0.04}" width="${w * 0.92}" height="${h * 0.92}"
        fill="none" stroke="${pal.accent}" stroke-opacity="0.22" stroke-width="2"/>

  <text x="${w * 0.07}" y="${h * 0.11}" fill="${pal.accent}" fill-opacity="0.85"
        font-family="Georgia,serif" font-size="${Math.round(w * 0.032)}"
        letter-spacing="${w * 0.004}">${label}</text>

  <text x="${w * 0.07}" y="${h * 0.955}" fill="${pal.accent}" fill-opacity="0.6"
        font-family="Helvetica,Arial,sans-serif" font-size="${Math.round(w * 0.022)}"
        letter-spacing="${w * 0.005}">SAMPLE IMAGE · ${num} · ${w}×${h}</text>

  <text x="${w * 0.93}" y="${h * 0.955}" text-anchor="end"
        fill="${pal.accent}" fill-opacity="0.45"
        font-family="Helvetica,Arial,sans-serif" font-size="${Math.round(w * 0.022)}"
        letter-spacing="${w * 0.004}">NOT FINAL ARTWORK</text>
</svg>`);
}

async function buildCategory(slug) {
  const file = path.join(CATS, `${slug}.json`);
  if (!existsSync(file)) {
    console.warn(`skip   ${slug} — no data/categories/${slug}.json`);
    return null;
  }

  const cat = JSON.parse(await readFile(file, "utf8"));
  const photos = cat.photos ?? [];

  // Never overwrite real photography.
  const real = photos.filter((p) => !p.placeholder && !p.sample);
  if (real.length) {
    console.log(`skip   ${slug} — has ${real.length} real photo(s)`);
    return cat;
  }

  const outDir = path.join(IMAGES, slug);
  const pal = PALETTES[slug] ?? FALLBACK;
  const next = [];

  for (const [i, photo] of photos.entries()) {
    const [w, h] = SHAPES[i % SHAPES.length];
    const svg = frameSVG(w, h, i + 1, cat.title, pal);

    // Rasterise the SVG, then run the SAME pipeline the workflow uses.
    const png = await sharp(svg).png().toBuffer();
    const hash = await contentHash(png);
    const stem = `sample-${String(i + 1).padStart(2, "0")}-${hash}`;

    const info = await processImage(png, outDir, stem);

    next.push({
      ...photo,
      base: `images/${slug}/${stem}`,
      w: info.w,
      h: info.h,
      lqip: info.lqip,
      formats: info.formats,
      widths: info.widths,
      alt: `${cat.title} — sample frame ${i + 1}, placeholder for photography`,
      caption: photo.caption ?? `${cat.subtitle} · ${String(i + 1).padStart(2, "0")}`,
      // `placeholder` is gone (these are real files now), but `sample` stays
      // so the admin panel and seed script can still tell them apart.
      placeholder: undefined,
      sample: true,
    });

    process.stdout.write(`  ${stem}  ${info.w}×${info.h}\n`);
  }

  // Drop the undefined keys rather than serialising them as nulls.
  cat.photos = next.map((p) => JSON.parse(JSON.stringify(p)));
  await writeFile(file, JSON.stringify(cat, null, 2) + "\n");
  console.log(`write  data/categories/${slug}.json  (${next.length} sample photos)`);
  return cat;
}

/** Rebuild index.json covers from the (now updated) category files. */
async function rebuildIndex() {
  const indexPath = path.join(ROOT, "data", "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));

  for (const entry of index.categories ?? []) {
    const file = path.join(CATS, `${entry.slug}.json`);
    if (!existsSync(file)) continue;
    const cat = JSON.parse(await readFile(file, "utf8"));
    const photos = cat.photos ?? [];
    const cover = photos.find((p) => p.featured) ?? photos[0];
    if (!cover) continue;

    entry.count = photos.length;
    entry.rev = cover.base.split("-").pop(); // content hash of the cover
    entry.cover = {
      base: cover.base,
      w: cover.w,
      h: cover.h,
      lqip: cover.lqip,
      alt: cover.alt,
      // Carry both flags through, or the homepage emits <picture> for files
      // that do not exist.
      ...(cover.placeholder ? { placeholder: true } : {}),
      ...(cover.sample ? { sample: true } : {}),
    };
  }

  /* Bump the cache-version stamp. This MUST change whenever any category
     content changes, or browsers with the site already open keep serving the
     previous generation from sessionStorage. A date alone is not enough —
     two publishes on the same day would collide, which is exactly how the
     sample images came out invisible the first time. */
  const { createHash } = await import("node:crypto");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(index.categories))
    .digest("hex")
    .slice(0, 8);
  index.updated = new Date().toISOString().slice(0, 10);
  index.rev = fingerprint;

  await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n");
  console.log(`write  data/index.json  (rev ${fingerprint})`);
}

async function clean() {
  if (existsSync(IMAGES)) {
    await rm(IMAGES, { recursive: true, force: true });
    console.log("remove images/");
  }
  // Put the placeholder records back so the site still renders.
  console.log("Run `node tools/seed.mjs` to restore placeholder records.");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--clean")) {
    await clean();
    return;
  }

  const only = args.filter((a) => !a.startsWith("-"));
  const slugs = only.length
    ? only
    : (await readdir(CATS)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

  for (const slug of slugs) await buildCategory(slug);
  await rebuildIndex();

  console.log(
    `\nDone. ${slugs.length} categor${slugs.length === 1 ? "y" : "ies"}.` +
      `\nNext: node tools/build-pages.mjs  (regenerate /work/<slug>/ pages)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
