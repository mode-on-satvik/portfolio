# Deploy guide

Everything here is **free**. No paid service, no server, no credit card. The whole site is
static files served by GitHub Pages, and GitHub Actions minutes are unlimited on public
repositories — so building and publishing costs nothing regardless of how often you do it.

Repository: <https://github.com/mode-on-satvik/portfolio>
Live site (once deployed): <https://mode-on-satvik.github.io/portfolio/>

- [What's free, and where the limits actually are](#whats-free-and-where-the-limits-actually-are)
- [Part 1 — One-time setup](#part-1--one-time-setup)
- [Part 2 — Run the site on your own machine](#part-2--run-the-site-on-your-own-machine)
- [Part 3 — Make a change and deploy it](#part-3--make-a-change-and-deploy-it)
- [Part 4 — What each command does](#part-4--what-each-command-does)
- [Part 5 — Adding photos](#part-5--adding-photos)
- [Part 6 — A free custom domain](#part-6--a-free-custom-domain)
- [Part 7 — Troubleshooting](#part-7--troubleshooting)
- [Quick reference](#quick-reference)

---

## What's free, and where the limits actually are

| Thing | Free allowance | What it means here |
|---|---|---|
| GitHub Pages hosting | Unlimited requests, **100 GB/month bandwidth (soft)** | Thousands of visitors a month is not close to the limit |
| Repository size | **1 GB (soft)** | At ~300 KB per photo across all 12 variants, roughly 500 photos is comfortable |
| Actions minutes | **Unlimited on public repos** | Image processing on publish is genuinely free |
| Custom domain | is-a.dev / eu.org are free | Optional — see [Part 6](#part-6--a-free-custom-domain) |

Two are marked *soft*: GitHub will email you rather than cut you off. Stated plainly so you
know the real shape of it, not because you're likely to hit either.

> **One thing that is not free-tier-related but worth knowing now:** the repository is public,
> so **every photo you ever commit stays in git history even after you delete it from the
> site.** Deleting a photo removes it from the gallery; it does not remove it from history.
> If that matters for a particular photo, don't upload it.

---

## Part 1 — One-time setup

Do this once. It takes about five minutes.

### 1.1 Install the two tools you need

| Tool | Why | Get it |
|---|---|---|
| **Git** | To send changes to GitHub | <https://git-scm.com/downloads> |
| **Node.js 20+** | Runs the image/page build scripts | <https://nodejs.org> (choose LTS) |

Check both are installed — open a terminal (**Git Bash** on Windows) and run:

```bash
git --version     # expect 2.30 or newer
node --version    # expect v20 or newer
```

If either prints "command not found", the install didn't add it to your PATH. Restart the
terminal first; that fixes it most of the time.

### 1.2 Get the code onto your machine

```bash
git clone https://github.com/mode-on-satvik/portfolio.git
cd portfolio
```

### 1.3 Install the build dependencies

Only the build scripts have dependencies. **The published website has none** — no framework,
no bundler, nothing to install for visitors.

```bash
cd tools
npm install
cd ..
```

This installs `sharp`, the image processor. It downloads a prebuilt binary, so it's quick.

### 1.4 Turn on GitHub Pages — set the source to "GitHub Actions"

This is the most important step, and the one that's easy to get wrong.

1. Go to <https://github.com/mode-on-satvik/portfolio/settings/pages>
2. Under **Build and deployment → Source**, choose **GitHub Actions**
   *(not "Deploy from a branch")*
3. There is nothing to save — it applies immediately

**Why "GitHub Actions" and not "Deploy from a branch"?** With branch-based Pages, a push made
by the automated workflow does **not** trigger a rebuild — GitHub deliberately suppresses that
to prevent infinite loops. The usual workaround is to store a Personal Access Token as a
repository secret so the workflow can push "as a human". Setting the source to GitHub Actions
avoids all of it: the workflow deploys the site itself, so **no secret is stored on GitHub at
all.** Fewer credentials to leak, nothing to rotate.

### 1.5 Confirm no secrets are stored

Worth checking rather than assuming, since it's the security property this whole design buys:

Go to **Settings → Secrets and variables → Actions**. The list should be **empty**.

---

## Part 2 — Run the site on your own machine

Always look at changes locally before pushing. It costs nothing and catches almost everything.

```bash
cd portfolio
python -m http.server 8080
```

Then open <http://localhost:8080>.

> **It must be `http://`, not opening the file directly.** Double-clicking `index.html` gives
> you a `file://` URL, where browsers block ES modules and `fetch()` for security reasons — the
> page will load but stay empty. A local server is not optional.

**No Python?** Any of these work the same way:

```bash
npx serve -l 8080          # needs Node, which you already have
php -S localhost:8080      # if you happen to have PHP
```

**To view it on your phone** (genuinely useful — iOS Safari's viewport behaviour and
touch-hover states cannot be trusted from a desktop emulator):

```bash
# Find your computer's local IP
ipconfig | grep IPv4        # Windows
ifconfig | grep "inet "     # macOS / Linux
```

Then on your phone, on the same Wi-Fi, open `http://192.168.1.x:8080` using whatever address
that printed. You may need to allow Python through the Windows firewall the first time.

Stop the server with **Ctrl+C**.

---

## Part 3 — Make a change and deploy it

The whole cycle. Three of these five steps are one command each.

### Step 1 — Edit

| To change… | Edit this file |
|---|---|
| Name, age, city, bio, height, languages, contact email | `data/profile.json` |
| Category titles, subtitles, blurbs, order, published on/off | `data/index.json` |
| Individual photo captions and alt text | `data/categories/<slug>.json` |
| Colours, fonts, spacing | `assets/css/tokens.css` |
| Homepage structure | `index.html` |

Almost all wording lives in `data/profile.json`. Nothing personal is hardcoded in the markup,
so you rarely need to touch HTML.

> **`profile.json` deliberately has no field for surname, date of birth, school, suburb, or
> street address.** That's the privacy boundary. Please don't add them — an absent field can't
> be leaked by a future mistake.

### Step 2 — Rebuild the generated pages

Run this **whenever you change `data/index.json`** — when you add, rename, reorder, publish or
unpublish a category:

```bash
node tools/build-pages.mjs
```

It writes one `work/<slug>/index.html` per published category, and deletes the folders of
categories you've unpublished.

You can skip this if you only edited `profile.json`, CSS, or photo captions.

### Step 3 — Check it locally

```bash
# Terminal 1
python -m http.server 8080
```

Open <http://localhost:8080> and click through: homepage → a category → open a photo → arrow
keys → Escape. Toggle the theme. Resize the window narrow.

**Optional, but it catches real bugs:** there's an automated smoke test that drives a real
browser and asserts no console errors, no broken images, no horizontal overflow, and that the
lightbox keyboard navigation actually works.

```bash
# Terminal 2 — start Chrome with remote debugging on
"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --remote-debugging-port=9222 --headless=new --user-data-dir=/tmp/pf-chrome

# Terminal 3
node tools/check.mjs
```

Expected output:

```
✓ home: loads clean
✓ home: no horizontal overflow
✓ gallery: loads clean
✓ gallery: no horizontal overflow
✓ lightbox: interaction

All checks passed.
```

### Step 4 — Commit

```bash
git add -A
git status                              # read this — confirm it's what you meant
git commit -m "Update bio and add two formal suit photos"
```

`git status` before committing is the habit worth keeping. It's the last point at which an
accidental file is trivially easy to remove.

### Step 5 — Push, and it deploys itself

```bash
git push
```

That's the deploy. There is no separate publish step.

Watch it happen at <https://github.com/mode-on-satvik/portfolio/actions> — the run takes about
a minute. When it shows a green tick, the change is live at
<https://mode-on-satvik.github.io/portfolio/>.

> **If you don't see your change immediately, that's expected, not broken.** GitHub Pages sends
> a fixed ~10 minute cache header and we cannot change it. Hard-refresh
> (**Ctrl+Shift+R**, or **Cmd+Shift+R** on Mac) to confirm the new version is actually there.
> Image filenames contain a content hash so they're never stale; it's HTML and CSS that can sit
> in your browser cache for a few minutes.

---

## Part 4 — What each command does

| Command | What it does | When to run it |
|---|---|---|
| `node tools/build-pages.mjs` | Generates `work/<slug>/index.html` from `data/index.json` | After any category change |
| `node tools/seed.mjs` | Recreates the starter JSON with grey placeholder tiles | Rarely — resetting to a blank slate |
| `node tools/make-dummies.mjs` | Generates the labelled **SAMPLE IMAGE** files currently on the site | To preview the layout before real photos exist |
| `node tools/make-dummies.mjs --clean` | Deletes all sample images | Once real photos replace them |
| `node tools/check.mjs` | Headless-browser smoke test | Before pushing anything visual |
| `node tools/shot.mjs / 1440 900 home` | Screenshots a page at a given size | Comparing before/after |

`make-dummies.mjs` **never overwrites real photography** — it skips any category that already
contains a non-sample photo. So it's safe to run at any point.

---

## Part 5 — Adding photos

There are two routes. Both end up in the same place.

### Route A — the admin panel (no terminal, works from a phone)

Open <https://mode-on-satvik.github.io/portfolio/admin/>, paste a token, drag photos in.

**Getting a token** (once, then reuse it until it expires):

1. Go to <https://github.com/settings/personal-access-tokens> → **Generate new token**
2. **Repository access** → **Only select repositories** → `mode-on-satvik/portfolio`
3. **Permissions → Repository → Contents** → **Read and write**
4. **Permissions → Repository → Actions** → **Read-only**
5. Set an expiry you're comfortable with, generate, and copy the value — GitHub shows it once

Two permissions, because they do different jobs. **Contents** covers everything that writes:
reading the JSON, committing the photos, and firing the `repository_dispatch` that starts the
build. **Actions** is read by the Activity tab alone — leave it off and uploading still works,
but Activity reports a GitHub error instead of showing you whether the build succeeded.

**Metadata: Read-only** is required too, but GitHub adds it automatically and won't let you
remove it, so there's nothing to set.

**Publishing:**

1. Pick the set from the dropdown
2. Drag photos in, or tap to choose them
3. Write alt text for each one — the panel will not publish without it
4. Optionally tick one photo as the set cover
5. **Publish**, then watch the **Activity** tab until it says Published (about two minutes)

The **Categories** tab hides, shows and reorders sets without touching photos.

Three things about this panel are worth knowing, because they look like bugs and aren't:

- **The token is never saved to the device** — not to localStorage, not to a cookie. Reloading
  the page signs you out and you'll need to paste it again. That's the point: nothing can be
  recovered from the phone afterwards.
- **GPS is stripped in the browser, before anything is uploaded.** Not on the server — the panel
  commits the original file, and a deleted file stays in git history forever on a public repo,
  so stripping it later would be too late. Orientation is deliberately preserved, or portrait
  photos would publish sideways.
- **HEIC from an iPhone is usually rejected.** Set **Settings → Camera → Formats** to
  **Most Compatible** so the phone saves JPEG, then re-pick the photos.

### Route B — the inbox folder (from a laptop, with git)

1. Put your original, full-size photos in `_inbox/<category-slug>/`:

   ```
   _inbox/formal-suit/IMG_4821.jpg
   _inbox/formal-suit/IMG_4834.jpg
   ```

2. Commit and push:

   ```bash
   git add -A && git commit -m "Add two formal suit photos" && git push
   ```

3. The workflow processes each photo into 12 files (AVIF, WebP and JPEG at 400, 800, 1200 and
   2000 pixels wide), generates the blur placeholder, records the real dimensions, **strips all
   EXIF including GPS**, updates the JSON, empties `_inbox/`, and deploys.

4. Edit the alt text and caption in `data/categories/<slug>.json`, then push again.

**Alt text is not optional.** A gallery with no alt text is meaningless to a screen reader and
invisible to image search. Write what's actually in the frame: *"Child model in a navy
three-piece suit, seated, studio lighting"* — not *"photo 3"*.

**Photos are stripped of location data twice** — once in the browser before upload, once by
`sharp` in the workflow. Phone photos carry GPS coordinates by default, and this is a child's
public portfolio, so that redundancy is deliberate.

### Replacing the sample images

The site currently shows generated placeholders marked **SAMPLE IMAGE · NOT FINAL ARTWORK**.
When real photos arrive:

```bash
node tools/make-dummies.mjs --clean   # remove the samples
# add real photos via Route A or B
```

---

## Part 6 — A free custom domain

`mode-on-satvik.github.io/portfolio/` works, but it reads as a GitHub URL. Two free services
give you something cleaner — worth doing when you're sending the link to a casting director.

| Service | Result | How |
|---|---|---|
| **is-a.dev** | `satvik.is-a.dev` | Open a pull request at <https://github.com/is-a-dev/register> |
| **eu.org** | `satvik.eu.org` | Apply at <https://nic.eu.org> (approval takes days to weeks) |

Once approved:

1. Point the domain at GitHub Pages with a `CNAME` DNS record → `mode-on-satvik.github.io`
2. In **Settings → Pages → Custom domain**, enter your domain and tick **Enforce HTTPS**
   (GitHub issues the certificate free via Let's Encrypt)

**No code changes are needed.** Every asset path on the site is resolved relative to the page's
declared depth rather than being root-absolute, so the exact same build serves correctly from
`/portfolio/` and from the root of a custom domain. That was the point of building it that way
(`assets/js/paths.js`).

---

## Part 7 — Troubleshooting

### The page is blank, or only the header shows

Open the browser console (**F12**) and read the first red line.

| What it says | Cause | Fix |
|---|---|---|
| `Failed to fetch` / CORS / `file://` | Opened the file directly | Use `python -m http.server 8080` |
| `404` on a `.css` or `.js` file | Wrong `data-depth` on `<html>` | Re-run `node tools/build-pages.mjs` |
| `JSON.parse: unexpected token` | Broken JSON, usually a trailing comma | Paste the file into <https://jsonlint.com> |

### My change is live in the Actions log but not in the browser

Hard-refresh: **Ctrl+Shift+R**. If it's still stale after ten minutes, open the page in a
private window — that bypasses the cache entirely and tells you whether the problem is your
browser or the deploy.

### A category page 404s

Its folder doesn't exist yet. Run `node tools/build-pages.mjs`, then commit the new
`work/<slug>/` folder. Also check `"published": true` in `data/index.json` — an unpublished
category has its folder deliberately removed.

### The workflow run failed (red X)

1. Open <https://github.com/mode-on-satvik/portfolio/actions>
2. Click the failed run, then the failed step, and read the last ~20 lines

`_inbox/` is only emptied on success, so a failed run leaves your photos where they were.
**Re-running is always safe** — the pipeline is idempotent by design. Click "Re-run jobs".

### Pages isn't deploying at all

Check <https://github.com/mode-on-satvik/portfolio/settings/pages> still says
**Source: GitHub Actions**. If it says "Deploy from a branch", the workflow's deploy step is
being ignored. That's [step 1.4](#14-turn-on-github-pages--set-the-source-to-github-actions).

### `npm install` fails in `tools/`

Usually a `sharp` binary that doesn't match your Node version. Update Node to the current LTS,
then:

```bash
cd tools
rm -rf node_modules package-lock.json
npm install
```

### I committed something I shouldn't have

Stop, and don't push if you haven't yet:

```bash
git reset --soft HEAD~1    # undo the commit, keep the file changes
```

If you already pushed, the file is in public history. Rewriting history with
`git filter-repo` is possible but must be followed by rotating anything exposed — and for a
photo, assume it may already have been fetched.

---

## Quick reference

```bash
# --- Every day ---
python -m http.server 8080                    # preview at localhost:8080
node tools/build-pages.mjs                    # after editing data/index.json
git add -A && git commit -m "..." && git push # deploy

# --- Occasionally ---
cd tools && npm install && cd ..              # first time, or after a Node upgrade
node tools/check.mjs                          # smoke test (needs Chrome on :9222)
node tools/make-dummies.mjs                   # regenerate sample images
node tools/make-dummies.mjs --clean           # remove sample images
```

| Link | |
|---|---|
| Repository | <https://github.com/mode-on-satvik/portfolio> |
| Live site | <https://mode-on-satvik.github.io/portfolio/> |
| Deploy runs | <https://github.com/mode-on-satvik/portfolio/actions> |
| Pages settings | <https://github.com/mode-on-satvik/portfolio/settings/pages> |

**Never commit:** a Personal Access Token, `.env`, or any file ending `.local.json`.
`.gitignore` already blocks those three patterns — but `git status` before every commit is what
actually keeps it true.
