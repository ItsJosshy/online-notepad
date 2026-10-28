import { chromium } from "playwright";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { createNotepad } from "../server.js";
import assert from "node:assert/strict";
const dataDir = await mkdtemp(path.join(os.tmpdir(), "still-browser-"));
const server = await createNotepad({ dataDir });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(await page.locator("#title").count(), 0);
  assert.equal(await page.locator("#content").inputValue(), "");
  assert.equal(
    await page.locator(".note-card.selected").innerText(),
    "Empty note",
  );
  assert.equal(
    await page.locator("#content").getAttribute("placeholder"),
    null,
  );
  if (process.env.SCREENSHOT_DIR) {
    await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(process.env.SCREENSHOT_DIR, "desktop.png"),
    });
  }
  await page.locator("#new-note").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#content").value === "" &&
      document.activeElement.id === "content",
  );
  await page
    .locator("#content")
    .fill("A thought worth keeping.\n\nSaved automatically.");
  await page.waitForFunction(
    () => document.querySelector("#save-label").textContent === "Saved",
  );
  await page.reload();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(
    await page.locator(".note-card.selected").innerText(),
    "A thought worth keeping.",
  );
  assert.equal(
    await page.locator("#content").inputValue(),
    "A thought worth keeping.\n\nSaved automatically.",
  );
  // Sidebar labels follow the first non-empty line immediately, including edits and clearing.
  await page.locator("#content").fill("\n\nChanged first line\nAnother line");
  assert.equal(
    await page.locator(".note-card.selected").innerText(),
    "Changed first line",
  );
  await page.locator("#content").fill("");
  assert.equal(
    await page.locator(".note-card.selected").innerText(),
    "Empty note",
  );
  await page
    .locator("#content")
    .fill("A thought worth keeping.\n\nSaved automatically.");
  await page.waitForFunction(
    () => document.querySelector("#save-label").textContent === "Saved",
  );
  console.log(
    "PASS blank notes, content-derived labels, autosave, and reload persistence",
  );
  await page.locator("#pin").click();
  await page.waitForFunction(
    () => document.querySelector("#save-label").textContent === "Saved",
  );
  assert.equal(await page.locator("#pin").getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Control+k");
  await page.locator("#search").fill("worth keeping");
  assert.equal(await page.locator(".note-card").count(), 1);
  await page.locator("#search").fill("unfindable phrase");
  assert.equal(await page.locator(".note-card").count(), 0);
  await page.keyboard.press("Escape");
  console.log("PASS pin and full-text search");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "A thought worth keeping.txt");
  const exported = await download.createReadStream();
  const chunks = [];
  for await (const chunk of exported) chunks.push(chunk);
  assert.equal(
    Buffer.concat(chunks).toString(),
    "A thought worth keeping.\n\nSaved automatically.",
  );
  await page.locator("#focus").click();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".sidebar").isVisible(), true);
  console.log("PASS text export and focus mode");
  // Simulate an outage and recover when the connection returns.
  await context.setOffline(true);
  await page.locator("#content").fill("An offline thought, kept safely.");
  await page.waitForFunction(
    () =>
      document.querySelector("#save-label").textContent ===
      "Draft kept in this browser",
  );
  assert.ok(
    await page.evaluate(() =>
      localStorage.getItem("still.drafts.v1").includes("offline thought"),
    ),
  );
  await context.setOffline(false);
  await page.waitForFunction(
    () => document.querySelector("#save-label").textContent === "Saved",
  );
  await page.reload();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#content").inputValue(),
    "An offline thought, kept safely.",
  );
  console.log("PASS offline draft caching and reconnect sync");
  // Keep GET available, but interrupt saves to exercise a reload with an unsynced draft.
  await page.route("**/api/notes/*", (route) =>
    route.request().method() === "PUT" ? route.abort() : route.continue(),
  );
  await page.locator("#content").fill("A draft that survives a page reload.");
  await page.waitForFunction(
    () =>
      document.querySelector("#save-label").textContent ===
      "Draft kept in this browser",
  );
  await page.reload();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#content").inputValue(),
    "A draft that survives a page reload.",
  );
  await page.waitForFunction(
    () =>
      document.querySelector("#save-label").textContent ===
      "Draft kept in this browser",
  );
  await page.unroute("**/api/notes/*");
  await page.locator("#retry").click();
  await page.waitForFunction(
    () => document.querySelector("#save-label").textContent === "Saved",
  );
  console.log("PASS unsynced draft recovery after a reload");
  // Edit again while an earlier request is still in flight.
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  await page.route("**/api/notes/*", async (route) => {
    if (route.request().method() === "PUT") {
      requestStarted();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });
  await page.locator("#content").fill("First version");
  await started;
  await page.locator("#content").fill("The latest version must win.");
  await page.waitForFunction(
    () => document.querySelector("#save-label").textContent === "Saved",
  );
  await page.unroute("**/api/notes/*");
  await page.reload();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#content").inputValue(),
    "The latest version must win.",
  );
  console.log(
    "PASS edits during an in-flight save preserve the latest content",
  );

  // Another tab saves a newer revision. The stale tab must preserve its draft.
  const second = await context.newPage();
  await second.goto(base);
  await second.locator("#editor").waitFor({ state: "visible" });
  await second.locator("#content").fill("A newer version in tab two.");
  await second.waitForFunction(
    () => document.querySelector("#save-label").textContent === "Saved",
  );
  await page.locator("#content").fill("My separate thought in tab one.");
  await page
    .locator("#retry")
    .getByText("Keep as new note", { exact: true })
    .waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#content").inputValue(),
    "My separate thought in tab one.",
  );
  await page.locator("#retry").click();
  await page
    .locator("#toast")
    .getByText("Your draft was saved as a new note.", { exact: true })
    .waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#content").inputValue(),
    "My separate thought in tab one.",
  );
  const notes = await page.evaluate(() =>
    fetch("/api/notes").then((r) => r.json()),
  );
  assert.ok(notes.some((n) => n.content === "A newer version in tab two."));
  assert.ok(notes.some((n) => n.content === "My separate thought in tab one."));
  console.log(
    "PASS conflict detection and recovery without overwriting either version",
  );
  await second.close();
  await page.locator("#delete").click();
  await page.getByRole("button", { name: "Keep note", exact: true }).click();
  assert.equal(
    await page.locator("#content").inputValue(),
    "My separate thought in tab one.",
  );
  await page.locator("#delete").click();
  await page
    .locator("#delete-dialog")
    .getByRole("button", { name: "Delete note", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector("#content").value !==
      "My separate thought in tab one.",
  );
  console.log("PASS delete confirmation, cancel, and deletion");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#toast").waitFor({ state: "hidden" });
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({
      path: path.join(process.env.SCREENSHOT_DIR, "mobile.png"),
    });
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.locator("#mobile-menu").click();
  assert.equal(await page.locator(".sidebar").isVisible(), true);
  await page.locator(".note-card").first().click();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  console.log("PASS mobile navigation and no horizontal overflow");
  assert.deepEqual(errors, []);
  console.log("PASS no browser runtime errors");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
