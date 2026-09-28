/* ==========================================================================
   github.js — the only file that talks to the GitHub REST API

   Everything the panel needs to change lives in the repo, so "save" always
   means "commit". There is no database and no server of our own.

   Two write paths, and the difference matters:

     · stageFiles()  — commits the ORIGINAL photos into _inbox/<slug>/ plus a
                       job.json describing them, then fires a
                       repository_dispatch. The workflow does the actual image
                       processing with sharp, because a browser cannot produce
                       AVIF at four widths in any reasonable time and we want
                       byte-identical output whether a photo was published
                       from the panel or from the CLI.

     · saveCategory() — commits data/categories/<slug>.json directly, for a
                       copy or ordering edit that needs no image work.

   The Contents API is used rather than the Git Data API (blobs/trees/commits).
   It is one request per file instead of four per batch, which is worse for a
   large batch, but each request is independently retryable and a failure
   leaves a valid tree. Since process-inbox.mjs is idempotent and only empties
   _inbox/ after every image is written, a half-finished upload is recoverable
   by re-running — that property is worth more here than request count.
   ========================================================================== */

import { REPO_OWNER, REPO_NAME, BRANCH, authHeaders } from "./auth.js";

const API = "https://api.github.com";
const repo = () => `${API}/repos/${REPO_OWNER}/${REPO_NAME}`;

/**
 * One API call, with the error handling every call needs.
 *
 * GitHub's error bodies are far more useful than its status codes — a 422 on
 * a file write is usually "sha mismatch", which is a concurrent-edit conflict
 * and needs different advice than a generic failure. So the message is
 * surfaced rather than swallowed.
 */
async function call(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { ...options, headers: authHeaders(options.headers) });
  } catch (err) {
    /* fetch() rejects only on network failure, and offline is the single most
       likely cause of a failed upload from a phone on mobile data. Say so,
       rather than reporting a bare "Failed to fetch". */
    throw new Error(
      navigator.onLine
        ? `Could not reach GitHub (${err.message})`
        : "You appear to be offline — check your connection and try again"
    );
  }

  if (res.status === 204) return null; // dispatch returns no body

  const text = await res.text();
  const body = text ? safeJSON(text) : null;

  if (!res.ok) {
    const detail =
      body?.message ||
      (typeof body === "string" ? body.slice(0, 200) : "") ||
      res.statusText;

    if (res.status === 401) throw new Error("Token rejected — sign in again");
    if (res.status === 409 || /does not match|sha/i.test(detail)) {
      throw new Error(
        "That file changed on GitHub since this page loaded. Reload and redo this edit."
      );
    }
    if (res.status === 403 && /rate limit/i.test(detail)) {
      throw new Error("GitHub rate limit reached — wait a few minutes and retry");
    }
    if (res.status === 413 || /too large/i.test(detail)) {
      throw new Error("That file is too large for the GitHub API (100 MB hard limit)");
    }
    throw new Error(`GitHub: ${detail}`);
  }

  return body;
}

const safeJSON = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

/** Base64 for arbitrary bytes. btoa() alone throws on anything above U+00FF. */
export function toBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  /* Chunked because String.fromCharCode(...arr) spreads every byte as an
     argument, and a 20 MB photo blows the call-stack limit outright. 32 KB is
     comfortably under every engine's cap. */
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < arr.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

/** UTF-8 safe base64 for a JSON/text payload. */
export const textToBase64 = (str) => toBase64(new TextEncoder().encode(str));

/**
 * Read a file. Returns `{ json, sha }`, or `{ json: null, sha: null }` if it
 * does not exist — a 404 here is an ordinary answer, not an error.
 *
 * The sha is required to update the file later; without it GitHub rejects the
 * write, which is the mechanism that stops this panel from silently clobbering
 * an edit made from a laptop in the meantime.
 */
export async function getFile(pathInRepo) {
  const url = `${repo()}/contents/${encodeURI(pathInRepo)}?ref=${BRANCH}`;

  let res;
  try {
    res = await fetch(url, { headers: authHeaders() });
  } catch {
    throw new Error("Could not reach GitHub");
  }

  if (res.status === 404) return { json: null, sha: null, raw: null };
  if (!res.ok) throw new Error(`GitHub ${res.status} reading ${pathInRepo}`);

  const meta = await res.json();

  /* Files over 1 MB come back with an empty `content` and must be fetched via
     the blob endpoint. Our JSON is far smaller, but a category file grows with
     every photo (each carries an inline LQIP data URI), so this ceiling is
     reachable rather than theoretical. */
  let raw;
  if (meta.content) {
    raw = new TextDecoder().decode(
      Uint8Array.from(atob(meta.content.replace(/\s/g, "")), (c) => c.charCodeAt(0))
    );
  } else {
    const blob = await call(`${repo()}/git/blobs/${meta.sha}`, {
      headers: { Accept: "application/vnd.github.raw" },
    });
    raw = typeof blob === "string" ? blob : JSON.stringify(blob);
  }

  return { json: safeJSON(raw), sha: meta.sha, raw };
}

