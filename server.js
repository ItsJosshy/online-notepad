import http from "node:http";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_BODY = 1024 * 1024;

export async function createNotepad({
  dataDir = process.env.DATA_DIR || "./data",
  seed = true,
} = {}) {
  await mkdir(dataDir, { recursive: true });
  const filename = path.join(dataDir, "notes.json");
  let notes;
  try {
    notes = JSON.parse(await readFile(filename, "utf8"));
    if (
      !Array.isArray(notes) ||
      notes.some(
        (n) =>
          typeof n.id !== "string" ||
          typeof n.title !== "string" ||
          typeof n.content !== "string" ||
          !Number.isInteger(n.revision),
      )
    ) {
      throw new Error(
        "Invalid notes file; restore a valid backup before starting.",
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const now = new Date().toISOString();
    notes = seed
      ? [
          {
            id: randomUUID(),
            title: "",
            content: "",
            pinned: false,
            createdAt: now,
            updatedAt: now,
            revision: 1,
          },
        ]
      : [];
    await writeFile(filename, JSON.stringify(notes), { mode: 0o600 });
  }
  // Serialize mutations; acknowledge a change only after its atomic disk write succeeds.
  let queue = Promise.resolve();
  function mutate(fn) {
    const task = queue.then(async () => {
      const next = structuredClone(notes);
      const result = fn(next);
      await writeFile(`${filename}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${filename}.tmp`, filename);
      notes = next;
      return result;
    });
    queue = task.catch(() => {});
    return task;
  }
  function fail(status, message) {
    return Object.assign(new Error(message), { status });
  }
  async function body(req) {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw fail(415, "Expected application/json.");
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY)
        throw fail(413, "This note is too large (maximum 1 MB).");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw fail(400, "Invalid JSON.");
    }
  }
  function fields(value) {
    if (
      !value ||
      typeof value.title !== "string" ||
      typeof value.content !== "string" ||
      typeof value.pinned !== "boolean" ||
      value.title.length > 200 ||
      value.content.length > 500000
    ) {
      throw fail(
        400,
        "Expected a title (up to 200 characters), content (up to 500,000 characters), and pinned boolean.",
      );
    }
    return { title: value.title, content: value.content, pinned: value.pinned };
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    const json = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    try {
      // Reject cross-origin mutations, including requests from another local website.
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers.origin &&
        new URL(req.headers.origin).host !== req.headers.host
      )
        throw fail(403, "Cross-origin writes are not allowed.");
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/health" && req.method === "GET")
        return json(200, { status: "ok" });
      if (url.pathname === "/api/notes" && req.method === "GET")
        return json(200, notes);
      if (url.pathname === "/api/notes" && req.method === "POST") {
        const value = fields(await body(req));
        const note = await mutate((next) => {
          const now = new Date().toISOString();
          const note = {
            ...value,
            id: randomUUID(),
            createdAt: now,
            updatedAt: now,
            revision: 1,
          };
          next.push(note);
          return note;
        });
        return json(201, note);
      }
      const match = /^\/api\/notes\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (match && ["PUT", "DELETE"].includes(req.method)) {
        const value = await body(req);
        if (!value || !Number.isInteger(value.revision) || value.revision < 1)
          throw fail(400, "A positive revision number is required.");
        const update = req.method === "PUT" ? fields(value) : null;
        const result = await mutate((next) => {
          const index = next.findIndex((n) => n.id === match[1]);
          if (index < 0) throw fail(404, "Note no longer exists.");
          if (value.revision !== next[index].revision)
            throw fail(
              409,
              "This note changed in another tab. Your draft has been kept.",
            );
          if (!update) {
            next.splice(index, 1);
            return { deleted: true };
          }
          next[index] = {
            ...next[index],
            ...update,
            revision: next[index].revision + 1,
            updatedAt: new Date().toISOString(),
          };
          return next[index];
        });
        return json(200, result);
      }
      const assets = {
        "/stars.svg": ["stars.svg", "image/svg+xml"],
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/favicon.svg": ["favicon.svg", "image/svg+xml"],
      };
      if (["GET", "HEAD"].includes(req.method) && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        const content = await readFile(path.join(publicDir, file));
        res.writeHead(200, {
          "Content-Type": `${type}; charset=utf-8`,
          "Cache-Control": "no-cache",
        });
        return res.end(req.method === "HEAD" ? undefined : content);
      }
      return json(404, { error: "Not found." });
    } catch (error) {
      if (!error.status) console.error("Request failed:", error.message);
      if (!res.headersSent)
        json(error.status || 500, {
          error: error.status
            ? error.message
            : "Could not save to disk. Your draft is kept in this browser; retry shortly.",
        });
    }
  });
  return server;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = await createNotepad();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, "0.0.0.0", () =>
    console.log(`Still is listening on port ${port}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => server.close(() => process.exit(0)));
}
