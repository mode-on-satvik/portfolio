/* ==========================================================================
   scrub.js — strip location data in the browser, BEFORE upload

   WHY THIS IS NOT OPTIONAL, AND NOT MERELY "DEFENCE IN DEPTH"

   The panel commits each ORIGINAL photo into _inbox/ on main. The workflow
   then processes it, strips EXIF from the published variants, and deletes the
   original. But a deleted file is not a forgotten file: the blob stays in git
   history forever, reachable by commit sha, on a public repository.

   So if a phone photo goes up untouched, the GPS coordinates of where a child
   was photographed — routinely their home — are permanently published, even
   though every image visible on the site is clean. sharp cannot prevent that;
   it only ever sees the file after it has already been committed.

   Stripping therefore has to happen HERE, before the bytes ever leave the
   device. That is the only point at which it actually protects anything.

   HOW

   Losslessly for the three formats that account for essentially every real
   upload — the compressed pixel data is copied through untouched and only the
   metadata containers are dropped:

     JPEG  drop every APPn and COM segment, then re-attach a minimal EXIF
           carrying ONLY the orientation tag
     PNG   drop eXIf, tEXt, iTXt, zTXt and the timestamp chunk
     WebP  drop the EXIF, XMP and ICCP RIFF chunks

   Anything else the browser can decode is re-encoded through a canvas, which
   discards metadata as a side effect of decoding to pixels. That costs a
   generation of JPEG quality, so it is the fallback and not the default.

   ORIENTATION IS THE TRAP

   A phone does not rotate the pixels it saves; it writes the sensor's
   orientation into EXIF and lets the viewer apply it. The workflow's
   `sharp().rotate()` bakes that flag into the pixels — but only if the flag is
   still there. Strip EXIF wholesale and every phone photo taken in portrait
   publishes on its side, silently, with nothing in the logs.

   Hence the reconstructed 32-byte EXIF block: orientation survives, and
   nothing else does. Canvas-decoded images get the orientation baked in
   directly instead (`imageOrientation: "from-image"`), so they need no flag.
   ========================================================================== */

/** Big-endian read helpers — JPEG segment lengths are always big-endian. */
const be16 = (b, i) => (b[i] << 8) | b[i + 1];

/**
 * Build the smallest valid EXIF APP1 segment that carries one orientation.
 *
 * Structure: "Exif\0\0" + TIFF header + a single-entry IFD0. Little-endian
 * ("II") because it is what every phone writes and what every decoder is best
 * tested against.
 */
function orientationEXIF(orientation) {
  const payload = new Uint8Array(32);
  const v = new DataView(payload.buffer);
  let p = 0;

  payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], p); // "Exif\0\0"
  p += 6;

  const tiff = p;
  payload.set([0x49, 0x49], p); // "II" — little-endian from here on
  p += 2;
  v.setUint16(p, 42, true); // TIFF magic
  p += 2;
  v.setUint32(p, 8, true); // IFD0 begins 8 bytes after the TIFF header
  p += 4;

  v.setUint16(p, 1, true); // exactly one entry
  p += 2;
  v.setUint16(p, 0x0112, true); // tag: Orientation
  p += 2;
  v.setUint16(p, 3, true); // type: SHORT
  p += 2;
  v.setUint32(p, 1, true); // count
  p += 4;
  v.setUint16(p, orientation, true); // the value, inline
  p += 2;
  v.setUint16(p, 0, true); // pad the 4-byte value field
  p += 2;
  v.setUint32(p, 0, true); // no IFD1
  p += 4;

  // Length covers the payload plus the two length bytes themselves.
  const len = p + 2;
  const out = new Uint8Array(2 + len);
  out[0] = 0xff;
  out[1] = 0xe1;
  out[2] = len >> 8;
  out[3] = len & 0xff;
  out.set(payload.subarray(0, p), 4);
  return out;
}

/** Pull the orientation tag out of an existing EXIF APP1 payload. */
function readOrientation(seg) {
  // seg starts at "Exif\0\0"
  if (seg.length < 14) return 1;
  const tiff = 6;
  const little = seg[tiff] === 0x49;
  const v = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);

  const u16 = (i) => v.getUint16(i, little);
  const u32 = (i) => v.getUint32(i, little);

  if (u16(tiff + 2) !== 42) return 1;

  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > seg.length) return 1;

  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > seg.length) break;
    if (u16(entry) === 0x0112) {
      const val = u16(entry + 8);
      return val >= 1 && val <= 8 ? val : 1;
    }
  }
  return 1;
}

/**
 * JPEG: copy the entropy-coded data through, drop all metadata segments.
 *
 * Everything from the start-of-scan marker onward is compressed pixel data and
 * is copied verbatim, so this is bit-for-bit lossless.
 */
