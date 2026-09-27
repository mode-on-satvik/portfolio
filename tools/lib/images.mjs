/* ==========================================================================
   lib/images.mjs — the one image pipeline

   Used by BOTH make-dummies.mjs (local sample images) and process-inbox.mjs
   (the publish workflow). One implementation, so what you see locally is
   exactly what the workflow produces.

   For each source image it emits:
     · AVIF (q50) · WebP (q80) · JPEG (q82, mozjpeg)   × 400/800/1200/2000
     · a 24px inline LQIP for the blur-up placeholder
     · real pixel dimensions, for the aspect-ratio/span maths
     · ALL metadata stripped, including GPS
   ========================================================================== */

import sharp from "sharp";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const WIDTHS = [400, 800, 1200, 2000];
export const FORMATS = ["avif", "webp", "jpg"];

/* Raster formats this build can actually DECODE, as reported by libvips
   itself rather than as a hand-kept list. Checked at runtime because the
   prebuilt sharp binary differs by platform: notably these wheels carry
   `heifload` and aom (so AVIF decodes) but no HEVC decoder, so a .heic
   straight off an iPhone does NOT decode even though the heif loader is
   present. A hardcoded list would promise support that isn't there.

   SVG is excluded deliberately: it is not a photograph, it can embed scripts
   and remote references, and rasterising one as a portfolio image is never
   what an upload meant. */
const DECODABLE = new Set(
  Object.keys(sharp.format).filter(
    (k) => sharp.format[k].input.buffer && k !== "svg" && k !== "raw"
  )
);

/**
 * Can this buffer be decoded as an image, whatever it is named?
 *
 * Content sniffing, not the file extension. The extension is attacker- and
 * accident-controlled: a phone that saves HEIC as "photo.jpg", a download that
 * appends ".jpg" to a PDF, or a rename from .png to .jpeg all lie about the
 * bytes. Asking the decoder is the only answer that is true by construction.
 *
 * @returns {Promise<{ok: true, format: string, w: number, h: number} |
 *                   {ok: false, reason: string}>}
 */
export async function probeImage(input) {
  let meta;
  try {
    meta = await sharp(input, { failOn: "none" }).metadata();
  } catch (err) {
    return { ok: false, reason: err.message.split("\n")[0] };
  }

  if (!meta.format || !DECODABLE.has(meta.format)) {
    return { ok: false, reason: `unsupported image format (${meta.format ?? "unrecognised"})` };
  }
  if (!meta.width || !meta.height) {
    return { ok: false, reason: "image has no usable dimensions" };
  }

  return { ok: true, format: meta.format, w: meta.width, h: meta.height };
}

/* Quality settings. AVIF tolerates a much lower number than JPEG for the
   same perceived quality, which is where most of the saving comes from. */
const Q = { avif: 50, webp: 80, jpg: 82 };

/**
 * Generate every variant of one image.
 *
 * @param {Buffer|string} input   source buffer or file path
 * @param {string} outDir         directory to write into
 * @param {string} stem           filename stem, e.g. "formal-01-a3f9c2"
 * @returns {{w:number,h:number,lqip:string,widths:number[],formats:string[]}}
 */
export async function processImage(input, outDir, stem) {
  await mkdir(outDir, { recursive: true });

  const src = sharp(input, { failOn: "none" });
  const meta = await src.metadata();

  /* EXIF can carry an orientation flag; rotate() bakes it into the pixels so
     downstream sizes are the real displayed dimensions.

     `flatten` composites any transparency onto white. JPEG has no alpha
     channel, so without this a PNG/WebP with a transparent background
     composites against BLACK in the JPEG variants only — the AVIF and WebP
     look right, so it survives a visual check and then appears as a black box
     for anyone whose browser took the JPEG fallback.

     Animated sources are reduced to their first frame: `pages` is left at its
     default of 1, so an animated GIF/WebP yields a still rather than a
     vertically-stacked filmstrip (which is what sharp produces for pages: -1). */
  const base = sharp(input, { failOn: "none" })
    .rotate()
    .flatten({ background: "#ffffff" });
  const upright = await base.toBuffer();
  const { width: w, height: h } = await sharp(upright).metadata();

  /* Which widths to actually emit.
     Never upscale — but "clamp the pixels and keep the filename" is worse than
     it looks: a file named `-2000.jpg` that is really 1400px wide gets a
     `2000w` srcset descriptor, so the browser sizes its whole layout decision
     on a number that is a lie, then renders an upscaled blur.

     So: emit only targets the source can genuinely fill, plus the source's own
     width when it falls between two targets. A 1400px source yields
     400/800/1200/1400 — every descriptor true. */
  const targets = WIDTHS.filter((t) => t <= w);
  if (!targets.includes(w) && w < WIDTHS.at(-1)) targets.push(w);
  if (!targets.length) targets.push(w); // source narrower than 400px

  /* Remove any variant of this stem that we are NOT about to write. Content
     hashes make stems immutable, so a leftover file can only come from a
     pipeline change (e.g. the upscale fix, which orphaned every `-2000`
     produced from a 1200px source). Nothing references them, but shipping
     dead bytes in a repo with a 1 GB limit is still wrong. */
  const wanted = new Set(targets.flatMap((t) => FORMATS.map((f) => `${stem}-${t}.${f}`)));
  for (const file of await readdir(outDir)) {
    if (file.startsWith(`${stem}-`) && !wanted.has(file)) {
      await rm(path.join(outDir, file), { force: true });
    }
  }

  for (const target of targets) {
    const resized = sharp(upright).resize({
      width: target,
      withoutEnlargement: true,
      kernel: "lanczos3",
    });

    const out = (ext) => path.join(outDir, `${stem}-${target}.${ext}`);

    /* keepMetadata is NOT called, which is the point: sharp drops EXIF by
       default, so GPS coordinates from a phone camera never reach the repo.
       Defence in depth — the browser strips them before upload too. */
    await Promise.all([
      resized.clone().avif({ quality: Q.avif, effort: 4 }).toFile(out("avif")),
      resized.clone().webp({ quality: Q.webp, effort: 4 }).toFile(out("webp")),
      resized
        .clone()
        .jpeg({ quality: Q.jpg, mozjpeg: true, progressive: true })
        .toFile(out("jpg")),
    ]);
  }

  // 24px WebP, inlined as a data URI. Small enough to sit in the JSON.
  const lqipBuf = await sharp(upright)
    .resize({ width: 24 })
    .webp({ quality: 40 })
    .toBuffer();

  return {
    w,
    h,
    lqip: `data:image/webp;base64,${lqipBuf.toString("base64")}`,
    // The widths that EXIST on disk, not the wishlist — the client builds
    // srcset straight from this, so a phantom entry is a 404.
    widths: targets.sort((a, b) => a - b),
    formats: FORMATS,
    srcFormat: meta.format,
  };
}

/** Short content hash, so filenames are immutable and safe to cache forever. */
export async function contentHash(buffer) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buffer).digest("hex").slice(0, 6);
}
