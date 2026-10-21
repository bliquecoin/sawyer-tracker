const fs = require("fs");
const { test, expect } = require("@playwright/test");

const HOUSEHOLD_ID = "test-household";
const ACCESS_STORAGE_KEY = "sawyer-household-access-key-hash";

function fakeSupabaseConfig({
  failEventWrites = false,
  seedSeizureDaysAgo = null,
  seedSeizureDaysAgoList = null,
  seedSeizureHoursAgo = null,
  seedSchedules = [],
  failPushUnsubscribe = false,
  queryDelayMs = 0
} = {}) {
  return `
    (() => {
      const householdId = ${JSON.stringify(HOUSEHOLD_ID)};
      const queryDelayMs = ${JSON.stringify(queryDelayMs)};
      const answer = (result) => queryDelayMs
        ? new Promise((resolve) => setTimeout(() => resolve(result), queryDelayMs))
        : Promise.resolve(result);
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
            return answer(execute({ from, to }));
          },
          insert(row) { state.inserted = clone(row); return query; },
          update(row) { state.updated = clone(row); return query; },
          upsert(rows) {
            state.upserted = clone(Array.isArray(rows) ? rows : [rows]);
            return query;
          },
          then(resolve, reject) {
            return answer(execute()).then(resolve, reject);
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
          invoke: async (name, options = {}) => {
            window.__SAWYER_FUNCTION_CALLS__.push({ name, body: clone(options.body || {}), headers: clone(options.headers || {}) });
            if (name === "sawyer-push-subscriptions" && options.body?.action === "unsubscribe" && ${JSON.stringify(failPushUnsubscribe)}) {
              return { data: null, error: { message: "Simulated push failure" } };
            }
            return { data: {}, error: null };
          }
        },
        storage: {
          from: () => ({
            download: async () => ({ data: new Blob(), error: null }),
            remove: async () => ({ data: [], error: null })
          })
        }
      };

      window.__SAWYER_TEST_STORES__ = stores;
      window.__SAWYER_FUNCTION_CALLS__ = [];
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

// Service workers are blocked in these tests, so a fake registration stands in for an enabled push subscription.
async function fakePushSubscription(page) {
  await page.addInitScript(() => {
    window.__SAWYER_PUSH_UNSUBSCRIBED__ = false;
    const subscription = {
      endpoint: "https://push.example.invalid/device",
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "test-p256dh", auth: "test-auth" } }; },
      async unsubscribe() { window.__SAWYER_PUSH_UNSUBSCRIBED__ = true; return true; }
    };
    const registration = { pushManager: { getSubscription: async () => window.__SAWYER_PUSH_UNSUBSCRIBED__ ? null : subscription } };
    if (!("PushManager" in window)) window.PushManager = function PushManager() {};
    if (!("Notification" in window)) window.Notification = { permission: "default", requestPermission: async () => "default" };
    if ("serviceWorker" in navigator) navigator.serviceWorker.getRegistration = async () => registration;
    else Object.defineProperty(navigator, "serviceWorker", { value: { getRegistration: async () => registration } });
  });
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
  await expect(page.locator("#hero h1")).toBeVisible();
  return pageErrors;
}

const tab = (page, name) =>
  page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name, exact: true });
const openHousehold = (page) => page.getByRole("button", { name: "Household and settings" }).click();
const closeSheet = (page) => page.locator(".sheet .sheet-head [data-close-overlay]").click();
const heroBackground = (page) => page.locator("#hero").evaluate((element) => getComputedStyle(element).backgroundImage);

async function addNote(page, title, body) {
  await page.getByRole("button", { name: "New record" }).click();
  await page.locator(".menu-tile.note").click();
  await page.locator("#note-title").fill(title);
  await page.locator("#note-body").fill(body);
  await page.getByRole("button", { name: "Save Note" }).click();
}

test("household login, navigation, records, and mobile layout work together", async ({ page }) => {
  const pageErrors = await openTracker(page);

  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute("href", "./styles.css?v=92");
  const hero = page.locator("#hero");
  await expect(hero.locator(".hero-meta > div")).toHaveCount(3);
  await expect(hero.locator(".meta-longest")).toContainText("Longest streak");
  await expect(hero.locator(".meta-average small")).toHaveText("between episodes");
  await expect(page.locator(".routine-card")).toHaveCount(2);
  await expect(hero.getByRole("button", { name: "Record Seizure" })).toBeVisible();
  await expect(page.locator('[data-view="today"] .today-gaps h3')).toHaveText("Days Between Episodes");
  await expect(page.locator(".tabbar .nav-btn span")).toHaveText(["Today", "Patterns", "Records", "Vet"]);

  const tabs = [
    ["Today", "today"],
    ["Records", "timeline"],
    ["Patterns", "insights"],
    ["Vet", "vet"]
  ];
  for (const [label, view] of tabs) {
    await tab(page, label).click();
    await expect(page.locator(`[data-view="${view}"]`)).toHaveClass(/active/);
    await expect(tab(page, label)).toHaveAttribute("aria-current", "page");
    const overflow = await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
      document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  }

  await tab(page, "Patterns").click();
  await expect(page.locator(".stats-month-panel")).toBeVisible();
  await page.locator("[data-stats-range='12']").click();
  await expect(page.locator("[data-stats-range='12']")).toHaveAttribute("aria-pressed", "true");
  const monthBars = page.locator("[data-stats-month]");
  await expect(monthBars).toHaveCount(12);
  await monthBars.first().click();
  await expect(monthBars.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-stats-month-detail]")).toBeVisible();

  await openHousehold(page);
  await expect(page.getByRole("heading", { name: "Seizure-free push alerts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send Test" })).toBeDisabled();
  await closeSheet(page);
  await expect(page.locator(".sheet")).toHaveCount(0);

  await addNote(page, "Playwright appetite", "Sawyer ate dinner normally.");
  await expect(page.locator("#toast")).toContainText("Note saved");

  await tab(page, "Records").click();
  const noteItem = page.locator("details.timeline-item.note").filter({ hasText: "Playwright appetite" });
  await expect(noteItem).toHaveCount(1);
  await noteItem.locator("summary").click();
  await noteItem.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#note-title")).toHaveValue("Playwright appetite");
  await page.locator("#note-body").fill("Sawyer ate dinner and asked for more.");
  await page.getByRole("button", { name: "Update Note" }).click();
  await expect(page.locator("#toast")).toContainText("Note updated");

  const updatedNote = page.locator("details.timeline-item.note").filter({ hasText: "Playwright appetite" });
  await updatedNote.locator("summary").click();
  await expect(updatedNote).toContainText("asked for more");
  page.once("dialog", (dialog) => dialog.accept());
  await updatedNote.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("#toast")).toContainText("Record deleted");
  await expect(page.locator("details.timeline-item.note").filter({ hasText: "Playwright appetite" })).toHaveCount(0);

  await tab(page, "Today").click();
  await page.getByRole("button", { name: "Log Past Seizure" }).first().click();
  await page.getByRole("button", { name: "Save seizure" }).click();
  await expect(page.locator("#toast")).toContainText("Seizure saved");
  await tab(page, "Records").click();
  const seizureItem = page.locator("details.timeline-item.seizure").first();
  await seizureItem.locator("summary").click();
  await seizureItem.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Update seizure" }).click();
  await expect(page.locator("#toast")).toContainText("Seizure updated");
  await tab(page, "Records").click();
  const editedSeizure = page.locator("details.timeline-item.seizure").first();
  await editedSeizure.locator("summary").click();
  page.once("dialog", (dialog) => dialog.accept());
  await editedSeizure.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("#toast")).toContainText("Record deleted");
  await expect(page.locator("details.timeline-item.seizure")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("seizure-free streak earns hearts every five days on a steady blue field", async ({ page }) => {
  const pageErrors = await openTracker(page, { seedSeizureDaysAgo: 12 });

  const hero = page.locator("#hero");
  await expect(hero).toHaveClass(/calm-streak/);
  await expect(hero).toHaveClass(/glow-blue/);
  await expect(hero.locator(".streak-hearts")).toHaveAttribute("aria-label", /2 seizure-free hearts earned/);
  await expect(hero.locator(".heart.earned")).toHaveCount(2);
  await expect(hero.locator(".streak-progress")).toContainText("3 days to next heart");
  const initialBackground = await heroBackground(page);
  await page.waitForTimeout(750);
  expect(initialBackground).toContain("rgb(60, 116, 148)");
  expect(await heroBackground(page)).toBe(initialBackground);
  expect(pageErrors).toEqual([]);
});

test("longest streak and gap displays include a current streak that has passed the completed record", async ({ page }) => {
  const pageErrors = await openTracker(page, { seedSeizureDaysAgoList: [30, 20, 12] });

  await expect(page.locator("#hero .meta-longest dd")).toHaveText("12 days");
  await expect(page.locator("#hero .meta-longest small")).toHaveText("current streak");

  await tab(page, "Patterns").click();
  const longestGapMetric = page.locator(".stats-metrics .metric").filter({ hasText: "Longest gap" });
  await expect(longestGapMetric.locator("strong")).toHaveText("12 days");
  expect(pageErrors).toEqual([]);
});

test("a seizure within 24 hours turns the streak field berry", async ({ page }) => {
  const pageErrors = await openTracker(page, { seedSeizureHoursAgo: 23 });

  const hero = page.locator("#hero");
  await expect(hero).toHaveClass(/recent-seizure/);
  await expect(hero).toHaveClass(/glow-berry/);
  await expect(hero.locator(".hero-count")).toHaveText("0");
  expect(await heroBackground(page)).toContain("rgb(172, 28, 60)");
  expect(pageErrors).toEqual([]);
});

test("the streak field turns yellow after 24 hours and stays yellow through day four", async ({ page }) => {
  const pageErrors = await openTracker(page, { seedSeizureHoursAgo: 25 });

  const hero = page.locator("#hero");
  await expect(hero).toHaveClass(/building-streak/);
  await expect(hero).toHaveClass(/glow-yellow/);
  await expect(hero.locator(".hero-count")).toHaveText("1");
  expect(await heroBackground(page)).toContain("rgb(244, 180, 20)");
  expect(pageErrors).toEqual([]);
});

test("pulling down in the installed app shows a wordless spinner that spins while refreshing", async ({ page }) => {
  // iPhone only offers pull to refresh in the Home Screen app, so present the page as installed.
  await page.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
  const pageErrors = await openTracker(page);

  // WebKit cannot construct Touch objects, so send plain events carrying the finger position the handler reads.
  const pull = (distance, release = false) => page.evaluate(({ distance, release }) => {
    const content = document.querySelector(".content");
    const send = (type, touches) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "touches", { value: touches });
      content.dispatchEvent(event);
    };
    send("touchstart", [{ clientX: 180, clientY: 120 }]);
    send("touchmove", [{ clientX: 180, clientY: 120 + distance }]);
    if (release) send("touchend", []);
  }, { distance, release });
  const visiblePetals = () => page.locator("#pull-refresh line").evaluateAll((petals) =>
    petals.filter((petal) => getComputedStyle(petal).opacity === "1").length);

  const spinner = page.locator("#pull-refresh");
  await expect(page.locator(".sync-pill")).toHaveText("Synced");
  await expect(spinner).toHaveCSS("opacity", "0");
  // A sync landing mid-gesture redraws the page and resets the spinner until the finger moves again, so repeat the pull.
  await expect(async () => {
    await pull(100);
    await expect(spinner).toHaveClass(/visible/, { timeout: 250 });
    await expect(spinner).not.toHaveClass(/ready/, { timeout: 250 });
    expect(await visiblePetals()).toBe(5);
  }).toPass();
  await expect(async () => {
    await pull(200);
    await expect(spinner).toHaveClass(/ready/, { timeout: 250 });
    expect(await visiblePetals()).toBe(8);
  }).toPass();
  await expect(page.getByText(/to refresh/i)).toHaveCount(0);

  await pull(200, true);
  await expect(page.locator(".screen")).toHaveClass(/refreshing/);
  await expect(spinner).toHaveClass(/refreshing/);
  await expect(spinner).toHaveText("Refreshing");
  await expect(page.locator(".screen")).not.toHaveClass(/refreshing/);
  await expect(spinner).toHaveCSS("opacity", "0");
  await expect(spinner).toHaveText("");
  expect(pageErrors).toEqual([]);
});

test.describe("with motion on", () => {
  // This test measures animations, so it keeps them running even where the project reduces motion.
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test("reopening the app keeps the screen moving smoothly when the background sync lands", async ({ page }) => {
    const pageErrors = await openTracker(page, { seedSeizureDaysAgoList: [40, 25, 12], queryDelayMs: 300 });
    await expect(page.locator(".sync-pill")).toHaveText("Synced", { timeout: 15000 });

    // Reopen like a returning carer: the screen is drawn from this phone's copy while the sync runs.
    await page.reload();
    await expect(page.locator(".sync-pill")).toHaveText("Syncing");
    await page.locator("#app .screen").evaluate((screen) => {
      screen.dataset.firstDraw = "true";
      window.__firstDrawSeenAt = performance.now();
    });
    await expect(page.locator(".sync-pill")).toHaveText("Synced", { timeout: 15000 });
    await expect(page.locator("#app .screen[data-first-draw]")).toHaveCount(0);

    // The redraw picks up where the first draw was rather than replaying its entrance.
    const progress = (selector, name) => page.locator(selector).first().evaluate((element, name) => {
      const animation = element.getAnimations().find((item) => item.animationName === name);
      return {
        elapsed: animation.currentTime - animation.effect.getTiming().delay,
        sinceFirstDraw: performance.now() - window.__firstDrawSeenAt,
        state: animation.playState
      };
    }, name);
    const orbit = await progress("#hero .orbit g", "spin");
    expect(orbit.sinceFirstDraw).toBeGreaterThan(500);
    expect(orbit.elapsed).toBeGreaterThanOrEqual(orbit.sinceFirstDraw);
    expect((await progress('[data-view="today"] .chart .grow-x', "grow-x")).state).toBe("finished");
    expect(pageErrors).toEqual([]);
  });
});

test("Patterns shows the 30-day trend and severity, and blood levels show their target range", async ({ page }) => {
  const pageErrors = await openTracker(page, { seedSeizureDaysAgoList: [3, 10, 40, 41.2, 80, 120] });
  await tab(page, "Patterns").click();

  const trend = page.locator(".trend-card");
  await expect(trend.locator(".trend-now strong")).toContainText("2");
  await expect(trend.locator(".trend-now .tag")).toHaveText("Same as the 30 days before");
  await expect(trend.locator("svg .trend-line")).toHaveCount(1);
  // Reading another day moves the guide and the headline, then both settle back on today.
  await trend.locator("svg").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(trend.locator("[data-readout-label]")).toContainText("on ");
  await expect(trend.locator(".cross")).toHaveClass(/on/);
  await trend.locator("svg").blur();
  await expect(trend.locator("[data-readout-label]")).toHaveText("now");
  await expect(trend.locator("[data-readout-value]")).toHaveText("2");

  const severity = page.locator(".severity-card");
  await expect(severity.locator("svg .dot.sev-2")).toHaveCount(6);
  await expect(severity.locator(".trend-now .tag")).toHaveText("About the same");
  await expect(page.locator(".stats-month-panel .mb-fill.sev-2").first()).toBeVisible();

  // A chart label goes away with a tap anywhere else.
  await severity.locator(".hit").first().dispatchEvent("pointerover");
  await expect(page.locator("#chart-tip")).toHaveClass(/show/);
  await page.locator(".patterns h2").click();
  await expect(page.locator("#chart-tip")).not.toHaveClass(/show/);

  await page.locator("[data-deck-to='3']").click();
  await expect(page.locator("[data-deck-to='3']")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".highlights .ring-tile")).toContainText("4 days to go");
  await expect(page.locator(".highlights .episodes")).toContainText("0 of 6 episodes were clusters");

  await tab(page, "Vet").click();
  await page.getByRole("button", { name: "Add Blood Test" }).click();
  await page.locator("#blood-panel").fill("Phenobarbital level");
  await page.locator("#blood-phenobarbital-value").fill("50");
  await page.locator("#blood-phenobarbital-unit").fill("mg/L");
  await page.locator("#blood-phenobarbital-range").fill("15–45");
  await page.getByRole("button", { name: "Save Blood Test" }).click();
  const pheno = page.locator('[aria-label="Blood levels"] .blood').first();
  await expect(pheno.locator(".tag")).toHaveText("Above range");
  await expect(pheno.locator("svg .band")).toHaveCount(1);
  await expect(pheno.locator("svg .dot.off-target")).toHaveCount(1);
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
  await addNote(page, "Keep this record", "This write is expected to fail.");

  await expect(page.locator("#toast")).toContainText("Saved on this device. Waiting to sync.");
  await expect(page.locator(".sync-banner")).toContainText("Waiting to sync");
  const remoteEvents = await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events);
  expect(remoteEvents).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("drafts survive closing, foreground refresh and reload without truncating duration", async ({ page }) => {
  const errors = await openTracker(page);
  await page.getByRole("button", { name: "Log Past Seizure" }).first().click();
  await page.locator("#duration-minutes").fill("12");
  await page.locator("#duration-seconds").fill("35");
  await page.locator('[data-severity="4"]').click();
  await page.locator("#notes").fill("Interrupted entry survives");
  await page.locator(".fhead").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".seizure-focus")).toHaveCount(0);
  await page.getByRole("button", { name: "Log Past Seizure" }).first().click();
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
  await tab(page, "Records").click();
  const seizure = page.locator("details.timeline-item.seizure").first();
  await seizure.locator("summary").click();
  await seizure.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#duration-minutes")).toHaveValue("12");
  await page.getByRole("button", { name: "Update seizure", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Seizure updated");
  expect(await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events[0].payload.durationSeconds)).toBe(755);
  await page.getByRole("button", { name: "Log Past Seizure" }).first().click();
  await expect(page.locator("#duration-minutes")).toHaveValue("0");
  await expect(page.locator("#notes")).toHaveValue("");
  expect(errors).toEqual([]);
});

test("the seizure timer survives hiding and fills the review with its duration and symptoms", async ({ page }) => {
  const errors = await openTracker(page);
  await page.locator("#hero").getByRole("button", { name: "Record Seizure" }).click();
  await expect(page.locator(".timer-focus")).toBeVisible();
  await page.locator('[data-mark-symptom="Paddling"]').click();
  await page.waitForTimeout(2200);
  await page.getByRole("button", { name: "Hide the timer and keep recording" }).click();
  await expect(page.locator(".timer-pill")).toContainText("Recording 0:0");
  await page.reload();
  await expect(page.locator(".timer-focus")).toBeVisible();
  await expect(page.locator('[data-mark-symptom="Paddling"]')).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Seizure Ended" }).click();
  await expect(page.locator("#focus-title")).toHaveText("Seizure Timed");
  const seconds = Number(await page.locator("#duration-seconds").inputValue());
  expect(seconds).toBeGreaterThanOrEqual(2);
  await expect(page.locator("#seizure-time-known")).toBeChecked();
  await expect(page.locator('input[name="symptoms"][value="Paddling"]')).toBeChecked();
  await page.getByRole("button", { name: "Save seizure", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Seizure saved");
  const saved = await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events[0].payload);
  expect(saved.symptoms).toEqual(["Paddling"]);
  expect(saved.timeKnown).toBe(true);
  expect(saved.durationSeconds).toBeGreaterThanOrEqual(2);
  await expect(page.locator("#hero")).toHaveClass(/recent-seizure/);
  expect(await page.evaluate(() => localStorage.getItem("sawyer-seizure-timer"))).toBeNull();
  expect(errors).toEqual([]);
});

test("offline records survive reload and sync exactly once after reconnection", async ({ page, context }) => {
  const errors = await openTracker(page);
  await page.getByRole("button", { name: "Log Past Seizure" }).first().click();
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
  await tab(page, "Records").click();
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
  await page.locator(".routine-card.morning").click();
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
  await page.locator("[data-routine-switch='night']").click();
  await expect(page.locator(".routine-sheet")).toHaveClass(/tone-berry/);
  await expect(page.locator("#sheet-title")).toHaveText("Night Routine");
  await closeSheet(page);
  await openHousehold(page);
  await page.getByLabel("Require confirmation for each dose").check();
  await page.getByRole("button", { name: "Save Setup", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Setup saved");
  await closeSheet(page);
  await page.locator(".routine-card.morning").click();
  await expect(firstDose).toContainText("Unconfirmed");
  expect(errors).toEqual([]);
});

test("conflicting edits preserve both versions and can be reviewed explicitly", async ({ page }) => {
  const errors = await openTracker(page);
  await addNote(page, "Shared note", "Original");
  await expect(page.locator("#toast")).toContainText("Note saved");
  await tab(page, "Records").click();
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
  await page.getByRole("button", { name: "Review changes", exact: true }).first().click();
  await expect(page.locator(".conflict-versions")).toContainText("My unfinished edit");
  await expect(page.locator(".conflict-versions")).toContainText("Edit from the other phone");
  await page.getByRole("button", { name: "Keep this device's version", exact: true }).click();
  await expect(page.locator(".sync-banner")).toHaveCount(0);
  expect(await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events[0].payload.body)).toBe("My unfinished edit");
  expect(errors).toEqual([]);
});

test("a handover note is pinned at the top of Records for the next carer", async ({ page }) => {
  const errors = await openTracker(page);
  await expect(page.locator('[data-view="today"] .handover-card')).toHaveCount(0);
  await tab(page, "Records").click();
  await expect(page.locator('[data-view="timeline"] .records-head .handover-card')).toBeVisible();
  await page.locator("#handover-body").fill("Ate breakfast, a bit clingy after the walk.");
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Handover posted");
  await expect(page.locator(".handover-card blockquote")).toContainText("Ate breakfast");
  const saved = await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events[0].payload);
  expect(saved).toMatchObject({ type: "note", title: "Handover", handover: true });
  expect(errors).toEqual([]);
});

test("shared schedule ids are escaped in Care Setup and still save", async ({ page }) => {
  const scheduleId = 'med-shared"><img id="injected-schedule" src="x">';
  const timeId = 'am"><b id="injected-time">x</b>';
  const errors = await openTracker(page, {
    seedSchedules: [{ id: scheduleId, name: "Shared schedule", times: [{ id: timeId, label: "Morning", time: "07:00" }] }]
  });
  await openHousehold(page);
  const schedule = page.locator(".schedule-card").filter({ has: page.getByRole("heading", { name: "Shared schedule" }) });
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
  await addNote(page, '=HYPERLINK("https://example.com")', "-2+3 then @SUM(A1)");
  await expect(page.locator("#toast")).toContainText("Note saved");
  await openHousehold(page);
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

  await page.getByRole("button", { name: "Log Past Seizure" }).first().click();
  await page.locator("#notes").fill("Unfinished private note");
  await expect.poll(localCopy).toEqual({ events: 1, drafts: 1, access: "verified-test-hash" });
  await page.locator(".fhead").getByRole("button", { name: "Close" }).click();
  await openHousehold(page);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Forget Access", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Household access removed");
  expect(await localCopy()).toEqual({ events: 0, drafts: 0, access: null });
  expect(await page.evaluate(() => window.__SAWYER_TEST_STORES__.sawyer_care_events.length)).toBe(1);
  expect(await page.evaluate(() => window.__SAWYER_FUNCTION_CALLS__.map((call) => call.name))).not.toContain("sawyer-push-subscriptions");
  expect(errors).toEqual([]);
});

test("forgetting household access removes this device's push alerts before the access code", async ({ page }) => {
  await fakePushSubscription(page);
  const errors = await openTracker(page);
  await openHousehold(page);
  const dialogs = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); dialog.accept(); });
  await page.getByRole("button", { name: "Forget Access", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("Household access removed");
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain("push alerts on this device are turned off");
  const pushCalls = await page.evaluate(() => window.__SAWYER_FUNCTION_CALLS__.filter((call) => call.name === "sawyer-push-subscriptions"));
  expect(pushCalls).toHaveLength(1);
  expect(pushCalls[0].body).toMatchObject({ action: "unsubscribe", householdId: HOUSEHOLD_ID });
  expect(pushCalls[0].headers["x-sawyer-access-key"]).toBe("verified-test-hash");
  expect(await page.evaluate(() => window.__SAWYER_PUSH_UNSUBSCRIBED__)).toBe(true);
  expect(await page.evaluate((key) => localStorage.getItem(key), ACCESS_STORAGE_KEY)).toBeNull();
  expect(errors).toEqual([]);
});

test("when Supabase cannot remove push alerts, access is kept unless the carer continues", async ({ page }) => {
  await fakePushSubscription(page);
  const errors = await openTracker(page, { failPushUnsubscribe: true });
  await openHousehold(page);
  const forgetAccess = page.getByRole("button", { name: "Forget Access", exact: true });
  const dialogs = [];
  let continueAnyway = false;
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    if (dialog.message().startsWith("Supabase could not remove") && !continueAnyway) dialog.dismiss();
    else dialog.accept();
  });

  await forgetAccess.click();
  await expect.poll(() => dialogs.length).toBe(2);
  expect(dialogs[1]).toContain("Simulated push failure");
  expect(await page.evaluate(() => window.__SAWYER_PUSH_UNSUBSCRIBED__)).toBe(false);
  expect(await page.evaluate((key) => localStorage.getItem(key), ACCESS_STORAGE_KEY)).toBe("verified-test-hash");
  await expect(forgetAccess).toBeVisible();

  continueAnyway = true;
  await forgetAccess.click();
  await expect(page.locator("#toast")).toContainText("Household access removed");
  expect(await page.evaluate(() => window.__SAWYER_PUSH_UNSUBSCRIBED__)).toBe(true);
  expect(await page.evaluate((key) => localStorage.getItem(key), ACCESS_STORAGE_KEY)).toBeNull();
  expect(errors).toEqual([]);
});

test.describe("offline app shell", () => {
  test.use({ serviceWorkers: "allow" });
  test("an installed shell reopens without a network connection", async ({ page, context, browserName }) => {
    test.skip(browserName === "webkit", "Playwright's WebKit offline emulation does not cover service workers; verify installation on a physical iPhone.");
    await openTracker(page);
    await page.evaluate(async (config) => {
      await navigator.serviceWorker.ready;
      const cache = await caches.open("sawyer-tracker-shell-93");
      await cache.put(new URL("./config.js", location.href), new Response(config, { headers: { "Content-Type": "application/javascript" } }));
    }, fakeSupabaseConfig());
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.locator(".sync-banner")).toContainText("Offline");
    await page.getByRole("button", { name: "Log Past Seizure" }).first().click();
    await page.getByRole("button", { name: "Save seizure", exact: true }).click();
    await expect(page.locator(".sync-banner")).toContainText("Waiting to sync");
    await page.reload();
    await expect(page.locator(".sync-banner")).toContainText("Waiting to sync");
  });
});
