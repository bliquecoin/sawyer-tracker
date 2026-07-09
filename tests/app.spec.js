const { test, expect } = require("@playwright/test");

const HOUSEHOLD_ID = "test-household";
const ACCESS_STORAGE_KEY = "sawyer-household-access-key-hash";

function fakeSupabaseConfig({ failEventWrites = false } = {}) {
  return `
    (() => {
      const householdId = ${JSON.stringify(HOUSEHOLD_ID)};
      const now = new Date().toISOString();
      const stores = {
        sawyer_households: [{ id: householdId }],
        sawyer_dogs: [{
          household_id: householdId,
          id: "sawyer",
          dog_id: "sawyer",
          payload: {
            id: "sawyer",
            name: "Sawyer",
            breed: "",
            birthDate: "",
            notes: "",
            createdAt: now,
            updatedAt: now,
            syncStatus: "synced"
          },
          updated_at: now,
          deleted_at: null
        }],
        sawyer_schedules: [],
        sawyer_care_events: [],
        sawyer_vet_documents: []
      };

      const clone = (value) => JSON.parse(JSON.stringify(value));
      const valueFor = (row, column) => row[column];

      function queryFor(table) {
        const state = {
          filters: [],
          orders: [],
          max: null,
          upserted: null,
          selected: "*"
        };

        const execute = (range) => {
          let rows = clone(stores[table] || []);
          state.filters.forEach(({ type, column, value }) => {
            rows = rows.filter((row) => type === "is"
              ? valueFor(row, column) === value
              : String(valueFor(row, column)) === String(value));
          });
          state.orders.slice().reverse().forEach(({ column, ascending }) => {
            rows.sort((a, b) => {
              const left = String(valueFor(a, column) || "");
              const right = String(valueFor(b, column) || "");
              return left.localeCompare(right) * (ascending === false ? -1 : 1);
            });
          });
          if (state.max !== null) rows = rows.slice(0, state.max);
          if (range) rows = rows.slice(range.from, range.to + 1);

          if (state.upserted && table === "sawyer_care_events" && ${JSON.stringify(failEventWrites)}) {
            return { data: null, error: { message: "Simulated Supabase write failure" } };
          }

          if (state.upserted) {
            const list = stores[table] || (stores[table] = []);
            state.upserted.forEach((row) => {
              const index = list.findIndex((item) =>
                item.id === row.id &&
                String(item.household_id || "") === String(row.household_id || "")
              );
              if (index >= 0) list[index] = clone(row);
              else list.push(clone(row));
            });
            rows = clone(state.upserted);
          }

          return { data: rows, error: null };
        };

        const query = {
          select(columns) {
            state.selected = columns || "*";
            return query;
          },
          eq(column, value) {
            state.filters.push({ type: "eq", column, value });
            return query;
          },
          is(column, value) {
            state.filters.push({ type: "is", column, value });
            return query;
          },
          order(column, options = {}) {
            state.orders.push({ column, ascending: options.ascending !== false });
            return query;
          },
          limit(value) {
            state.max = value;
            return query;
          },
          range(from, to) {
            return Promise.resolve(execute({ from, to }));
          },
          upsert(rows) {
            state.upserted = clone(Array.isArray(rows) ? rows : [rows]);
            return query;
          },
          then(resolve, reject) {
            return Promise.resolve(execute()).then(resolve, reject);
          }
        };
        return query;
      }

      const client = {
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signOut: async () => ({ error: null })
        },
        from: queryFor,
        functions: {
          invoke: async () => ({ data: {}, error: null })
        },
        storage: {
          from: () => ({
            download: async () => ({ data: new Blob(), error: null }),
            remove: async () => ({ data: [], error: null })
          })
        }
      };

      window.__SAWYER_TEST_STORES__ = stores;
      window.SAWYER_SUPABASE_CONFIG = {
        supabaseUrl: "https://example.supabase.co",
        supabaseAnonKey: "test-anon-key",
        supabaseHouseholdId: householdId,
        appUrl: location.origin + "/",
        clientFactory: () => client
      };
    })();
  `;
}

async function openTracker(page, options = {}) {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, "verified-test-hash");
  }, { key: ACCESS_STORAGE_KEY });
  await page.route("**/config.js*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: fakeSupabaseConfig(options)
    })
  );
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Here's Sawyer's day/i })).toBeVisible();
  return pageErrors;
}

