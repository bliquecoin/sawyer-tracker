(function (root) {
  "use strict";

  function create({ storage, householdId, onDiscard, onError }) {
    const formIds = new Set(["seizure-form", "note-form", "vet-form", "blood-test-form", "setup-form"]);
    const prefix = () => `sawyer-draft:${householdId()}:`;
    const key = (form) => `${prefix()}${form.getAttribute("id")}:${form.elements.namedItem("id")?.value || "new"}`;
    const read = (form) => {
      try { return JSON.parse(storage.getItem(key(form)) || "null"); }
      catch { return null; }
    };
    const clear = (form) => {
      try { storage.removeItem(key(form)); } catch { /* No stored draft to clear. */ }
    };
    // Removes every household's drafts, because they hold unsynced care notes in plain text.
    const clearAll = () => {
      try {
        storage.keys().filter((name) => name.startsWith("sawyer-draft:")).forEach((name) => storage.removeItem(name));
      } catch { /* Storage is unavailable, so no drafts were kept. */ }
    };
    function notice(form, text) {
      let note = form.querySelector(".draft-status");
      if (!note) {
        note = document.createElement("div");
        note.className = "draft-status";
        note.setAttribute("role", "status");
        const label = document.createElement("span");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn ghost small";
        button.textContent = "Discard draft";
        button.onclick = () => {
          if (!confirm("Discard the unsaved changes in this form?")) return;
          clear(form);
          onDiscard();
        };
        note.append(label, button);
        form.append(note);
      }
      note.firstElementChild.textContent = text;
    }
    function save(form) {
      const fields = Array.from(form.elements)
        .filter((element) => element.name && !["file", "password", "submit", "button"].includes(element.type))
        .map((element) => ({ name: element.name, value: element.value, checked: element.checked, type: element.type }));
      try {
        storage.setItem(key(form), JSON.stringify({ fields, openDetails: Array.from(form.querySelectorAll("details")).map((detail) => detail.open), savedAt: Date.now() }));
        notice(form, "Draft saved on this device");
      } catch {
        notice(form, "Draft is only on this screen — device storage is unavailable");
        onError?.();
      }
    }
    function bind(container, baseFor) {
      container.querySelectorAll("form").forEach((form) => {
        if (!formIds.has(form.getAttribute("id"))) return;
        const base = document.createElement("input");
        base.type = "hidden";
        base.name = "_baseUpdatedAt";
        base.value = baseFor(form) || "";
        form.append(base);
        if (form.elements.namedItem("id")) {
          const entryId = document.createElement("input");
          entryId.type = "hidden";
          entryId.name = "_entryId";
          entryId.value = form.elements.namedItem("id").value || crypto.randomUUID();
          form.append(entryId);
        }
        const draft = read(form);
        if (Array.isArray(draft?.fields)) {
          for (const field of draft.fields) {
            const controls = Array.from(form.elements).filter((element) => element.name === field.name);
            for (const control of controls) {
              if (control.type === "file" || control.type === "password") continue;
              if (["checkbox", "radio"].includes(control.type)) {
                if (control.value === field.value) control.checked = Boolean(field.checked);
              } else control.value = field.value;
            }
          }
          form.querySelectorAll("details").forEach((detail, index) => { detail.open = Boolean(draft.openDetails?.[index]); });
          if (form.closest("details")) form.closest("details").open = true;
          notice(form, "Draft restored from this device");
        }
        form.addEventListener("input", () => save(form));
        form.addEventListener("change", () => save(form));
      });
    }
    return { bind, clear, clearAll };
  }

  root.SawyerTrackerDrafts = { create };
})(globalThis);
