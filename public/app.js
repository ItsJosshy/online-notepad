const $ = (selector) => document.querySelector(selector);
const state = {
  notes: [],
  active: null,
  dirty: new Set(),
  blocked: new Set(),
  failed: new Set(),
  saving: new Map(),
  timers: new Map(),
  maxTimers: new Map(),
  loaded: false,
};
const DRAFT_KEY = "still.drafts.v1";
const ACTIVE_KEY = "still.active.v1";
let noticeAction = null;
let toastTimer;
const icon = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};
const activeNote = () => state.notes.find((n) => n.id === state.active);
const noteLabel = (note) =>
  note.content
    .trim()
    .split(/[\r\n]/, 1)[0]
    .slice(0, 100) || "Empty note";
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 3000);
}
function notice(message, action = null, label = "Retry save") {
  $("#notice-text").textContent = message;
  $("#notice").hidden = !message;
  $("#retry").hidden = !action;
  $("#retry").textContent = label;
  noticeAction = action;
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || "Something went wrong."), {
      status: response.status,
    });
  return result;
}
function cacheDrafts() {
  try {
    const drafts = state.notes.filter((note) => state.dirty.has(note.id));
    if (drafts.length) localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
    else localStorage.removeItem(DRAFT_KEY);
    return true;
  } catch {
    notice(
      "Browser draft storage is unavailable. Keep this tab open until your changes are saved.",
    );
    return false;
  }
}
function readDrafts() {
  try {
    const drafts = JSON.parse(localStorage.getItem(DRAFT_KEY) || "[]");
    return Array.isArray(drafts)
      ? drafts.filter(
          (n) =>
            typeof n.id === "string" &&
            typeof n.title === "string" &&
            typeof n.content === "string" &&
            Number.isInteger(n.revision) &&
            !isNaN(Date.parse(n.updatedAt)),
        )
      : [];
  } catch {
    return [];
  }
}
function renderList() {
  const query = $("#search").value.trim().toLocaleLowerCase();
  const notes = state.notes
    .filter((note) => note.content.toLocaleLowerCase().includes(query))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  $("#note-count").textContent = state.notes.length;
  $("#note-list").replaceChildren(
    ...notes.map((note) => {
      const card = document.createElement("button");
      card.className = `note-card${note.id === state.active ? " selected" : ""}`;
      card.setAttribute("aria-current", String(note.id === state.active));
      card.setAttribute("aria-label", `Open ${noteLabel(note)}`);
      const title = document.createElement("span");
      title.className = "card-title";
      const titleText = document.createElement("span");
      titleText.textContent = noteLabel(note);
      title.append(titleText);
      if (note.pinned) title.append(icon("pin"));
      card.append(title);
      card.addEventListener("click", () => selectNote(note.id));
      return card;
    }),
  );
  $("#list-empty").hidden = !!notes.length || !state.loaded;
}
function updateStatus() {
  const note = activeNote();
  let status = "saved",
    label = "Saved";
  if (note && state.dirty.has(note.id)) {
    const failed = state.blocked.has(note.id) || state.failed.has(note.id);
    status = failed ? "error" : "saving";
    label = failed ? "Draft kept in this browser" : "Saving…";
  }
  $("#save-status").dataset.state = status;
  $("#save-label").textContent = label;
}
function showConflict(id) {
  notice(
    "This note changed elsewhere or was deleted. Keep your draft as a new note to preserve both versions.",
    () => recoverNote(id),
    "Keep as new note",
  );
}
function selectNote(id, focus = false) {
  const previous = state.active;
  if (previous && state.dirty.has(previous)) saveNote(previous);
  state.active = id;
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* Selection storage is optional. */
  }
  const note = activeNote();
  $("#loading").hidden = true;
  $("#editor").hidden = !note;
  $("#empty-state").hidden = !!note;
  $("#note-actions").hidden = !note;
  $("#save-status").hidden = !note;
  if (note) {
    $("#content").value = note.content;
    $("#pin").setAttribute("aria-pressed", String(note.pinned));
    $("#pin").setAttribute(
      "aria-label",
      note.pinned ? "Unpin note" : "Pin note",
    );
    $("#pin").title = note.pinned ? "Unpin note" : "Pin note";
    document.title = `${noteLabel(note)} — Still`;
    if (state.blocked.has(id)) showConflict(id);
  } else document.title = "Still — A little space to think";
  document.body.classList.remove("sidebar-open");
  $("#mobile-menu").setAttribute("aria-expanded", "false");
  updateStatus();
  renderList();
  if (focus && note) $("#content").focus();
}
function markDirty(note) {
  note.updatedAt = new Date().toISOString();
  state.dirty.add(note.id);
  cacheDrafts();
  clearTimeout(state.timers.get(note.id));
  state.timers.set(
    note.id,
    setTimeout(() => saveNote(note.id), 400),
  );
  if (!state.maxTimers.has(note.id))
    state.maxTimers.set(
      note.id,
      setTimeout(() => saveNote(note.id), 2000),
    );
  renderList();
  updateStatus();
}
function clearTimers(id) {
  clearTimeout(state.timers.get(id));
  clearTimeout(state.maxTimers.get(id));
  state.timers.delete(id);
  state.maxTimers.delete(id);
}
function saveNote(id) {
  clearTimers(id);
  if (state.saving.has(id)) return state.saving.get(id);
  if (!state.dirty.has(id) || state.blocked.has(id)) return Promise.resolve();
  const task = (async () => {
    while (state.dirty.has(id) && !state.blocked.has(id)) {
      const note = state.notes.find((n) => n.id === id);
      if (!note) return;
      const snapshot = JSON.stringify(note);
      try {
        const saved = await api(`/api/notes/${id}`, {
          method: "PUT",
          body: snapshot,
        });
        // Preserve edits made while this save was in flight and save them next.
        const unchanged = JSON.stringify(note) === snapshot;
        state.failed.delete(id);
        note.revision = saved.revision;
        if (unchanged) {
          note.updatedAt = saved.updatedAt;
          state.dirty.delete(id);
        }
        cacheDrafts();
        if (
          !state.blocked.size &&
          !state.notes.some((n) => state.dirty.has(n.id))
        )
          notice("");
      } catch (error) {
        state.failed.add(id);
        cacheDrafts();
        if (error.status === 409 || error.status === 404) {
          state.blocked.add(id);
          showConflict(id);
        } else {
          notice(
            error.status
              ? error.message
              : "You’re offline. Your draft is kept in this browser and will sync when you reconnect.",
            () => saveNote(id),
          );
        }
        break;
      }
      updateStatus();
    }
  })().finally(() => {
    state.saving.delete(id);
    updateStatus();
  });
  state.saving.set(id, task);
  return task;
}
async function newNote() {
  $("#new-note").disabled = $("#empty-new").disabled = true;
  try {
    const note = await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({ title: "", content: "", pinned: false }),
    });
    state.notes.push(note);
    $("#search").value = "";
    selectNote(note.id, true);
  } catch {
    notice(
      "Could not create a note. Check your connection and try again.",
      newNote,
      "Try again",
    );
  } finally {
    $("#new-note").disabled = $("#empty-new").disabled = false;
  }
}
async function recoverNote(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  // Pause editing while creating the recovery copy so no newer edits can be lost.
  $("#content").disabled = true;
  try {
    const saved = await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({
        title: "",
        content: note.content,
        pinned: note.pinned,
      }),
    });
    const index = state.notes.indexOf(note);
    state.notes.splice(index, 1, saved);
    state.dirty.delete(id);
    state.blocked.delete(id);
    clearTimers(id);
    cacheDrafts();
    notice("");
    await loadNotes(saved.id);
    toast("Your draft was saved as a new note.");
  } catch {
    notice(
      "Could not recover the note. Your draft is still here.",
      () => recoverNote(id),
      "Try again",
    );
  } finally {
    $("#content").disabled = false;
  }
}
async function loadNotes(preferredId) {
  if (!preferredId) {
    try {
      preferredId = localStorage.getItem(ACTIVE_KEY);
    } catch {
      /* Selection storage is optional. */
    }
  }
  try {
    const notes = await api("/api/notes");
    const drafts = readDrafts();
    state.notes = notes;
    state.dirty.clear();
    state.blocked.clear();
    for (const draft of drafts) {
      const index = notes.findIndex((n) => n.id === draft.id);
      if (index < 0 || notes[index].revision !== draft.revision)
        state.blocked.add(draft.id);
      if (index < 0) notes.push(draft);
      else notes[index] = draft;
      state.dirty.add(draft.id);
    }
    state.loaded = true;
    notice("");
    const sorted = [...notes].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
    selectNote(
      notes.some((n) => n.id === preferredId)
        ? preferredId
        : sorted[0]?.id || null,
    );
    if (drafts.length) toast("Your unsaved drafts have been restored.");
    for (const id of state.dirty) if (!state.blocked.has(id)) saveNote(id);
    if (state.blocked.size) showConflict([...state.blocked][0]);
  } catch {
    const drafts = readDrafts();
    if (!state.loaded && drafts.length) {
      state.notes = drafts;
      state.dirty = new Set(drafts.map((n) => n.id));
      selectNote(drafts[0].id);
    }
    $("#loading").hidden = true;
    notice(
      "Cannot reach your notebook. Check your connection to load your saved notes.",
      () => loadNotes(state.active),
      "Reconnect",
    );
  }
}
$("#content").addEventListener("input", () => {
  const note = activeNote();
  if (!note) return;
  note.content = $("#content").value;
  document.title = `${noteLabel(note)} — Still`;
  markDirty(note);
});
$("#new-note").addEventListener("click", newNote);
$("#empty-new").addEventListener("click", newNote);
$("#search").addEventListener("input", renderList);
$("#retry").addEventListener("click", async () => {
  if (!noticeAction) return;
  const action = noticeAction;
  $("#retry").disabled = true;
  try {
    await action();
  } finally {
    $("#retry").disabled = false;
  }
});
$("#pin").addEventListener("click", () => {
  const note = activeNote();
  if (!note) return;
  note.pinned = !note.pinned;
  $("#pin").setAttribute("aria-pressed", String(note.pinned));
  $("#pin").setAttribute("aria-label", note.pinned ? "Unpin note" : "Pin note");
  $("#pin").title = note.pinned ? "Unpin note" : "Pin note";
  markDirty(note);
});
$("#export").addEventListener("click", () => {
  const note = activeNote();
  if (!note) return;
  const url = URL.createObjectURL(
    new Blob([note.content], {
      type: "text/plain;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${
    noteLabel(note)
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .slice(0, 100) || "note"
  }.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
let deletingId = null;
$("#delete").addEventListener("click", () => {
  deletingId = state.active;
  $("#delete-dialog").showModal();
});
$("#delete-dialog").addEventListener("close", async () => {
  if ($("#delete-dialog").returnValue !== "delete") return;
  const id = deletingId;
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  clearTimers(id);
  $("#content").disabled = $("#pin").disabled = true;
  try {
    await saveNote(id);
    if (state.dirty.has(id)) {
      if (state.blocked.has(id)) showConflict(id);
      else notice("Save your draft before deleting it.", () => saveNote(id));
      return;
    }
    await api(`/api/notes/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ revision: note.revision }),
    });
    state.notes = state.notes.filter((n) => n.id !== id);
    cacheDrafts();
    if (state.active === id) selectNote(state.notes[0]?.id || null);
    else renderList();
    toast("Note deleted.");
  } catch (error) {
    notice(
      error.status === 409
        ? "This note changed elsewhere. Reload before deleting it."
        : "Could not delete this note. Please try again.",
    );
  } finally {
    $("#content").disabled = $("#pin").disabled = false;
  }
});
$("#focus").addEventListener("click", () => {
  const focused = document.body.classList.toggle("focus-mode");
  $("#focus").setAttribute("aria-pressed", String(focused));
  $("#focus").setAttribute(
    "aria-label",
    focused ? "Exit focus mode" : "Enter focus mode",
  );
  $("#focus").title = focused ? "Exit focus mode" : "Focus mode";
});
$("#mobile-menu").addEventListener("click", () => {
  document.body.classList.remove("focus-mode");
  $("#focus").setAttribute("aria-pressed", "false");
  $("#focus").setAttribute("aria-label", "Enter focus mode");
  const open = document.body.classList.toggle("sidebar-open");
  $("#mobile-menu").setAttribute("aria-expanded", String(open));
});
$("#sidebar-backdrop").addEventListener("click", () => {
  document.body.classList.remove("sidebar-open");
  $("#mobile-menu").setAttribute("aria-expanded", "false");
});
$("#search").addEventListener("blur", () => {
  if (!$("#search").value) $(".search").hidden = true;
});
document.addEventListener("keydown", (event) => {
  const editing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.body.classList.remove("focus-mode");
    $("#focus").setAttribute("aria-pressed", "false");
    $("#focus").setAttribute("aria-label", "Enter focus mode");
    document.body.classList.add("sidebar-open");
    $("#mobile-menu").setAttribute("aria-expanded", "true");
    $(".search").hidden = false;
    $("#search").focus();
  }
  if (
    !editing &&
    event.key.toLowerCase() === "n" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !$("#delete-dialog").open
  ) {
    event.preventDefault();
    newNote();
  }
  if (event.key === "Escape") {
    $("#search").value = "";
    $(".search").hidden = true;
    renderList();
    document.body.classList.remove("sidebar-open", "focus-mode");
    $("#mobile-menu").setAttribute("aria-expanded", "false");
    $("#focus").setAttribute("aria-pressed", "false");
    $("#focus").setAttribute("aria-label", "Enter focus mode");
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (state.active) saveNote(state.active);
  }
});
window.addEventListener("beforeunload", (event) => {
  if (state.dirty.size) {
    cacheDrafts();
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) for (const id of state.dirty) saveNote(id);
});
window.addEventListener("online", () => {
  for (const id of state.dirty) saveNote(id);
});
// Retry transient outages without requiring another keystroke.
setInterval(() => {
  for (const id of state.dirty) if (!state.blocked.has(id)) saveNote(id);
}, 10000);
if (!/Mac|iPhone|iPad/.test(navigator.platform))
  $("#search-shortcut").textContent = "Ctrl K";
loadNotes();