function scrubJPEG(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // not a JPEG

  const keep = [new Uint8Array([0xff, 0xd8])];
  let orientation = 1;
  let i = 2;
  let dropped = 0;

  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i++; // resync past fill bytes rather than giving up
      continue;
    }

    const marker = bytes[i + 1];

    // Standalone markers carry no payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      keep.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }

    /* Start of scan: the rest of the file is compressed image data, which is
       not segment-structured and must not be parsed. Copy it all and stop. */
    if (marker === 0xda) {
      keep.push(bytes.subarray(i));
      break;
    }

    if (marker === 0xd9) {
      keep.push(bytes.subarray(i, i + 2));
      break;
    }

    const len = be16(bytes, i + 2);
    if (len < 2 || i + 2 + len > bytes.length) break; // malformed — stop here
    const seg = bytes.subarray(i + 4, i + 2 + len);

    const isAPPn = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;

    if (isAPPn || isComment) {
      /* APP1 is EXIF (GPS lives here) or XMP (which can hold location too),
         APP2 is ICC, APP13 is Photoshop IPTC. None of it is needed to render
         the image, and all of it can carry identifying data — so the whole
         class goes, and orientation is rescued on the way out. */
      if (marker === 0xe1 && seg.length >= 6 && String.fromCharCode(...seg.subarray(0, 4)) === "Exif") {
        orientation = readOrientation(seg);
      }
      dropped += len + 2;
    } else {
      keep.push(bytes.subarray(i, i + 2 + len)); // quant tables, frame, huffman
    }

    i += 2 + len;
  }

  /* Re-attach orientation immediately after SOI, which is where a decoder
     expects APP1. Skipped when orientation is 1 (already upright) so the
     common case produces no synthetic metadata at all. */
  if (orientation !== 1) keep.splice(1, 0, orientationEXIF(orientation));

  return { bytes: concat(keep), orientation, dropped };
}

/** PNG: drop the metadata chunks, keep IHDR/PLTE/IDAT/IEND and the rest. */
function scrubPNG(bytes) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null;

  const DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME", "iCCP"]);
  const keep = [bytes.subarray(0, 8)];
  let i = 8;
  let dropped = 0;

  while (i + 8 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + i, 4).getUint32(0, false);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const total = 12 + len; // length + type + data + crc
    if (i + total > bytes.length) break;

    if (DROP.has(type)) dropped += total;
    else keep.push(bytes.subarray(i, i + total));

    i += total;
    if (type === "IEND") break;
  }

  return { bytes: concat(keep), orientation: 1, dropped };
}

/** WebP: drop the EXIF / XMP / ICCP chunks from the RIFF container. */
function scrubWebP(bytes) {
  const tag = (i) => String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;

  const DROP = new Set(["EXIF", "XMP ", "ICCP"]);
  const keep = [];
  let i = 12;
  let dropped = 0;

  while (i + 8 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + i + 4, 4).getUint32(0, true);
    // RIFF chunks are word-aligned: an odd length is followed by a pad byte.
    const total = 8 + len + (len % 2);
    if (i + total > bytes.length) break;

    if (DROP.has(tag(i))) dropped += total;
    else keep.push(bytes.subarray(i, i + total));

    i += total;
  }

  const body = concat(keep);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 12));
  out.set(body, 12);
  // Rewrite the RIFF size field, or the file is corrupt after chunk removal.
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return { bytes: out, orientation: 1, dropped };
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Last line of defence: inspect the outgoing bytes for surviving metadata and
 * refuse the upload if any is found.
 *
 * A parser bug that silently left GPS in place would be invisible — the photo
 * looks perfect either way. So the result is checked rather than assumed, and
 * the check runs on the ACTUAL bytes about to be committed.
 *
 * TWO CHECKS, BECAUSE A TEXT SCAN ALONE IS FALSE COMFORT.
 *
 * Binary EXIF does not contain the string "GPSLatitude": tags are 16-bit
 * numbers, so a phone's coordinates are invisible to a text scan. Verified
 * against a fixture carrying a genuine GPS IFD — the text scan alone called it
 * clean. Human-readable tag names appear only in XMP, which is XML.
 *
 * So the structural check is the real one: confirm no EXIF/XMP/IPTC CONTAINER
 * survived, which is exactly what the strippers above guarantee. The text scan
 * is kept as a second net for packets sitting outside a container we parse.
 */