/**
 * Create or update one file.
 *
 * @param {string} pathInRepo
 * @param {string} contentBase64
 * @param {string} message   commit message
 * @param {string|null} sha  current sha when replacing; omit to create
 */
export function putFile(pathInRepo, contentBase64, message, sha = null) {
  return call(`${repo()}/contents/${encodeURI(pathInRepo)}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: contentBase64,
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
}

/** Delete one file. Used to withdraw a photo. */
export function deleteFile(pathInRepo, sha, message) {
  return call(`${repo()}/contents/${encodeURI(pathInRepo)}`, {
    method: "DELETE",
    body: JSON.stringify({ message, sha, branch: BRANCH }),
  });
}

/** The category catalogue, read fresh from the repo. */
export async function loadCatalog() {
  const { json } = await getFile("data/index.json");
  if (!json?.categories) throw new Error("data/index.json is missing or malformed");
  return json.categories.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * The whole index file plus its sha, for adding or removing a category entry.
 *
 * loadCatalog() above returns only the sorted array, which is all the panel
 * needed while it could not create or delete a category. Writing the file back
 * needs the sha and the sibling keys (`updated`, `rev`) preserved.
 */
export async function loadIndex() {
  const { json, sha } = await getFile("data/index.json");
  if (!json?.categories) throw new Error("data/index.json is missing or malformed");
  return { index: json, sha };
}

/** Write data/index.json back. */
export function saveIndex(index, sha, message) {
  return putFile(
    "data/index.json",
    textToBase64(JSON.stringify(index, null, 2) + "\n"),
    message,
    sha
  );
}

/** Remove a category's JSON file. */
export function deleteCategory(slug, sha, message) {
  return deleteFile(`data/categories/${slug}.json`, sha, message);
}

/** One category file plus its sha, ready to edit and write back. */
export const loadCategory = (slug) => getFile(`data/categories/${slug}.json`);

/**
 * Write a category file back.
 *
 * The sha is passed through deliberately: if someone edited the same category
 * from a laptop after this page loaded, the write fails loudly instead of
 * overwriting their work.
 */
export function saveCategory(slug, cat, sha, message) {
  return putFile(
    `data/categories/${slug}.json`,
    textToBase64(JSON.stringify(cat, null, 2) + "\n"),
    message,
    sha
  );
}

/**
 * Ask the workflow to run.
 *
 * Fired after staging, because a push to _inbox/ deliberately does NOT trigger
 * the workflow (see paths-ignore in publish.yml) — otherwise every file in a
 * 12-photo batch would start its own run and they would race on the same JSON.
 */
export function triggerPublish(message) {
  return call(`${repo()}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      event_type: "portfolio-publish",
      client_payload: { message },
    }),
  });
}

/**
 * Stage a batch of photos and start the publish run.
 *
 * Order is load-bearing. job.json is written LAST, after every image is
 * safely committed, because it is the manifest the workflow reads to find the
 * alt text and captions. Writing it first would mean a batch interrupted
 * half-way leaves a manifest describing photos that were never uploaded.
 *
 * @param {string} slug
 * @param {Array<{name: string, bytes: Uint8Array, alt: string, caption: string,
 *                featured: boolean}>} items
 * @param {(done: number, total: number, label: string) => void} onProgress
 */
export async function stageFiles(slug, items, message, onProgress = () => {}) {
  const total = items.length + 1; // +1 for job.json
  let done = 0;

  const photos = {};

  for (const item of items) {
    onProgress(done, total, item.name);

    /* An existing file at the same path needs its sha, or the write is
       rejected. Re-uploading the same filename after a failed run is a normal
       recovery path, so this is not an edge case. */
    const existing = await getFile(`_inbox/${slug}/${item.name}`);

    await putFile(
      `_inbox/${slug}/${item.name}`,
      toBase64(item.bytes),
      `Stage ${slug}/${item.name}`,
      existing.sha
    );

    photos[item.name] = {
      alt: item.alt,
      caption: item.caption,
      slug,
      featured: Boolean(item.featured),
    };

    done += 1;
  }

  onProgress(done, total, "job.json");

  const existingJob = await getFile("_inbox/job.json");
  await putFile(
    "_inbox/job.json",
    textToBase64(JSON.stringify({ message, photos, categories: {} }, null, 2) + "\n"),
    "Stage upload manifest",
    existingJob.sha
  );

  done += 1;
  onProgress(done, total, "done");

  await triggerPublish(message);
}

/**
 * The most recent workflow runs, so the panel can show whether a publish
 * actually succeeded instead of just claiming it started.
 */
export async function recentRuns(limit = 5) {
  const body = await call(
    `${repo()}/actions/workflows/publish.yml/runs?per_page=${limit}`
  );
  return (body?.workflow_runs ?? []).map((r) => ({
    id: r.id,
    status: r.status, // queued | in_progress | completed
    conclusion: r.conclusion, // success | failure | cancelled | null
    started: r.run_started_at,
    url: r.html_url,
    title: r.display_title,
  }));
}