test("household login, navigation, records, and mobile layout work together", async ({ page }) => {
  const pageErrors = await openTracker(page);

  await expect(page.locator(".trend-chart")).toBeVisible();
  await expect(page.locator(".day-browser")).toHaveCount(0);
  await expect(page.locator(".monthly-outlook-card")).toHaveCount(0);
  await expect(page.locator(".home-month-chart")).toBeVisible();
  const homeRangeButtons = page.locator("[data-home-trend-range]");
  await expect(homeRangeButtons).toHaveCount(3);
  await expect(page.locator('[data-home-trend-range="6"]')).toHaveAttribute("aria-pressed", "true");
  const homeMonthButtons = page.locator("[data-home-stats-month]");
  await expect(homeMonthButtons).toHaveCount(6);
  await page.locator('[data-home-trend-range="12"]').click();
  await expect(page.locator('[data-home-trend-range="12"]')).toHaveAttribute("aria-pressed", "true");
  await expect(homeMonthButtons).toHaveCount(12);
  const firstHomeMonth = await homeMonthButtons.first().getAttribute("data-home-stats-month");
  await homeMonthButtons.first().click();
  await expect(page.locator('[data-view="today"]')).toHaveClass(/active/);
  await expect(page.locator(`[data-home-stats-month="${firstHomeMonth}"]`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".trend-card [data-stats-month-detail]")).toBeVisible();

  const tabs = [
    ["Today", "today"],
    ["Log", "log"],
    ["History", "timeline"],
    ["Stats", "insights"],
    ["More", "backup"]
  ];
  for (const [label, tab] of tabs) {
    await page.getByRole("button", { name: new RegExp(label, "i") }).last().click();
    await expect(page.locator(`[data-view="${tab}"]`)).toHaveClass(/active/);
    const overflow = await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
      document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  }

  await page.getByRole("button", { name: /Stats/i }).last().click();
  const statsPanel = page.locator(".stats-month-panel");
  await expect(statsPanel).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tap a month" })).toBeVisible();
  await page.locator("[data-stats-range='12']").click();
  await expect(page.locator("[data-stats-range='12']")).toHaveAttribute("aria-pressed", "true");
  const monthRows = page.locator("[data-stats-month]");
  await expect(monthRows).toHaveCount(12);
  await monthRows.first().click();
  await expect(monthRows.first()).toHaveAttribute("aria-pressed", "true");
  const statsPanelHeight = await statsPanel.evaluate((element) => element.getBoundingClientRect().height);
  expect(statsPanelHeight).toBeLessThan(760);

  await page.getByRole("button", { name: /Log/i }).last().click();
  const noteDetails = page.locator("details.record-disclosure").filter({ hasText: "Care note" });
  await noteDetails.locator("summary").click();
  await page.locator("#note-title").fill("Playwright appetite");
  await page.locator("#note-body").fill("Sawyer ate dinner normally.");
  await page.getByRole("button", { name: "Save Note" }).click();
  await expect(page.locator("#toast")).toContainText("Note saved");

  await page.getByRole("button", { name: /History/i }).last().click();
  const noteItem = page.locator("details.timeline-item.note").filter({ hasText: "Playwright appetite" });
  await expect(noteItem).toHaveCount(1);
  await noteItem.locator("summary").click();
  await noteItem.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#note-title")).toHaveValue("Playwright appetite");
  await page.locator("#note-body").fill("Sawyer ate dinner and asked for more.");
  await page.getByRole("button", { name: "Update Note" }).click();
  await expect(page.locator("#toast")).toContainText("Note updated");

  await page.getByRole("button", { name: /History/i }).last().click();
  const updatedNote = page.locator("details.timeline-item.note").filter({ hasText: "Playwright appetite" });
  await updatedNote.locator("summary").click();
  await expect(updatedNote).toContainText("asked for more");
  page.once("dialog", (dialog) => dialog.accept());
  await updatedNote.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("#toast")).toContainText("Record deleted");
  await expect(page.locator("details.timeline-item.note").filter({ hasText: "Playwright appetite" })).toHaveCount(0);

  await page.getByRole("button", { name: /Log/i }).last().click();
  await page.getByRole("button", { name: "Save seizure" }).click();
  await expect(page.locator("#toast")).toContainText("Seizure saved");
  await page.getByRole("button", { name: /History/i }).last().click();
  const seizureItem = page.locator("details.timeline-item.seizure").first();
  await seizureItem.locator("summary").click();
  await seizureItem.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Update seizure" }).click();
  await expect(page.locator("#toast")).toContainText("Seizure updated");
  await page.getByRole("button", { name: /History/i }).last().click();
  const editedSeizure = page.locator("details.timeline-item.seizure").first();
  await editedSeizure.locator("summary").click();
  page.once("dialog", (dialog) => dialog.accept());
  await editedSeizure.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("#toast")).toContainText("Record deleted");
  await expect(page.locator("details.timeline-item.seizure")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("reset page waits for explicit confirmation", async ({ page }) => {
  await page.goto("/reset.html");
  await expect(page.getByRole("heading", { name: "Reset Sawyer Tracker" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset Safari Cache" })).toBeEnabled();
  await expect(page.locator("#status")).toHaveText("Ready.");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/reset\.html$/);
});

test("a failed cloud write remains unsaved and keeps the form available", async ({ page }) => {
  const pageErrors = await openTracker(page, { failEventWrites: true });
  await page.getByRole("button", { name: /Log/i }).last().click();
  const noteDetails = page.locator("details.record-disclosure").filter({ hasText: "Care note" });
  await noteDetails.locator("summary").click();
  await page.locator("#note-title").fill("Must not save");
  await page.locator("#note-body").fill("This write is expected to fail.");
  await page.getByRole("button", { name: "Save Note" }).click();

  await expect(page.locator("#toast")).toContainText("Not saved: Simulated Supabase write failure");
  await expect(page.locator("#note-title")).toHaveValue("Must not save");
  await expect(page.locator("#note-body")).toHaveValue("This write is expected to fail.");
  const remoteEvents = await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events);
  expect(remoteEvents).toEqual([]);
  expect(pageErrors).toEqual([]);
});
