# Goodreads to Hardcover Sync

Three tools to sync Kindle reads to Hardcover.app via Goodreads, automatically or manually.

## How it works
1. **Kindle** automatically updates your **Goodreads** "Read" shelf.
2. This script watches your **Goodreads RSS Feed**.
3. When a new book appears, it searches **Hardcover.app** via API.
4. It logs the book to your "Read" status on Hardcover, including the date read.

> **Note:** The Goodreads RSS feed can be inconsistent (often missing ISBNs). To ensure accuracy, this script uses a **robust multi-step matching strategy**:
> 1. Matches by **ISBN** (if available).
> 2. Falls back to **Title & Author** fuzzy matching.
> 3. Verifies the author to prevent mismatches (e.g., same title, different book).
> 4. **Prevents Duplicates:** It *always* checks your Hardcover library first. If a book is already there (even if added manually using a different edition), it will skip it.

---

## Option 1: Chrome Extension

The easiest way to use this tool is via the included Chrome Extension. It requires **Zero Config** because it automatically detects your credentials if you are logged into Goodreads and Hardcover in your browser.

### Installation
1.  Open Chrome and navigate to `chrome://extensions/`.
2.  Toggle **Developer mode** in the top right corner.
3.  Click **Load unpacked** (top left).
4.  Select the `extension/` folder inside this repository.

### Usage
1.  Click the **Hardcover Sync** icon in your browser toolbar.
2.  If you are logged into Goodreads and Hardcover, you will see green **Detected** status lights.
    *   *Note: If "Not Found", verify you are logged into `goodreads.com` and `hardcover.app` in other tabs.*
3.  Click **Sync Now**.
4.  The extension will scan your recent Goodreads "Read" shelf and add any missing books to Hardcover.

---

## Option 2: Cloud / Local Script (Node.js)

### 1. Setup
Clone the repository and install dependencies:

```bash
git clone https://github.com/yourusername/kindle-sync.git
cd kindle-sync
npm install
```

### 2. Configuration
Create a `.env` file in the root directory:
```bash
GOODREADS_RSS_URL="https://www.goodreads.com/review/list_rss/..."
HARDCOVER_API_TOKEN="your_hardcover_bearer_token"
```

#### How to find your credentials:
**1. Goodreads RSS URL ("Read" Shelf):**
- Go to your [My Books](https://www.goodreads.com/review/list) page on Goodreads.
- Click on the **"Read"** shelf in the left sidebar.
- Scroll to the very bottom of the page.
- Look for the tiny **RSS** icon/link (usually on the bottom right).
- Right-click and **Copy Link Address**.

**2. Hardcover API Token:**
- Go to [https://hardcover.app/account/api](https://hardcover.app/account/api).
- Copy your API Token.

### 3. Usage
Run the script manually to sync your books.

**Sync the last 10 books (Recommended):**
```bash
npm run sync -- --limit 10
```

**Sync ALL books (First run or full backfill):**
```bash
npm run sync -- --limit 0
```

**Dry Run (See what would happen):**
```bash
npm run sync -- --dry-run
```

### 4. Cleaning up duplicate read entries

Before the fix in `setReadDate`, every synced book ended up with **two** read
entries: Hardcover creates one of its own when a book is added with the Read
status, and the sync inserted a second one carrying the Goodreads date. Anything
reading that history back — Hardcover's own stats, or your own site — reports
those books as re-reads.

New syncs no longer do this. To clear up books synced before the fix:

```bash
npm run dedupe-reads                 # report on 2026, change nothing
npm run dedupe-reads -- --year 2025  # a different year
npm run dedupe-reads -- --all-years  # every year at once
npm run dedupe-reads -- --apply      # actually delete
```

It is a **dry run unless you pass `--apply`**, and it writes a JSON backup of
every entry it removes before deleting anything.

Reads are only ever compared **within a single year**, so a book you genuinely
read again in a later year keeps both of its entries. By default the entry with
the earliest finish date in a year is kept — that is the one carrying your real
Goodreads date, since the spurious entry is dated whenever the sync ran. Use
`--keep latest` to flip that.

One thing to watch: a book you genuinely read twice *in the same year* looks
identical to a duplicate, and would be collapsed to one entry. The dry run lists
every book it intends to touch, so check that list before passing `--apply`.

## GitHub Actions Setup (Free)

This script is optimized to run **daily** on GitHub Actions for free (negligible usage per year vs 2000 free minutes).

### 1. Configure Secrets
Go to your repository on GitHub:
1. Navigate to **Settings > Secrets and variables > Actions**.
2. Scroll down to **Repository secrets** (do not use Environment secrets).
3. Click **New repository secret**.
4. Add the following two secrets:
    - `GOODREADS_RSS_URL`
    - `HARDCOVER_API_TOKEN`

### 2. The Automation
- The workflow runs **automatically fast** (checking only the last 10 books) once a day.
- This prevents "retry storms" and keeps your billable minutes extremely low.

### 3. Manual Full Sync via GitHub
If you need to force a full re-sync from the web:
1. Go to the **Actions** tab in your repo.
2. Select **Kindle to Hardcover Sync** on the left.
3. Click **Run workflow**.
4. In the "Number of books" input, type **0** (or leave empty) to sync EVERYTHING.
5. Click **Run workflow**.

---

## Feedback & Support
If you encounter any issues or have feature requests, please **[Open an Issue](https://github.com/yourusername/goodreads-hardcover-sync/issues)** on GitHub. This is the best way to reach me and allows others to see solutions to common problems.