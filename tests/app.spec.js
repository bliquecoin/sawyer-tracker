const { test, expect } = require("@playwright/test");

const HOUSEHOLD_ID = "test-household";
const ACCESS_STORAGE_KEY = "sawyer-household-access-key-hash";

function fakeSupabaseConfig({ failEventWrites = false, seedSeizureDaysAgo = null, seedSeizureHoursAgo = null } = {}) {
  return `
    (() => {
      const householdId = ${JSON.stringify(HOUSEHOLD_ID)};
      const now = new Date().toISOString();
      const seedSeizureDaysAgo = ${JSON.stringify(seedSeizureDaysAgo)};
      const seedSeizureHoursAgo = ${JSON.stringify(seedSeizureHoursAgo)};
      const seededSeizureAt = Number.isFinite(seedSeizureHoursAgo)
        ? new Date(Date.now() - seedSeizureHoursAgo * 60 * 60 * 1000).toISOString()
        : Number.isFinite(seedSeizureDaysAgo)
          ? new Date(Date.now() - seedSeizureDaysAgo * 24 * 60 * 60 * 1000).toISOString()
          : null;
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
        sawyer_care_events: seededSeizureAt ? [{
          household_id: householdId,
          dog_id: "sawyer",
          id: "seeded-seizure",
          event_id: "seeded-seizure",
          type: "seizure",
          occurred_at: seededSeizureAt,
          payload: {
            id: "seeded-seizure",
            type: "seizure",
            occurredAt: seededSeizureAt,
            severity: 2,
            durationSeconds: 45,
            timeKnown: true,
            createdAt: now,
            updatedAt: now,
            syncStatus: "synced"
          },
          updated_at: now,
          deleted_at: null
        }] : [],
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

  await expect(page.locator('link[href="./assets/fonts/silkscreen.css?v=74"]')).toHaveCount(1);
  await expect(page.locator('link[href="./styles-r72.css?v=74"]')).toHaveCount(1);
  await expect(page.locator(".trend-chart")).toBeVisible();
  await expect(page.locator(".pixel-trend")).toBeVisible();
  await expect(page.locator(".pixel-calendar")).toBeVisible();
  await expect(page.locator(".milestone-card")).toBeVisible();
  await expect(page.locator(".seizure-free-card .streak-progress")).toBeVisible();
  const homeStatCards = page.locator('[data-view="today"] .stat-glass-grid > .stat-card');
  await expect(homeStatCards.nth(1)).toContainText("Longest streak");
  await expect(homeStatCards.nth(1)).toContainText("between episodes");
  await expect(homeStatCards.nth(2)).toContainText("Average gap");
  await expect(homeStatCards.nth(2)).toContainText("between episodes");
  await expect(page.locator('[data-view="today"] .medication-plan')).toHaveCount(0);
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
  const homeMonthScrollBeforeTap = await page.locator(".home-month-chart").evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return element.scrollLeft;
  });
  const lastHomeMonth = await homeMonthButtons.last().getAttribute("data-home-stats-month");
  await homeMonthButtons.last().click();
  await expect(page.locator(`[data-home-stats-month="${lastHomeMonth}"]`)).toHaveAttribute("aria-pressed", "true");
  const homeMonthScrollAfterTap = await page.locator(".home-month-chart").evaluate((element) => element.scrollLeft);
  expect(homeMonthScrollAfterTap).toBeGreaterThanOrEqual(homeMonthScrollBeforeTap - 2);
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
    if (tab === "log") {
      await expect(page.locator('[data-view="log"] .medication-plan')).toBeVisible();
      await expect(page.locator('[data-view="log"] .medication-plan')).toContainText("Today's medication");
    }
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

test("seizure-free streak earns animated pixel hearts every five days", async ({ page }) => {
  const pageErrors = await openTracker(page, { seedSeizureDaysAgo: 12 });

  const streakCard = page.locator(".seizure-free-card");
  const heartRail = page.locator(".seizure-free-card .streak-hearts");
  await expect(heartRail).toBeVisible();
  await expect(heartRail).toHaveAttribute("aria-label", /2 seizure-free hearts earned/);
  await expect(streakCard).toHaveClass(/calm-streak/);
  await expect(streakCard.locator(".seizure-free-header em")).toHaveCount(0);
  await expect(page.locator(".seizure-free-card .pixel-heart")).toHaveCount(2);
  await expect(page.locator(".seizure-free-card .streak-progress")).toContainText("days to next heart");
  const initialAppearance = await streakCard.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backdropFilter: style.backdropFilter,
      fontFamily: style.fontFamily,
      fitsContent: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
    };
  });
  await page.waitForTimeout(750);
  const settledAppearance = await streakCard.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backdropFilter: style.backdropFilter,
      fontFamily: style.fontFamily,
      fitsContent: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
    };
  });
  expect(initialAppearance.backgroundColor).toBe("rgb(241, 248, 243)");
  expect(initialAppearance.backdropFilter).toBe("none");
  expect(initialAppearance.fontFamily).toContain("Silkscreen");
  expect(initialAppearance.fitsContent).toBe(true);
  expect(settledAppearance).toEqual(initialAppearance);
  expect(pageErrors).toEqual([]);
});

test("a seizure within 24 hours keeps the counter red", async ({ page }) => {
  const pageErrors = await openTracker(page, { seedSeizureHoursAgo: 23 });

  const streakCard = page.locator(".seizure-free-card");
  await expect(streakCard).toHaveClass(/recent-seizure/);
  await expect(streakCard).toContainText("0");
  await expect(streakCard.locator(".seizure-free-header em")).toHaveCount(0);
  const appearance = await streakCard.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backdropFilter: style.backdropFilter
    };
  });
  expect(appearance.backgroundColor).toBe("rgb(255, 233, 237)");
  expect(appearance.backgroundImage).toContain("rgba(219, 66, 78, 0.28)");
  expect(appearance.backgroundImage).not.toContain("rgba(220, 245, 241, 0.68)");
  expect(appearance.backdropFilter).toBe("none");
  expect(pageErrors).toEqual([]);
});

test("the counter turns amber after 24 hours and stays amber through day four", async ({ page }) => {
  const pageErrors = await openTracker(page, { seedSeizureHoursAgo: 25 });

  const streakCard = page.locator(".seizure-free-card");
  await expect(streakCard).toHaveClass(/building-streak/);
  await expect(streakCard).toContainText("1");
  await expect(streakCard.locator(".seizure-free-header em")).toHaveCount(0);
  const appearance = await streakCard.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backdropFilter: style.backdropFilter
    };
  });
  expect(appearance.backgroundColor).toBe("rgb(255, 242, 207)");
  expect(appearance.backgroundImage).toContain("rgba(255, 179, 50, 0.34)");
  expect(appearance.backdropFilter).toBe("none");
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