export function looksClean(bytes) {
  /* --- Structural: has any metadata container survived? ----------------- */

  // JPEG — walk the segments and reject any surviving APPn or COM.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i < bytes.length - 1) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      // Past SOS it is entropy-coded pixel data, which holds no metadata.
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = be16(bytes, i + 2);
      if (len < 2 || i + 2 + len > bytes.length) break;
      const seg = bytes.subarray(i + 4, i + 2 + len);

      /* One permitted exception: the minimal APP1 we rebuilt ourselves to
         carry orientation. Identified by being EXIF and tiny — a real camera's
         EXIF runs to hundreds of bytes, so the two cannot be confused. Any
         other APPn, or an oversized one, means a strip was incomplete. */
      const isOurs =
        marker === 0xe1 &&
        len <= 40 &&
        seg.length >= 4 &&
        seg[0] === 0x45 &&
        seg[1] === 0x78 &&
        seg[2] === 0x69 &&
        seg[3] === 0x66;

      if (!isOurs && ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) {
        return {
          clean: false,
          marker: marker === 0xfe ? "COM comment survived" : `APP${marker - 0xe0} survived`,
        };
      }
      i += 2 + len;
    }
  }

  /* PNG and WebP name their chunks in ASCII inside the container, so the
     chunk type is directly detectable. */
  const head = bytes.subarray(0, Math.min(bytes.length, 65536));
  let headAscii = "";
  for (const c of head) headAscii += c >= 32 && c < 127 ? String.fromCharCode(c) : " ";

  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    for (const chunk of ["eXIf", "tEXt", "iTXt", "zTXt"]) {
      if (headAscii.includes(chunk)) return { clean: false, marker: `PNG ${chunk} chunk` };
    }
  }
  if (headAscii.startsWith("RIFF") && headAscii.slice(8, 12) === "WEBP") {
    for (const chunk of ["EXIF", "XMP "]) {
      if (headAscii.slice(12).includes(chunk)) {
        return { clean: false, marker: `WebP ${chunk.trim()} chunk` };
      }
    }
  }

  /* --- Textual: XMP and IPTC are self-describing, so names do appear --- */

  const n = Math.min(bytes.length, 262144);
  let ascii = "";
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    ascii += c >= 32 && c < 127 ? String.fromCharCode(c) : " ";
  }

  const markers = [
    "GPSLatitude",
    "GPSLongitude",
    "geo:lat",
    "exif:GPS",
    "http://ns.adobe.com/xap", // XMP packet, which can embed location
    "<x:xmpmeta",
    "photoshop:",
    "Photoshop 3.0", // the IPTC block's signature
  ];

  const hit = markers.find((m) => ascii.includes(m));
  return hit ? { clean: false, marker: hit } : { clean: true };
}

/**
 * Re-encode through a canvas. Used only for formats without a lossless path.
 *
 * `imageOrientation: "from-image"` makes the decoder apply the EXIF rotation
 * while drawing, so the pixels come out upright and no orientation flag is
 * needed downstream.
 */
async function viaCanvas(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null; // the browser cannot decode it
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  /* White, not transparent-to-black: these are photographs, and if the source
     had alpha, JPEG would composite it against black. Matches the workflow's
     flatten({ background: "#ffffff" }). */
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.94));
  if (!blob) return null;

  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    orientation: 1,
    dropped: 0,
    recompressed: true,
    // The extension must follow the bytes, or the workflow publishes a JPEG
    // named .heic and the format sniffing reports a confusing mismatch.
    rename: file.name.replace(/\.[^.]*$/, "") + ".jpg",
  };
}

/**
 * Strip metadata from one picked file.
 *
 * @returns {Promise<{ok: true, bytes: Uint8Array, name: string,
 *                    recompressed: boolean, dropped: number,
 *                    orientation: number} |
 *                   {ok: false, reason: string}>}
 */
export async function scrub(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (bytes.length < 16) return { ok: false, reason: "file is empty or truncated" };

  let result = null;
  try {
    result = scrubJPEG(bytes) ?? scrubPNG(bytes) ?? scrubWebP(bytes);
  } catch (err) {
    /* A parser failure must never fall through to "upload the original" — that
       is the one outcome this module exists to prevent. Drop to the canvas
       path, which cannot leak metadata because it only ever sees pixels. */
    result = null;
  }

  if (!result) result = await viaCanvas(file);

  if (!result) {
    return {
      ok: false,
      reason:
        "this file could not be read as an image. If it came off an iPhone, " +
        'set Settings → Camera → Formats to "Most Compatible" and try again',
    };
  }

  const verdict = looksClean(result.bytes);
  if (!verdict.clean) {
    /* Lossless strip left something behind — fall back to the canvas, which
       discards metadata by construction, and re-check. */
    const fallback = await viaCanvas(file);
    if (fallback && looksClean(fallback.bytes).clean) result = fallback;
    else {
      return {
        ok: false,
        reason: `could not remove embedded metadata (${verdict.marker}) — not uploading this one`,
      };
    }
  }

  return {
    ok: true,
    bytes: result.bytes,
    name: result.rename ?? file.name,
    recompressed: Boolean(result.recompressed),
    dropped: result.dropped ?? 0,
    orientation: result.orientation ?? 1,
  };
}
