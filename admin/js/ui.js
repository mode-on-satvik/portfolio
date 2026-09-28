/* ==========================================================================
   ui.js — screens, state and event wiring

   Everything renders client-side. There is not a single link or form that
   causes a navigation, because a navigation reloads the page and the token
   lives only in memory (see auth.js). That constraint shapes this whole file:
   tabs swap [hidden], forms preventDefault, and "reload the list" means
   re-fetch and re-render.
   ========================================================================== */

import { signIn, signOut, isAuthed, onAuthChange, REPO_OWNER, REPO_NAME } from "./auth.js";
import { loadCatalog, loadCategory, saveCategory, stageFiles, recentRuns } from "./github.js";
import { scrub } from "./scrub.js";

const $ = (sel, root = document) => root.querySelector(sel);

/* --- Escaping ------------------------------------------------------------
   Every string rendered below is either user-typed (alt text, captions) or
   comes from the repo. Interpolating it raw into innerHTML would be an XSS
   hole with a very short path: type a caption containing a script tag, save,
   and it executes for the next person who opens the panel — with a live token
   in memory. So nothing reaches innerHTML unescaped.
   ---------------------------------------------------------------------- */
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/** Module state. Small enough that a store would be ceremony. */
const state = {
  categories: [],
  queue: [], // { id, name, bytes, url, alt, caption, featured, error }
  slug: null,
  busy: false,
};

let nextId = 1;

/* --- Messages ----------------------------------------------------------- */

