# Still — online notepad

A minimal notepad with a black starfield, a transparent liquid-glass editor, and real-time autosave. Create a blank note with the + button and start typing. The sidebar shows the first non-empty line of each note; the active note has a glass highlight. There is no separate title field. Built with vanilla HTML/CSS/JavaScript and a small Node.js server; no runtime packages, external fonts, or third-party services.

## Run with Docker

```sh
docker compose up --build -d
```

Open **http://localhost:3000**. The image runs as a non-root user and includes a health check. Compose binds to the local machine only.

Notes live in the named Docker volume `notes` at `/app/data/notes.json`, and survive container restarts, rebuilds, and `docker compose down`. **`docker compose down -v` removes the volume and all notes.** Back up the volume before deleting it. Run only one application instance per data volume.

```sh
docker compose logs -f
docker compose down
```

This is a single shared notebook with no login or user accounts. Anyone with access to the server can read and edit its notes. Keep the default loopback binding for personal use; if you choose to expose it remotely, put it behind an authenticated HTTPS reverse proxy.

## Features

- Create, edit, search, pin, download, and delete plain-text notes.
- Save after a 400 ms pause, or at least every two seconds while typing.
- Display saving, saved, and unsynced-draft states.
- Keep pending edits in browser storage and retry after a connection outage.
- Restore unsynced drafts on reload. If another tab has edited or deleted the note, offer **Keep as new note** to preserve both versions.
- Focus mode, mobile navigation, and keyboard shortcuts.
- A blank note opens when the data file is first created. Empty notes appear as “Empty note” in the sidebar. Deleting all notes leaves an empty notebook.

Autosave means saving your edits, not live collaborative editing: other tabs load changes on reload. Browser draft recovery depends on local storage being available; private browsing or clearing site data can remove drafts. New notes require a server connection. Individual notes support up to 500,000 characters (requests up to 1 MB). Downloads contain exactly the note text, with a filename based on its first non-empty line.

## Local development

Requires Node.js 22 or newer (Docker uses Node 24).

```sh
npm ci
npm run dev
```

Open **http://localhost:3000**. Notes are stored in the ignored `data/` directory. No compilation is needed. The Node watcher restarts the server when server files change; refresh the browser after frontend edits.

Optional environment variables:

| Variable   | Default  | Purpose                                      |
| ---------- | -------- | -------------------------------------------- |
| `PORT`     | `3000`   | Server listening port                        |
| `DATA_DIR` | `./data` | Persistent notes directory; must be writable |

The JSON store serializes changes and atomically replaces its data file before acknowledging a save. Revision checks reject stale updates and deletes. An unreadable or invalid existing store stops startup instead of overwriting your notes.

## Test

```sh
npm test
```

The built-in Node test runner exercises real HTTP requests with isolated temporary stores: create/edit/delete, persistence across restart, concurrent writes, stale revisions, validation, cross-origin protections, and corrupt-file preservation. No dependencies are required for these server tests.

Run the browser regression checks with Playwright:

```sh
npx playwright install --with-deps chromium
npm run test:browser
```

If Chromium is already installed, use `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser` instead. The browser suite starts an isolated temporary server and tests autosave, reload/draft recovery, updates during in-flight saves, search, pinning, export, focus mode, conflicting tabs, deletion, and mobile navigation. Set `SCREENSHOT_DIR` to save desktop and mobile screenshots.

For a quick manual browser check: create and edit a note, wait for **Saved**, reload, then verify the text and sidebar label. Test offline recovery using browser DevTools’ offline mode. For conflict recovery, open the same note in two tabs, save in the first, then edit the second; keep the second tab’s draft as a new note.

## Shortcuts

| Key                        | Action                                      |
| -------------------------- | ------------------------------------------- |
| `⌘ K` / `Ctrl K`           | Open note search                            |
| `N` (outside a text field) | Create note                                 |
| `⌘ S` / `Ctrl S`           | Save now                                    |
| `Escape`                   | Leave focus mode or close mobile navigation |

## Project layout

- `server.js` — HTTP server, static files, revision checks, persistent JSON store.
- `public/` — accessible, responsive notepad interface; no build step.
- `test/server.test.js` — server integration tests.
- `scripts/browser-smoke.mjs` — browser regression checks.
- `Dockerfile`, `compose.yaml` — container and persistent volume configuration.
