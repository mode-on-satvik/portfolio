/* ==========================================================================
   build-og.mjs — the social share card

   Every page carries <meta property="og:image" content=".../og-default.jpg">.
   That file was referenced but never existed, so every link shared to
   WhatsApp, iMessage, Facebook or LinkedIn rendered as a bare grey box — the
   single most visible page of the site, on the one surface where a portfolio
   is actually passed around.

   So it is GENERATED from the real photography rather than hand-made, which
   means it cannot drift: re-run after publishing and the card shows the
   current cover shot.

     node tools/build-og.mjs

   Output: assets/img/og-default.jpg at 1200x630.

   1200x630 is the size every scraper wants (1.91:1). The portfolio's photos
   are PORTRAIT (1200x1500), so a plain cover-crop would keep a thin horizontal
   band across the middle of the frame — typically a torso with the face cut
   off. Instead the photo is fitted whole into the left of the card against a
   colour sampled from its own edges, with the name set beside it. Nothing is
   cropped away, and the result reads as a designed card rather than a
   mis-cropped photo.
   ========================================================================== */

import sharp from "sharp";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CATS = path.join(ROOT, "data", "categories");
const OUT = path.join(ROOT, "assets", "img", "og-default.jpg");

const W = 1200;
const H = 630;

/** Escape text for inclusion in the SVG text layer. */
const xml = (s) =>
  String(s).replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]
  );

/**
 * The photo to feature: the cover of the first published category that has
 * one. Prefers a real photo over a sample, because once real photography
 * lands the samples are what we do NOT want on the share card.
 */
async function pickPhoto() {
  if (!existsSync(CATS)) return null;

  const files = (await readdir(CATS)).filter((f) => f.endsWith(".json")).sort();
  const candidates = [];

  for (const file of files) {
    let cat;
    try {
      cat = JSON.parse(await readFile(path.join(CATS, file), "utf8"));
    } catch {
      continue; // a malformed category must not break the build
    }
    if (cat.published === false) continue;

    const photos = cat.photos ?? [];
    const cover = photos.find((p) => p.featured) ?? photos[0];
    if (!cover?.base) continue;

    candidates.push({ cover, isSample: Boolean(cover.sample || cover.placeholder) });
  }

  // Real photography wins, whatever order the categories happen to sort in.
  return (candidates.find((c) => !c.isSample) ?? candidates[0])?.cover ?? null;
}

/** Largest variant that actually exists on disk for this photo. */
function sourceFile(cover) {
  // `widths` lists what was really written, so it never points at a 404.
  for (const w of [...(cover.widths ?? [])].sort((a, b) => b - a)) {
    for (const ext of ["jpg", "webp", "avif"]) {
      const f = path.join(ROOT, `${cover.base}-${w}.${ext}`);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

async function main() {
  const profile = JSON.parse(
    await readFile(path.join(ROOT, "data", "profile.json"), "utf8")
  );

  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Portfolio";
  const tagline = profile.tagline || "";

  const cover = await pickPhoto();
  const src = cover && sourceFile(cover);

  await mkdir(path.dirname(OUT), { recursive: true });

  /* No photo yet is not an error — a plain typographic card is still a vastly
     better share preview than a broken image, and this is exactly the state
     the site is in before the first shoot. */
  const PAD = 48;
  const photoW = src ? 380 : 0;

  let layers = [];

  if (src) {
    const photo = await sharp(src)
      .resize({
        width: photoW,
        height: H - PAD * 2,
        fit: "cover",
        position: "top", // a portrait crop should keep the FACE, not the middle
      })
      .toBuffer();
    layers.push({ input: photo, left: PAD, top: PAD });
  }

  /* Card background sampled from the photo itself, heavily darkened, so the
     card always harmonises with the image it is showing instead of using a
     hardcoded colour that may clash. */
  let bg = { r: 24, g: 22, b: 22 };
  if (src) {
    const { dominant } = await sharp(src).stats();
    bg = {
      r: Math.round(dominant.r * 0.28),
      g: Math.round(dominant.g * 0.28),
      b: Math.round(dominant.b * 0.28),
    };
  }

  const textLeft = src ? PAD + photoW + 56 : PAD + 24;
  const textW = W - textLeft - PAD;

  /* Wrap the tagline by character count. A real text metric is unavailable
     without a layout engine, and at this fixed size an approximate wrap is
     indistinguishable from an exact one. */
  const wrap = (text, perLine) => {
    const out = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (line && (line + " " + word).length > perLine) {
        out.push(line);
        line = word;
      } else line = line ? line + " " + word : word;
    }
    if (line) out.push(line);
    return out.slice(0, 3);
  };

  const taglineLines = wrap(tagline, 26);
  const nameLines = wrap(name, 16);

  const nameSize = 68;
  const tagSize = 30;
  const blockH = nameLines.length * nameSize * 1.12 + (taglineLines.length ? 28 + taglineLines.length * tagSize * 1.35 : 0);
  let y = (H - blockH) / 2 + nameSize * 0.82;

  const parts = [];
  for (const l of nameLines) {
    parts.push(
      `<text x="0" y="${y.toFixed(1)}" class="n">${xml(l)}</text>`
    );
    y += nameSize * 1.12;
  }
  if (taglineLines.length) {
    y += 20;
    for (const l of taglineLines) {
      parts.push(`<text x="0" y="${y.toFixed(1)}" class="t">${xml(l)}</text>`);
      y += tagSize * 1.35;
    }
  }

  /* Only generic families are named. The renderer here is librsvg with
     whatever fonts the machine happens to have, and that differs between a
     laptop and the CI runner — asking for the site's webfont would silently
     fall back and change the card depending on where it was built. */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${textW}" height="${H}">
    <style>
      .n { fill:#fff; font-family:Georgia,'Times New Roman',serif; font-size:${nameSize}px; }
      .t { fill:rgba(255,255,255,0.72); font-family:Helvetica,Arial,sans-serif;
           font-size:${tagSize}px; letter-spacing:2px; text-transform:uppercase; }
    </style>
    ${parts.join("\n    ")}
  </svg>`;

  layers.push({ input: Buffer.from(svg), left: textLeft, top: 0 });

  await sharp({
    create: { width: W, height: H, channels: 3, background: bg },
  })
    .composite(layers)
    // No metadata, and mozjpeg so the card stays well under the 300 KB that
    // some scrapers refuse to fetch.
    .jpeg({ quality: 86, mozjpeg: true, progressive: true })
    .toFile(OUT);

  const rel = path.relative(ROOT, OUT).replace(/\\/g, "/");
  console.log(
    `write  ${rel}  ${W}x${H}` + (src ? `  from ${path.relative(ROOT, src).replace(/\\/g, "/")}` : "  (no photo yet — text only)")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
