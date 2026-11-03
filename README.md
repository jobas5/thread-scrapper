# Thread Scrapper

A small web app that scrapes posts from [Threads](https://www.threads.com) using the Chrome
you are **already logged into**. Nothing is copied out of the browser: a tiny Chrome extension opens
the page in a tab of your own Chrome, scrolls it, extracts the posts and hands them to a local web
app where you can browse, filter and export them as CSV or JSON.

```
┌──────────────┐  queue job   ┌──────────────┐  poll / report  ┌───────────────────────┐
│  Web app UI  │ ───────────▶ │ Local server │ ◀─────────────▶ │ Chrome extension      │
│ localhost:3000│ ◀─────────── │ (Express)    │                 │ (your logged-in Chrome│
└──────────────┘  results     └──────────────┘                 │  opens + scrolls page)│
                                                               └───────────────────────┘
```

## What you get for every post

| field       | description                                            |
|-------------|--------------------------------------------------------|
| `id`        | Threads post id (e.g. `DfL-V8UEn9e`)                    |
| `username`  | author handle without the `@`                           |
| `url`       | full link to the post                                   |
| `timestamp` | ISO 8601 publish time                                   |
| `text`      | post text, paragraphs separated by newlines             |
| `likes`, `replies`, `reposts`, `shares` | counts as numbers (8.2K → 8200) |
| `media`     | list of `{type: image \| video, src, alt / poster}`     |
| `links`     | external links in the post                              |
| `quoted`    | the quoted post (same fields) when the post quotes one  |

## Requirements

- macOS, Windows or Linux
- [Node.js](https://nodejs.org) 18 or newer (`node -v` to check)
- Google Chrome, signed in to Threads

## Step-by-step setup

### 1. Get the code

```bash
git clone https://github.com/jobas5/thread-scrapper.git
cd thread-scrapper
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the server

```bash
npm start
```

You should see:

```
Thread scrapper running at http://localhost:3000
```

Leave this terminal open. Open http://localhost:3000 in Chrome. The header says
**extension offline** until step 4 is done.

### 4. Load the Chrome extension (once)

1. In the Chrome that is signed in to Threads, open `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `extension` folder inside this project (for example
   `/Users/you/thread-scrapper/extension`). You can also drag the folder onto the page.
5. Go back to http://localhost:3000. Within a few seconds the header turns green:
   **extension connected**.

The extension stays installed. Next time you only need `npm start`.

### 5. Run your first scrape

1. Paste a Threads URL into the box. Any of these work:
   - a profile: `https://www.threads.com/@username` or just `@username`
   - a single thread: `https://www.threads.com/@username/post/XXXXXXXX`
   - a search: `https://www.threads.com/search?q=keyword`
2. Set **Max posts** (default 50).
3. Click **Scrape**.

Chrome opens the page in a new tab, scrolls until the limit is reached or nothing new loads, then
closes the tab. The job row shows live progress; when it says **done**, click the row to see the
posts.

### 6. Export the data

Above the results table:

- **Download CSV** – one row per post, opens in Excel / Google Sheets
- **Download JSON** – full structure including media and quoted posts

The **Filter text…** box searches inside the loaded results.

Everything is also available over HTTP, e.g. `GET /api/jobs/<id>/export?format=csv`.

## Options

| option | where | meaning |
|--------|-------|---------|
| Max posts | form | stop after this many posts (1–5000) |
| Open the scrape tab in the background | checkbox | keeps Chrome from switching to the tab, but Chrome may lazy-load fewer posts |
| Server URL | extension popup | change if you run the server on a port other than 3000 (`PORT=4000 npm start`) |

## Project layout

```
server/index.js        Express server: job queue, result storage, CSV/JSON export
public/index.html      the web UI (plain HTML/JS, no build step)
extension/manifest.json  Chrome extension (Manifest V3)
extension/background.js  polls the server, opens tabs, relays results
extension/scraper.js     runs inside the Threads tab, parses posts while scrolling
extension/popup.*        small status popup with the server URL setting
data/jobs.json         scraped data (created on first run, git-ignored)
```

## API

| method | path | purpose |
|--------|------|---------|
| `GET`  | `/api/status` | is the extension connected, how many jobs queued |
| `GET`  | `/api/jobs` | list jobs |
| `POST` | `/api/jobs` | `{ "url", "maxPosts", "background" }` → create a job |
| `GET`  | `/api/jobs/:id` | job with its posts |
| `GET`  | `/api/jobs/:id/export?format=csv\|json` | download |
| `POST` | `/api/jobs/:id/cancel` | cancel a queued job |
| `DELETE` | `/api/jobs/:id` | delete a job and its data |

## Troubleshooting

**Header stays "extension offline"**
- Make sure `npm start` is running and the extension is loaded in the *same* Chrome profile that
  is logged in to Threads.
- Click the extension icon; the popup shows whether it can reach the server and lets you fix the
  server URL.
- After editing files in `extension/`, press the reload icon on `chrome://extensions`.

**Job fails with "redirected to the login page"**
- Open https://www.threads.com in that Chrome and sign in, then run the job again.

**Fewer posts than expected**
- Threads loads posts lazily. Untick "Open the scrape tab in the background" so the tab is
  visible while scrolling.
- Replies hidden behind "View more replies" buttons are not expanded.

**Text or counts look wrong**
- Threads changes its markup from time to time. The selectors live in `extension/scraper.js`
  (`parsePost`). The post container is `div[data-pressable-container="true"]`, text is in
  `span[dir="auto"]`, and the action buttons are identified by their SVG `<title>`
  (Like / Reply / Repost / Share).

## Notes

- Scraped data is stored locally in `data/jobs.json` and never leaves your machine.
- Be gentle with large limits; the scraper scrolls about one screen every 1.5 seconds.
- Use this on content you are allowed to collect and respect Threads' terms of service.