function say(target, kind, html) {
  const el = typeof target === "string" ? $(target) : target;
  if (!el) return;
  if (!html) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<div class="msg msg--${kind}">${html}</div>`;
}

/* --- Sign-in ------------------------------------------------------------ */

function wireSignIn() {
  const form = $("#signin-form");
  const btn = $("#signin-btn");
  const input = $("#token");

  form.addEventListener("submit", async (e) => {
    e.preventDefault(); // a real submit would navigate and lose everything
    say("#gate-msg", "info", "Checking token…");
    btn.disabled = true;

    try {
      await signIn(input.value);
      /* Clear the field immediately on success. The token is in the module
         variable now, and leaving a copy in a DOM node means it is still
         readable from the page and visible to anything that walks the DOM. */
      input.value = "";
      say("#gate-msg", "");
    } catch (err) {
      say("#gate-msg", "err", esc(err.message));
      input.setAttribute("aria-invalid", "true");
      input.focus();
    } finally {
      btn.disabled = false;
    }
  });

  input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
}

/* --- Tabs --------------------------------------------------------------- */

const TABS = [
  ["#tab-upload", "#view-upload", renderUpload],
  ["#tab-cats", "#view-cats", renderCategories],
  ["#tab-runs", "#view-runs", renderRuns],
];

function wireTabs() {
  for (const [tabSel, viewSel, render] of TABS) {
    $(tabSel).addEventListener("click", () => {
      for (const [t, v] of TABS) {
        const selected = t === tabSel;
        $(t).setAttribute("aria-selected", String(selected));
        $(v).hidden = !selected;
      }
      render();
    });
  }

  /* Arrow-key navigation is expected of a tablist and costs four lines. */
  $(".tabs").addEventListener("keydown", (e) => {
    const keys = { ArrowLeft: -1, ArrowRight: 1 };
    if (!(e.key in keys)) return;
    const tabs = TABS.map(([t]) => $(t));
    const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    const next = tabs[(i + keys[e.key] + tabs.length) % tabs.length];
    next.focus();
    next.click();
  });
}

/* --- Upload view -------------------------------------------------------- */

function renderUpload() {
  const view = $("#view-upload");

  const options = state.categories
    .map(
      (c) =>
        `<option value="${esc(c.slug)}"${c.slug === state.slug ? " selected" : ""}>${esc(
          c.title
        )}${c.published ? "" : " (hidden)"}</option>`
    )
    .join("");

  view.innerHTML = `
    <div id="upload-msg" role="alert" aria-live="polite"></div>

    <div class="card">
      <label class="field" style="margin-bottom:0">
        <span class="field__label">Add to which set?</span>
        <select id="slug">${options}</select>
      </label>
    </div>

    <div class="drop" id="drop" tabindex="0" role="button"
         aria-label="Choose photos to add">
      <span class="drop__big">Drop photos here</span>
      <span class="drop__hint">
        or tap to choose · JPEG, PNG, WebP or HEIC · location data is removed
        on this device before anything is uploaded
      </span>
      <input type="file" id="picker" accept="image/*" multiple hidden />
    </div>

    <ul class="queue" id="queue"></ul>

    <div id="publish-box" hidden>
      <div class="card">
        <label class="field">
          <span class="field__label">What changed? (optional)</span>
          <input type="text" id="message" placeholder="Add 3 formal suit photos" />
          <p class="field__hint">Used as the commit message.</p>
        </label>
        <div class="bar" id="bar" hidden><div class="bar__fill" id="bar-fill"></div></div>
        <button class="btn btn--primary" id="publish" type="button">
          Publish <span id="count"></span>
        </button>
      </div>
    </div>
  `;

  $("#slug").addEventListener("change", (e) => (state.slug = e.target.value));

  const picker = $("#picker");
  const drop = $("#drop");

  drop.addEventListener("click", () => picker.click());
  drop.addEventListener("keydown", (e) => {
    // A div with role=button must answer to both keys, like a real button.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      picker.click();
    }
  });

  picker.addEventListener("change", () => {
    addFiles([...picker.files]);
    /* Reset, or picking the same file twice in a row fires no change event and
       looks like the panel ignored you. */
    picker.value = "";
  });

  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add("is-over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove("is-over");
    });
  }
  drop.addEventListener("drop", (e) => {
    addFiles([...(e.dataTransfer?.files ?? [])]);
  });

  $("#publish").addEventListener("click", publish);

  renderQueue();
}

/** Strip and queue each picked file. */
async function addFiles(files) {
  const images = files.filter(
    // Accept by declared type where present, but keep extensionless/odd files
    // and let scrub() decide — the browser's type sniffing is not reliable.
    (f) => !f.type || f.type.startsWith("image/") || /\.(hei[cf]|avif|jpe?g|png|webp|tiff?)$/i.test(f.name)
  );

  if (!images.length) {
    say("#upload-msg", "err", "Those do not look like image files.");
    return;
  }

  say("#upload-msg", "info", `Removing location data from ${images.length} photo(s)…`);

  for (const file of images) {
    const result = await scrub(file);

    if (!result.ok) {
      state.queue.push({
        id: nextId++,
        name: file.name,
        error: result.reason,
      });
      renderQueue();
      continue;
    }

    const blob = new Blob([result.bytes]);
    state.queue.push({
      id: nextId++,
      name: result.name,
      bytes: result.bytes,
      url: URL.createObjectURL(blob),
      alt: "",
      caption: "",
      featured: false,
      recompressed: result.recompressed,
      kb: Math.round(result.bytes.length / 1024),
    });
    renderQueue();
  }

  const bad = state.queue.filter((q) => q.error).length;
  say(
    "#upload-msg",
    bad ? "err" : "ok",
    bad
      ? `${bad} file(s) could not be used — see below. The rest are ready.`
      : "Location data removed. Add alt text for each photo, then publish."
  );
}

function renderQueue() {
  const list = $("#queue");
  if (!list) return;

  list.innerHTML = state.queue
    .map((q) =>
      q.error
        ? `<li class="item item--bad" data-id="${q.id}">
             <div class="item__thumb" aria-hidden="true"></div>
             <div>
               <p class="item__name">${esc(q.name)}</p>
               <p class="msg msg--err" style="margin:0">${esc(q.error)}</p>
               <div class="item__row">
                 <button class="btn btn--sm btn--danger" data-remove="${q.id}">Remove</button>
               </div>
             </div>
           </li>`
        : `<li class="item" data-id="${q.id}">
             <img class="item__thumb" src="${q.url}" alt="" />
             <div>
               <p class="item__name">${esc(q.name)} · ${q.kb} KB${
                 q.recompressed ? " · re-saved as JPEG" : ""
               }</p>

               <label class="field" style="margin-bottom:var(--s-3)">
                 <span class="field__label">Alt text — required</span>
                 <textarea data-alt="${q.id}" placeholder="Child model in a navy three-piece suit, seated, studio lighting">${esc(
                   q.alt
                 )}</textarea>
               </label>

               <label class="field" style="margin-bottom:0">
                 <span class="field__label">Caption — optional</span>
                 <input type="text" data-caption="${q.id}" value="${esc(q.caption)}" />
               </label>

               <div class="item__row">
                 <label class="check">
                   <input type="checkbox" data-featured="${q.id}"${q.featured ? " checked" : ""} />
                   <span class="item__tag">Use as set cover</span>
                 </label>
                 <button class="btn btn--sm btn--danger" data-remove="${q.id}">Remove</button>
               </div>
             </div>
           </li>`
    )
    .join("");

  const usable = state.queue.filter((q) => !q.error).length;
  const box = $("#publish-box");
  if (box) box.hidden = usable === 0;
  const count = $("#count");
  if (count) count.textContent = usable ? `${usable} photo${usable > 1 ? "s" : ""}` : "";

  /* One delegated listener on the list, rather than one per control. Rows are
     re-rendered on every keystroke-free change, so per-row listeners would
     leak and double up. */
  list.oninput = (e) => {
    const t = e.target;
    const find = (attr) => state.queue.find((q) => q.id === Number(t.dataset[attr]));
    if (t.dataset.alt) find("alt").alt = t.value;
    else if (t.dataset.caption) find("caption").caption = t.value;
  };

  list.onchange = (e) => {
    const t = e.target;
    if (!t.dataset.featured) return;
    /* Exactly one cover. Unset the others rather than letting two be ticked
       and having the workflow silently pick one. */
    for (const q of state.queue) q.featured = false;
    state.queue.find((q) => q.id === Number(t.dataset.featured)).featured = t.checked;
    renderQueue();
  };

  list.onclick = (e) => {
    const id = e.target.dataset?.remove;
    if (!id) return;
    const i = state.queue.findIndex((q) => q.id === Number(id));
    if (i < 0) return;
    // Release the blob URL, or the bytes stay alive for the life of the tab.
    if (state.queue[i].url) URL.revokeObjectURL(state.queue[i].url);
    state.queue.splice(i, 1);
    renderQueue();
  };
}

async function publish() {
  if (state.busy) return;

  const items = state.queue.filter((q) => !q.error);
  if (!items.length) return;

  /* Alt text is enforced here rather than nudged, because there is no second
     chance: once published, fixing it means another commit and another deploy,
     and in practice it never gets done. A gallery with no alt text is
     meaningless to a screen reader and invisible to image search. */
  const missing = items.filter((q) => !q.alt.trim());
  if (missing.length) {
    say(
      "#upload-msg",
      "err",
      `Add alt text for ${missing.length} photo(s) first — describe what is in the frame.`
    );
    const first = $(`[data-alt="${missing[0].id}"]`);
    first?.focus();
    first?.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }

  const slug = state.slug;
  if (!slug) {
    say("#upload-msg", "err", "Choose a set first.");
    return;
  }

  const message =
    $("#message").value.trim() ||
    `Add ${items.length} photo(s) to ${slug}`;

  state.busy = true;
  $("#publish").disabled = true;
  $("#bar").hidden = false;

  try {
    await stageFiles(
      slug,
      items.map((q) => ({
        name: q.name,
        bytes: q.bytes,
        alt: q.alt.trim(),
        caption: q.caption.trim(),
        featured: q.featured,
      })),
      message,
      (done, total, label) => {
        $("#bar-fill").style.width = `${Math.round((done / total) * 100)}%`;
        say("#upload-msg", "info", `Uploading ${esc(label)} — ${done} of ${total}…`);
      }
    );

    for (const q of state.queue) if (q.url) URL.revokeObjectURL(q.url);
    state.queue = [];
    renderQueue();

    say(
      "#upload-msg",
      "ok",
      "Uploaded. The site rebuilds itself now — this takes a couple of minutes. " +
        'Check <strong>Activity</strong> to watch it finish.'
    );
  } catch (err) {
    /* Say explicitly that nothing was lost. The natural fear at this point is
       that the photos are gone, and the honest answer is that they are still
       in this tab and the button can be pressed again. */
    say(
      "#upload-msg",
      "err",
      `${esc(err.message)}<br />Nothing was lost — your photos are still listed below. Try Publish again.`
    );
  } finally {
    state.busy = false;
    const btn = $("#publish");
    if (btn) btn.disabled = false;
    const bar = $("#bar");
    if (bar) bar.hidden = true;
  }
}

/* --- Categories view ---------------------------------------------------- */

function renderCategories() {
  const view = $("#view-cats");

  if (!state.categories.length) {
    view.innerHTML = `<p class="empty">No categories found.</p>`;
    return;
  }

  view.innerHTML = `
    <div id="cats-msg" role="alert" aria-live="polite"></div>
    <p class="field__hint" style="margin-bottom:var(--s-4)">
      Hiding a set removes it from the site without deleting anything. The
      order here is the order on the home page.
    </p>
    <ul class="cats">
      ${state.categories
        .map(
          (c, i) => `
        <li class="cat" data-slug="${esc(c.slug)}">
          ${
            c.cover?.lqip
              ? `<img class="cat__thumb" src="${esc(c.cover.lqip)}" alt="" />`
              : `<div class="cat__thumb"></div>`
          }
          <div>
            <div class="cat__name">${esc(c.title)}</div>
            <div class="cat__meta">
              ${c.count ?? 0} photo${(c.count ?? 0) === 1 ? "" : "s"} ·
              <span class="pill ${c.published ? "pill--on" : "pill--off"}">
                ${c.published ? "Live" : "Hidden"}
              </span>
            </div>
          </div>
          <div class="cat__actions">
            <button class="btn btn--sm" data-up="${esc(c.slug)}"${i === 0 ? " disabled" : ""}
                    aria-label="Move ${esc(c.title)} up">↑</button>
            <button class="btn btn--sm" data-down="${esc(c.slug)}"${
              i === state.categories.length - 1 ? " disabled" : ""
            } aria-label="Move ${esc(c.title)} down">↓</button>
            <button class="btn btn--sm" data-toggle="${esc(c.slug)}">
              ${c.published ? "Hide" : "Show"}
            </button>
            <button class="btn btn--sm" data-photos="${esc(c.slug)}"
                    aria-expanded="false">Photos</button>
          </div>
          <!-- Filled in on demand by loadPhotos(). The photo list needs the
               category FILE, which the catalogue does not carry, so it costs a
               request per category and is not worth fetching six of them up
               front for a panel opened to reorder one set. -->
          <div class="cat__photos" data-photos-for="${esc(c.slug)}" hidden></div>
        </li>`
        )
        .join("")}
    </ul>
  `;

  view.onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.toggle) return toggleCategory(t.dataset.toggle);
    if (t.dataset.up) return moveCategory(t.dataset.up, -1);
    if (t.dataset.down) return moveCategory(t.dataset.down, 1);
    if (t.dataset.photos) return togglePhotos(t);
    if (t.dataset.del) return deletePhoto(t.dataset.del, t.dataset.photoId);
  };
}

/* --- Photos within a category ------------------------------------------- */

/**
 * Cached category files, keyed by slug: `{ cat, sha }`.
 *
 * The sha is the point. Deleting a photo is a read-modify-write of the whole
 * category file, and GitHub rejects the write unless the sha matches what is
 * currently on the branch — which is what stops this panel from silently
 * discarding a caption someone edited from a laptop in the meantime. Cached so
 * expanding a category, deleting two photos and collapsing it is one read.
 */
const catFiles = new Map();

function togglePhotos(btn) {
  const slug = btn.dataset.photos;
  const box = $(`[data-photos-for="${CSS.escape(slug)}"]`);
  if (!box) return;

  if (!box.hidden) {
    box.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    return;
  }

  box.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  return loadPhotos(slug);
}

async function loadPhotos(slug) {
  const box = $(`[data-photos-for="${CSS.escape(slug)}"]`);
  if (!box) return;

  box.innerHTML = `<p class="empty">Loading photos…</p>`;

  try {
    const { json: cat, sha } = await loadCategory(slug);
    if (!cat) throw new Error(`data/categories/${slug}.json not found`);
    catFiles.set(slug, { cat, sha });
    renderPhotos(slug);
  } catch (err) {
    box.innerHTML = `<div class="msg msg--err">${esc(err.message)}</div>`;
  }
}

function renderPhotos(slug) {
  const box = $(`[data-photos-for="${CSS.escape(slug)}"]`);
  const entry = catFiles.get(slug);
  if (!box || !entry) return;

  const photos = (entry.cat.photos ?? [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (!photos.length) {
    box.innerHTML = `<p class="empty">No photos in this set.</p>`;
    return;
  }

  box.innerHTML = `
    <ul class="sort">
      ${photos
        .map(
          (p) => `
        <li class="sort__row" data-photo="${esc(p.id)}">
          ${
            p.lqip
              ? `<img class="sort__thumb" src="${esc(p.lqip)}" alt="" />`
              : `<div class="sort__thumb"></div>`
          }
          <div>
            <div class="sort__alt">${esc(p.alt || "(no alt text)")}</div>
            <div class="cat__meta">
              ${esc(p.caption || "")}${p.featured ? " · cover" : ""}
            </div>
          </div>
          <button class="btn btn--sm btn--danger"
                  data-del="${esc(slug)}" data-photo-id="${esc(p.id)}">
            Remove
          </button>
        </li>`
        )
        .join("")}
    </ul>
  `;
}

/**
 * Delete one photo: rewrite the category file without it, in one commit.
 *
 * The 12 image variants are deliberately NOT deleted here. Doing it from the
 * browser would be 12 more Contents-API commits per photo, and it would still
 * leave data/index.json stale — `count`, `cover` and the cache-busting `rev`
 * are derived from the category files by rebuildIndex(), which the workflow
 * runs. tools/prune.mjs finishes the job on the next run: it collects image
 * files no category references and rebuilds the index. So one commit here, and
 * the workflow reconciles.
 *
 * The cover is the case that actually breaks the site. If the deleted photo was
 * the cover, something else must be promoted — an index entry naming a cover
 * with no files behind it renders as broken images on the home page, which is
 * the failure already live on formal-suit.
 */
async function deletePhoto(slug, photoId) {
  if (state.busy) return;

  const entry = catFiles.get(slug);
  if (!entry) return;

  const photos = entry.cat.photos ?? [];
  const photo = photos.find((p) => String(p.id) === String(photoId));
  if (!photo) return;

  const label = photo.alt?.trim() || photo.caption?.trim() || photo.id;
  if (!confirm(`Remove this photo?\n\n${label}`)) return;

  state.busy = true;
  say("#cats-msg", "info", "Removing…");

  try {
    const kept = photos.filter((p) => String(p.id) !== String(photoId));

    /* Promote a new cover when the deleted photo was it. First by order, to
       match rebuildIndex()'s own `photos.find(featured) ?? photos[0]` fallback
       — so the panel and the workflow agree on which photo becomes the cover
       instead of each picking its own. */
    if (photo.featured && kept.length) {
      const next = kept
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
      next.featured = true;
    }

    const updated = { ...entry.cat, photos: kept };
    await saveCategory(
      slug,
      updated,
      entry.sha,
      `Remove ${slug}/${photo.id}`
    );

    /* The sha just changed, so the cached one is stale. Drop it and re-read on
       the next expand rather than guessing the new value — a wrong sha fails
       the NEXT delete with a confusing conflict error. */
    catFiles.delete(slug);

    const local = state.categories.find((c) => c.slug === slug);
    if (local) local.count = kept.length;

    renderCategories();
    /* Re-open the set that was just edited: collapsing it on every delete
       would mean three taps per photo when clearing out a set. */
    const btn = $(`[data-photos="${CSS.escape(slug)}"]`);
    if (btn) await togglePhotos(btn);

    say(
      "#cats-msg",
      "ok",
      kept.length
        ? `Removed. ${kept.length} photo${kept.length === 1 ? "" : "s"} left. The site rebuilds in a couple of minutes.`
        : "Removed the last photo in this set. The site rebuilds in a couple of minutes."
    );
  } catch (err) {
    catFiles.delete(slug);
    say("#cats-msg", "err", `${esc(err.message)}<br />Nothing was removed.`);
  } finally {
    state.busy = false;
  }
}

async function toggleCategory(slug) {
  if (state.busy) return;
  state.busy = true;
  say("#cats-msg", "info", "Saving…");

  try {
    const { json: cat, sha } = await loadCategory(slug);
    if (!cat) throw new Error(`data/categories/${slug}.json not found`);

    cat.published = cat.published === false;
    await saveCategory(
      slug,
      cat,
      sha,
      `${cat.published ? "Show" : "Hide"} ${slug}`
    );

    const local = state.categories.find((c) => c.slug === slug);
    if (local) local.published = cat.published;

    renderCategories();
    say(
      "#cats-msg",
      "ok",
      `${esc(cat.title ?? slug)} is now ${cat.published ? "live" : "hidden"}. The site rebuilds in a couple of minutes.`
    );
  } catch (err) {
    say("#cats-msg", "err", esc(err.message));
  } finally {
    state.busy = false;
  }
}

/**
 * Reorder, by writing the `order` field on the two affected categories.
 *
 * Only two files are written rather than renumbering everything, because each
 * write is a separate commit and a full renumber would produce six commits for
 * one arrow press.
 */
async function moveCategory(slug, delta) {
  if (state.busy) return;

  const i = state.categories.findIndex((c) => c.slug === slug);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.categories.length) return;

  state.busy = true;
  say("#cats-msg", "info", "Reordering…");

  try {
    const a = state.categories[i];
    const b = state.categories[j];

    const fa = await loadCategory(a.slug);
    const fb = await loadCategory(b.slug);
    if (!fa.json || !fb.json) throw new Error("A category file is missing");

    // Swap the stored order values, not the array positions.
    const oa = fa.json.order ?? i + 1;
    const ob = fb.json.order ?? j + 1;
    fa.json.order = ob;
    fb.json.order = oa;

    await saveCategory(a.slug, fa.json, fa.sha, `Reorder ${a.slug}`);
    await saveCategory(b.slug, fb.json, fb.sha, `Reorder ${b.slug}`);

    state.categories[i] = b;
    state.categories[j] = a;
    a.order = ob;
    b.order = oa;

    renderCategories();
    say("#cats-msg", "ok", "Order saved. The site rebuilds in a couple of minutes.");
  } catch (err) {
    say("#cats-msg", "err", esc(err.message));
  } finally {
    state.busy = false;
  }
}

/* --- Activity view ------------------------------------------------------ */

let runTimer = null;

async function renderRuns() {
  const view = $("#view-runs");
  view.innerHTML = `<p class="empty">Loading…</p>`;

  try {
    const runs = await recentRuns(6);

    if (!runs.length) {
      view.innerHTML = `<p class="empty">No publishes yet.</p>`;
      return;
    }

    const dot = (r) =>
      r.status !== "completed"
        ? "run__dot--busy"
        : r.conclusion === "success"
          ? "run__dot--ok"
          : "run__dot--bad";

    const label = (r) =>
      r.status !== "completed"
        ? "Building…"
        : r.conclusion === "success"
          ? "Published"
          : `Failed (${r.conclusion})`;

    view.innerHTML = `
      <p class="field__hint">
        A publish takes about two minutes. If one fails, open it on GitHub and
        click <strong>Re-run jobs</strong> — nothing is lost by retrying.
      </p>
      <ul class="runs">
        ${runs
          .map(
            (r) => `
          <li class="run">
            <span class="run__dot ${dot(r)}"></span>
            <span>${label(r)} · ${esc(r.title ?? "")}</span>
            <a href="${esc(r.url)}" target="_blank" rel="noopener">Open</a>
          </li>`
          )
          .join("")}
      </ul>
    `;

    /* Poll only while something is actually running, and only while this tab
       is the visible one — a fixed interval would burn API quota all day for
       no reason. */
    clearTimeout(runTimer);
    const busy = runs.some((r) => r.status !== "completed");
    if (busy && !$("#view-runs").hidden) {
      runTimer = setTimeout(renderRuns, 10000);
    }
  } catch (err) {
    view.innerHTML = `<div class="msg msg--err">${esc(err.message)}</div>`;
  }
}

/* --- Boot --------------------------------------------------------------- */

async function enterPanel() {
  $("#gate").hidden = true;
  $("#panel").hidden = false;
  $("#signout").hidden = false;

  try {
    state.categories = await loadCatalog();
    state.slug = state.categories[0]?.slug ?? null;
    renderUpload();
  } catch (err) {
    $("#view-upload").innerHTML = `<div class="msg msg--err">${esc(err.message)}</div>`;
  }
}

function leavePanel() {
  $("#gate").hidden = false;
  $("#panel").hidden = true;
  $("#signout").hidden = true;

  // Drop every blob URL and the decoded bytes with them.
  for (const q of state.queue) if (q.url) URL.revokeObjectURL(q.url);
  state.queue = [];
  state.categories = [];
  clearTimeout(runTimer);
}

function wireChrome() {
  $("#signout").addEventListener("click", signOut);

  $("#theme").addEventListener("click", () => {
    const root = document.documentElement;
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;
    try {
      // Same key the public site uses, so the choice carries across.
      localStorage.setItem("pf-theme", next);
    } catch {
      /* storage blocked — the change still applies for this page view */
    }
  });
}

wireSignIn();
wireTabs();
wireChrome();
onAuthChange((authed) => (authed ? enterPanel() : leavePanel()));

/* Repo identity is shown so it is obvious WHICH site this panel publishes to.
   Two portfolios open in two tabs would otherwise be indistinguishable. */
$("#gate .gate__lede").insertAdjacentHTML(
  "beforeend",
  ` <br /><small style="color:var(--muted)">Publishing to ${esc(REPO_OWNER)}/${esc(REPO_NAME)}</small>`
);
