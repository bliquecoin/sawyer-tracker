const fs = require("fs");
const { test, expect } = require("@playwright/test");

const HOUSEHOLD_ID = "test-household";
const ACCESS_STORAGE_KEY = "sawyer-household-access-key-hash";

function fakeSupabaseConfig({
  failEventWrites = false,
  seedSeizureDaysAgo = null,
  seedSeizureDaysAgoList = null,
  seedSeizureHoursAgo = null,
  seedSchedules = []
} = {}) {
  return `
    (() => {
      const householdId = ${JSON.stringify(HOUSEHOLD_ID)};
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const seedSeizureDaysAgo = ${JSON.stringify(seedSeizureDaysAgo)};
      const seedSeizureDaysAgoList = ${JSON.stringify(seedSeizureDaysAgoList)};
      const seedSeizureHoursAgo = ${JSON.stringify(seedSeizureHoursAgo)};
      const seededSeizureAt = Number.isFinite(seedSeizureHoursAgo)
        ? new Date(nowMs - seedSeizureHoursAgo * 60 * 60 * 1000).toISOString()
        : Number.isFinite(seedSeizureDaysAgo)
          ? new Date(nowMs - seedSeizureDaysAgo * 24 * 60 * 60 * 1000).toISOString()
          : null;
      const seededSeizuresAt = Array.isArray(seedSeizureDaysAgoList)
        ? seedSeizureDaysAgoList.map((daysAgo) => new Date(nowMs - daysAgo * 24 * 60 * 60 * 1000).toISOString())
        : seededSeizureAt
          ? [seededSeizureAt]
          : [];
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
        sawyer_care_schedules: ${JSON.stringify(seedSchedules)}.map((schedule) => ({
          household_id: householdId,
          id: schedule.id,
          dog_id: "sawyer",
          payload: {
            kind: "medication",
            dose: "",
            unit: "",
            effectiveFrom: "",
            active: true,
            createdAt: now,
            updatedAt: now,
            syncStatus: "synced",
            ...schedule
          },
          updated_at: now,
          deleted_at: null
        })),
        sawyer_care_events: seededSeizuresAt.map((occurredAt, index) => ({
          household_id: householdId,
          dog_id: "sawyer",
          id: \`seeded-seizure-\${index}\`,
          event_id: \`seeded-seizure-\${index}\`,
          type: "seizure",
          occurred_at: occurredAt,
          payload: {
            id: \`seeded-seizure-\${index}\`,
            type: "seizure",
            occurredAt,
            severity: 2,
            durationSeconds: 45,
            timeKnown: true,
            createdAt: now,
            updatedAt: now,
            syncStatus: "synced"
          },
          updated_at: now,
          deleted_at: null
        })),
        sawyer_vet_documents: []
      };

      const clone = (value) => JSON.parse(JSON.stringify(value));
      const valueFor = (row, column) => column === "payload->>doseKey" ? row.payload?.doseKey : row[column];

      function queryFor(table) {
        const state = {
          filters: [],
          orders: [],
          max: null,
          upserted: null,
          inserted: null,
          updated: null,
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

          if ((state.upserted || state.inserted || state.updated) && table === "sawyer_care_events" && ${JSON.stringify(failEventWrites)} && !window.__SAWYER_ALLOW_WRITES__) {
            return { data: null, error: { message: "Simulated Supabase write failure" } };
          }

          if (state.inserted) {
            const list = stores[table] || (stores[table] = []);
            if (list.some((row) => row.id === state.inserted.id && row.household_id === state.inserted.household_id)) {
              return { data: null, error: { code: "23505", message: "Duplicate record" } };
            }
            list.push(clone(state.inserted));
            rows = [clone(state.inserted)];
          }
          if (state.updated) {
            const ids = new Set(rows.map((row) => row.id));
            stores[table] = (stores[table] || []).map((row) => ids.has(row.id) ? clone(state.updated) : row);
            rows = rows.map(() => clone(state.updated));
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
          insert(row) { state.inserted = clone(row); return query; },
          update(row) { state.updated = clone(row); return query; },
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

  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute("href", "./styles.css?v=82");
  await expect(page.locator(".trend-chart")).toBeVisible();
  await expect(page.locator(".pixel-trend")).toBeVisible();
  await expect(page.locator(".pixel-calendar")).toBeVisible();
  await expect(page.locator(".milestone-card")).toBeVisible();
  await expect(page.locator(".seizure-free-card .streak-progress")).toBeVisible();
  const homeStatCards = page.locator('[data-view="today"] .stat-glass-grid > .stat-card');
  await expect(homeStatCards).toHaveCount(3);
  await expect(homeStatCards.nth(1)).toContainText("Longest streak");
  await expect(homeStatCards.nth(1).locator("small")).toHaveText("between episodes");
  await expect(homeStatCards.nth(2)).toContainText("Average gap");
  await expect(homeStatCards.nth(2).locator("small")).toHaveText("between episodes");
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
    if (tab === "backup") {
      await expect(page.getByRole("heading", { name: "Seizure-free push alerts" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Send Test" })).toBeDisabled();
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
      backdropFilter: style.backdropFilter
    };
  });
  await page.waitForTimeout(750);
  const settledAppearance = await streakCard.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      backdropFilter: style.backdropFilter
    };
  });
  expect(initialAppearance.backgroundColor).toBe("rgb(229, 244, 233)");
  expect(initialAppearance.backdropFilter).toBe("none");
  expect(settledAppearance).toEqual(initialAppearance);
  expect(pageErrors).toEqual([]);
});

test("longest streak and gap displays include a current streak that has passed the completed record", async ({ page }) => {
  const pageErrors = await openTracker(page, { seedSeizureDaysAgoList: [30, 20, 12] });

  const longestStreakCard = page.locator('[data-view="today"] .stat-glass-grid > .stat-card').nth(1);
  await expect(longestStreakCard.locator("strong")).toHaveText("12 days");
  await expect(longestStreakCard.locator("small")).toHaveText("current streak");

  await page.getByRole("button", { name: /Stats/i }).last().click();
  const longestGapMetric = page.locator(".stats-metrics .metric").filter({ hasText: "Longest gap" });
  await expect(longestGapMetric.locator("strong")).toHaveText("12 days");
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

test("a failed cloud write is durable and visibly pending", async ({ page }) => {
  const pageErrors = await openTracker(page, { failEventWrites: true });
  await page.getByRole("button", { name: /Log/i }).last().click();
  const noteDetails = page.locator("details.record-disclosure").filter({ hasText: "Care note" });
  await noteDetails.locator("summary").click();
  await page.locator("#note-title").fill("Keep this record");
  await page.locator("#note-body").fill("This write is expected to fail.");
  await page.getByRole("button", { name: "Save Note" }).click();

  await expect(page.locator("#toast")).toContainText("Saved on this device. Waiting to sync.");
  await expect(page.locator(".sync-banner")).toContainText("Waiting to sync");
  const remoteEvents = await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events);
  expect(remoteEvents).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("drafts survive navigation, foreground refresh and reload without truncating duration", async ({ page }) => {
  const errors = await openTracker(page);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await page.locator("#duration-minutes").fill("12");
  await page.locator("#duration-seconds").fill("35");
  await page.locator('[data-severity="4"]').click();
  await page.locator(".log-details summary").click();
  await page.locator("#notes").fill("Interrupted entry survives");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.locator("#notes")).toHaveValue("Interrupted entry survives");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#duration-minutes")).toHaveValue("12");
  await page.reload();
  await expect(page.locator("#duration-minutes")).toHaveValue("12");
  await expect(page.locator("#duration-seconds")).toHaveValue("35");
  await expect(page.locator('[data-severity="4"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#notes")).toHaveValue("Interrupted entry survives");
  await page.getByRole("button", { name: "Save seizure", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Seizure saved");
  expect(await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events[0].payload.durationSeconds)).toBe(755);
  await page.getByRole("button", { name: "History", exact: true }).click();
  const seizure = page.locator("details.timeline-item.seizure").first();
  await seizure.locator("summary").click();
  await seizure.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#duration-minutes")).toHaveValue("12");
  await page.getByRole("button", { name: "Update seizure", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Seizure updated");
  expect(await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events[0].payload.durationSeconds)).toBe(755);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.locator("#duration-minutes")).toHaveValue("0");
  await expect(page.locator("#notes")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("offline records survive reload and sync exactly once after reconnection", async ({ page, context }) => {
  const errors = await openTracker(page);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await context.setOffline(true);
  await page.locator("#duration-minutes").fill("5");
  await page.getByRole("button", { name: "Save seizure", exact: true }).click();
  await expect(page.locator(".sync-banner")).toContainText("Waiting to sync");
  expect(await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events.length)).toBe(0);
  // Restore the transport for reload; fail cloud writes to prove the local queue survives it.
  await page.route("**/config.js*", (route) => route.fulfill({ contentType: "application/javascript", body: fakeSupabaseConfig({ failEventWrites: true }) }));
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator(".sync-banner")).toContainText("Waiting to sync");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.locator("details.timeline-item.seizure")).toHaveCount(1);
  await page.evaluate(() => { window.__SAWYER_ALLOW_WRITES__ = true; window.dispatchEvent(new Event("online")); });
  await expect(page.locator(".sync-banner")).toHaveCount(0);
  expect(await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events.length)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("details.timeline-item.seizure")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("dose confirmation records the carer and timestamp and prevents rapid duplicate taps", async ({ page }) => {
  const errors = await openTracker(page);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await page.locator("#carer-name").fill("Beau");
  const firstDose = page.locator(".medication-row").first();
  await firstDose.getByRole("button", { name: "Given", exact: true }).evaluate((button) => { button.click(); button.click(); });
  await expect(firstDose).toContainText("Beau");
  await expect(firstDose.getByRole("button", { name: "Undo given", exact: true })).toBeVisible();
  const doses = await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events.filter((row) => row.payload.type === "dose"));
  expect(doses).toHaveLength(1);
  expect(doses[0].payload.recordedBy).toBe("Beau");
  expect(Number.isFinite(Date.parse(doses[0].payload.occurredAt))).toBe(true);
  await firstDose.getByRole("button", { name: "Undo given", exact: true }).click();
  await expect(firstDose.getByRole("button", { name: "Given", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByLabel("Require confirmation for each dose").check();
  await page.getByRole("button", { name: "Save Setup", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Setup saved");
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(firstDose).toContainText("Unconfirmed");
  expect(errors).toEqual([]);
});

test("conflicting edits preserve both versions and can be reviewed explicitly", async ({ page }) => {
  const errors = await openTracker(page);
  await page.getByRole("button", { name: "Log", exact: true }).click();
  const note = page.locator("details.record-disclosure").filter({ hasText: "Care note" });
  await note.locator("summary").click();
  await page.locator("#note-title").fill("Shared note");
  await page.locator("#note-body").fill("Original");
  await page.getByRole("button", { name: "Save Note", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Note saved");
  await page.getByRole("button", { name: "History", exact: true }).click();
  const entry = page.locator("details.timeline-item.note").first();
  await entry.locator("summary").click();
  await entry.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("#note-body").fill("My unfinished edit");
  await page.evaluate(() => {
    const row = window.__SAWYER_TEST_STORES__.sawyer_care_events[0];
    row.payload.body = "Edit from the other phone";
    row.updated_at = new Date(Date.now() + 5000).toISOString();
    row.payload.updatedAt = row.updated_at;
  });
  await page.getByRole("button", { name: "Update Note", exact: true }).click();
  await expect(page.locator(".sync-banner")).toContainText("need review");
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.locator(".conflict-versions")).toContainText("My unfinished edit");
  await expect(page.locator(".conflict-versions")).toContainText("Edit from the other phone");
  await page.getByRole("button", { name: "Keep this device's version", exact: true }).click();
  await expect(page.locator(".sync-banner")).toHaveCount(0);
  expect(await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events[0].payload.body)).toBe("My unfinished edit");
  expect(errors).toEqual([]);
});

test("shared schedule ids are escaped in Care Setup and still save", async ({ page }) => {
  const scheduleId = 'med-shared"><img id="injected-schedule" src="x">';
  const timeId = 'am"><b id="injected-time">x</b>';
  const errors = await openTracker(page, {
    seedSchedules: [{ id: scheduleId, name: "Shared schedule", times: [{ id: timeId, label: "Morning", time: "07:00" }] }]
  });
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /More/ }).click();
  const schedule = page.locator("div.panel").filter({ has: page.getByRole("heading", { name: "Shared schedule" }) });
  await expect(schedule).toBeVisible();
  await expect(page.locator("#injected-schedule, #injected-time")).toHaveCount(0);
  expect(await page.evaluate(({ scheduleId, timeId }) => [
    document.getElementById(`${scheduleId}-dose`)?.name,
    document.getElementById(`${scheduleId}-${timeId}-time`)?.name
  ], { scheduleId, timeId })).toEqual([`${scheduleId}:dose`, `${scheduleId}:${timeId}:time`]);
  await schedule.getByLabel("Dose").fill("250");
  await page.getByRole("button", { name: "Save Setup", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Setup saved");
  await expect.poll(() => page.evaluate((id) =>
    window.__SAWYER_TEST_STORES__.sawyer_care_schedules.find((row) => row.id === id)?.payload.dose, scheduleId)).toBe("250");
  expect(errors).toEqual([]);
});

test("CSV export neutralises spreadsheet formulas in recorded text", async ({ page }) => {
  const errors = await openTracker(page, { seedSeizureDaysAgo: 3 });
  await page.getByRole("button", { name: "Log", exact: true }).click();
  const note = page.locator("details.record-disclosure").filter({ hasText: "Care note" });
  await note.locator("summary").click();
  await page.locator("#note-title").fill('=HYPERLINK("https://example.com")');
  await page.locator("#note-body").fill("-2+3 then @SUM(A1)");
  await page.getByRole("button", { name: "Save Note", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Note saved");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /More/ }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const csv = fs.readFileSync(await (await download).path(), "utf8");
  expect(csv).toContain('"\'=HYPERLINK(""https://example.com"")"');
  expect(csv).toContain('"\'-2+3 then @SUM(A1)"');
  expect(csv).toContain('"45"');
  expect(errors).toEqual([]);
});

test("forgetting household access removes this device's records and drafts", async ({ page }) => {
  const errors = await openTracker(page, { seedSeizureDaysAgo: 3 });
  const localCopy = () => page.evaluate(async (accessKey) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("sawyer-care-tracker");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const events = await new Promise((resolve) => {
      const request = db.transaction("events").objectStore("events").count();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return {
      events,
      drafts: Object.keys(localStorage).filter((key) => key.startsWith("sawyer-draft:")).length,
      access: localStorage.getItem(accessKey)
    };
  }, ACCESS_STORAGE_KEY);

  await page.getByRole("button", { name: "Log", exact: true }).click();
  await page.locator(".log-details summary").click();
  await page.locator("#notes").fill("Unfinished private note");
  await expect.poll(localCopy).toEqual({ events: 1, drafts: 1, access: "verified-test-hash" });
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: /More/ }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Forget Access", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Household access removed");
  expect(await localCopy()).toEqual({ events: 0, drafts: 0, access: null });
  expect(await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events.length)).toBe(1);
  expect(errors).toEqual([]);
});

test.describe("offline app shell", () => {
  test.use({ serviceWorkers: "allow" });
  test("an installed shell reopens without a network connection", async ({ page, context, browserName }) => {
    test.skip(browserName === "webkit", "Playwright's WebKit offline emulation does not cover service workers; verify installation on a physical iPhone.");
    await openTracker(page);
    await page.evaluate(async (config) => {
      await navigator.serviceWorker.ready;
      const cache = await caches.open("sawyer-tracker-shell-82");
      await cache.put(new URL("./config.js", location.href), new Response(config, { headers: { "Content-Type": "application/javascript" } }));
    }, fakeSupabaseConfig());
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.locator(".sync-banner")).toContainText("Offline");
    await page.getByRole("button", { name: "Log", exact: true }).click();
    await page.getByRole("button", { name: "Save seizure", exact: true }).click();
    await expect(page.locator(".sync-banner")).toContainText("Waiting to sync");
    await page.reload();
    await expect(page.locator(".sync-banner")).toContainText("Waiting to sync");
  });
});
