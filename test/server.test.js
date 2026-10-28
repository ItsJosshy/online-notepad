import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createNotepad } from "../server.js";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "still-test-"));
  let server;
  let base;
  async function start() {
    server = await createNotepad({ dataDir, seed: false });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await new Promise((resolve) => server.close(resolve));
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    restart: async () => {
      await stop();
      await start();
    },
    request: async (
      route = "/api/notes",
      method = "GET",
      value,
      headers = {},
    ) => {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: value === undefined ? undefined : JSON.stringify(value),
      });
      const body = await response.json();
      return { status: response.status, body, headers: response.headers };
    },
  };
}
const draft = (overrides = {}) => ({
  title: "A thought",
  content: "Saved words 🪴\nA second line.",
  pinned: false,
  ...overrides,
});

test("create, update, pin, restart, and delete a note with persistent storage", async (t) => {
  const app = await fixture(t);
  const created = await app.request("/api/notes", "POST", draft());
  assert.equal(created.status, 201);
  assert.equal(created.body.revision, 1);
  const route = `/api/notes/${created.body.id}`;
  const updated = await app.request(route, "PUT", {
    ...created.body,
    content: "An edited thought",
    pinned: true,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.revision, 2);
  await app.restart();
  assert.deepEqual((await app.request()).body, [updated.body]);
  assert.equal(
    (await app.request(route, "DELETE", { revision: 2 })).status,
    200,
  );
  await app.restart();
  assert.deepEqual((await app.request()).body, []);
});

test("simultaneous edits cannot silently overwrite each other", async (t) => {
  const app = await fixture(t);
  const { body: note } = await app.request("/api/notes", "POST", draft());
  const results = await Promise.all(
    ["One", "Two"].map((content) =>
      app.request(`/api/notes/${note.id}`, "PUT", { ...note, content }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await app.request()).body[0].revision, 2);
  assert.equal(
    (await app.request(`/api/notes/${note.id}`, "DELETE", { revision: 1 }))
      .status,
    409,
  );
});

test("parallel creation preserves every note on disk", async (t) => {
  const app = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      app.request("/api/notes", "POST", draft({ title: `Note ${i}` })),
    ),
  );
  assert.ok(results.every((r) => r.status === 201));
  await app.restart();
  assert.equal((await app.request()).body.length, 12);
  assert.equal(
    JSON.parse(await readFile(path.join(app.dataDir, "notes.json"), "utf8"))
      .length,
    12,
  );
});

test("invalid data, missing revisions, and cross-origin writes are rejected", async (t) => {
  const app = await fixture(t);
  for (const invalid of [
    null,
    {},
    draft({ title: 5 }),
    draft({ pinned: "yes" }),
    draft({ title: "a".repeat(201) }),
    draft({ content: "a".repeat(500001) }),
  ]) {
    assert.equal(
      (await app.request("/api/notes", "POST", invalid)).status,
      400,
    );
  }
  const { body: note } = await app.request("/api/notes", "POST", draft());
  assert.equal(
    (await app.request(`/api/notes/${note.id}`, "PUT", draft())).status,
    400,
  );
  assert.equal(
    (await app.request(`/api/notes/${note.id}`, "DELETE", null)).status,
    400,
  );
  assert.equal(
    (
      await app.request("/api/notes", "POST", draft(), {
        Origin: "https://unrelated.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request("/api/notes", "POST", draft(), {
        "Content-Type": "text/plain",
      })
    ).status,
    415,
  );
});

test("health, security headers and unknown routes behave correctly", async (t) => {
  const app = await fixture(t);
  const health = await app.request("/api/health");
  assert.equal(health.body.status, "ok");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    health.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal((await app.request("/server.js")).status, 404);
  assert.equal((await app.request("/data/notes.json")).status, 404);
  assert.equal(
    (
      await app.request(
        "/api/notes/00000000-0000-0000-0000-000000000000",
        "DELETE",
        { revision: 1 },
      )
    ).status,
    404,
  );
});

test("a corrupt existing data file is never replaced with an empty notebook", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "still-corrupt-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, "notes.json"), "broken-json");
  await assert.rejects(createNotepad({ dataDir }));
  assert.equal(
    await readFile(path.join(dataDir, "notes.json"), "utf8"),
    "broken-json",
  );
});
