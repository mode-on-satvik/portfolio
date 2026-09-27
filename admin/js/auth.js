/* ==========================================================================
   auth.js — token custody

   The token is held in ONE module-scoped variable and is never persisted:
   not sessionStorage, not localStorage, not a cookie, not the URL. It exists
   only in the JS heap for the life of this page view.

   Consequences, stated plainly:
     · Closing the tab discards it.            (intended)
     · Reloading the page discards it.         (accepted cost)
     · It is never written to disk, so nothing can be recovered from the
       machine afterwards, and no other page on this origin can read it.

   Because a reload loses the token, the panel must never do a full page
   navigation — every screen renders client-side. See ui.js.

   Swapping to a Cloudflare-Worker + passphrase model later means replacing
   only this file: keep the same exported surface and nothing else changes.
   ========================================================================== */

let token = null;
let repoInfo = null;

const listeners = new Set();

export const REPO_OWNER = "mode-on-satvik";
export const REPO_NAME = "portfolio";
export const BRANCH = "main";

export const isAuthed = () => token !== null;

/** Read the token for an API call. Throws rather than sending `null`. */
export function getToken() {
  if (!token) throw new Error("Not signed in");
  return token;
}

export const getRepoInfo = () => repoInfo;

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(isAuthed());
}

/**
 * Validate a candidate token against the repo, and keep it only if it works.
 *
 * Validating up front matters: a wrong or expired token must fail here, at
 * the door, rather than halfway through a 12-file upload with photos already
 * half-committed.
 */
export async function signIn(candidate) {
  const value = String(candidate || "").trim();
  if (!value) throw new Error("Enter your access token");

  // Fine-grained tokens are github_pat_*; classic are ghp_*. Catch obvious
  // paste errors (whole URL, partial copy) before spending a request.
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(value)) {
    throw new Error(
      "That does not look like a GitHub token. Expected it to start with github_pat_ or ghp_"
    );
  }

  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`,
    {
      headers: {
        Authorization: `Bearer ${value}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (res.status === 401) throw new Error("Token rejected — expired or revoked");
  if (res.status === 403)
    throw new Error("Token lacks access to this repository");
  if (res.status === 404)
    throw new Error(
      `Cannot see ${REPO_OWNER}/${REPO_NAME} — check the token's repository access`
    );
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);

  const repo = await res.json();

  // Read access alone is not enough; we must be able to commit.
  if (!repo.permissions?.push) {
    throw new Error(
      "Token is read-only — it needs Contents: Read and write"
    );
  }

  token = value;
  repoInfo = {
    defaultBranch: repo.default_branch || BRANCH,
    pagesUrl: repo.homepage || null,
    private: repo.private,
  };
  emit();
  return repoInfo;
}

/** Drop the token. Also called on tab close for good measure. */
export function signOut() {
  token = null;
  repoInfo = null;
  emit();
}

/** Standard headers for an authenticated GitHub API call. */
export function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

/* Belt-and-braces: clear the variable as the page goes away, and warn before
   a reload would silently discard an in-progress session. */
window.addEventListener("pagehide", signOut);

window.addEventListener("beforeunload", (e) => {
  if (!isAuthed()) return;
  // Only fires if the user has interacted; browsers ignore it otherwise.
  e.preventDefault();
  e.returnValue = "";
});
