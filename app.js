(function () {
  "use strict";

  const DB_NAME = "sawyer-care-tracker";
  const DB_VERSION = 1;
  const DOG_ID = "sawyer";
  const REMINDER_WINDOW_MINUTES = 15;
  const OVERDUE_MINUTES = 45;
  const CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;
  const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
  const FALLBACK_APP_URL = "https://bliquecoin.github.io/sawyer-tracker/";
  const ACCESS_KEY_STORAGE = "sawyer-household-access-key-hash";
  const ACCESS_HEADER = "x-sawyer-access-key";
  const SUPABASE_TABLES = {
    dogs: "sawyer_dogs",
    schedules: "sawyer_care_schedules",
    events: "sawyer_care_events"
  };
  const app = document.querySelector("#app");
  const externalConfig = window.SAWYER_SUPABASE_CONFIG || {};

  const state = {
    activeTab: "today",
    timelineFilter: "all",
    profile: null,
    schedules: [],
    events: [],
    settings: null,
    timerStartedAt: null,
    timerTick: null,
    toastTimer: null,
    installPrompt: null,
    supabaseClient: null,
    supabaseSession: null,
    householdAccessHash: readHouseholdAccessHash(),
    syncBusy: false,
    syncMessage: "",
    syncTimer: null,
    storageUnavailable: false,
    aiBusy: false,
    aiInsight: null,
    aiError: "",
    selectedDayKey: localDateKey(new Date()),
    pullDistance: 0,
    pullRefreshing: false,
    editingSeizureId: "",
    severity: 3
  };
  const startedFromAuthRedirect = isAuthRedirectUrl();
  const memoryStores = {
    profile: new Map(),
    settings: new Map(),
    schedules: new Map(),
    events: new Map()
  };
  setRuntimeClasses();

  const DEFAULT_PROFILE = {
    id: DOG_ID,
    name: "Sawyer",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    syncStatus: "local"
  };

  const DEFAULT_SETTINGS = {
    id: "main",
    remindersEnabled: false,
    reminderLeadMinutes: 0,
    supabaseUrl: "",
    supabaseAnonKey: "",
    supabaseHouseholdId: "",
    syncEnabled: false,
    currentUserEmail: "",
    pendingLoginEmail: "",
    emergencyLocalMode: false,
    lastSyncAt: null,
    lastSyncMessage: "",
    lastBackupAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    syncStatus: "local"
  };

  const DEFAULT_SCHEDULES = [
    {
      id: "med-epibrom",
      dogId: DOG_ID,
      kind: "medication",
      name: "Epibrom",
      dose: "",
      unit: "",
      active: true,
      times: [
        { id: "morning", label: "Morning", time: "07:00" },
        { id: "night", label: "Night", time: "19:00" }
      ],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      syncStatus: "local"
    },
    {
      id: "med-phenomav",
      dogId: DOG_ID,
      kind: "medication",
      name: "Phenomav",
      dose: "",
      unit: "",
      active: true,
      times: [
        { id: "morning", label: "Morning", time: "07:00" },
        { id: "night", label: "Night", time: "19:00" }
      ],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      syncStatus: "local"
    },
    {
      id: "supp-mct-c8-c10",
      dogId: DOG_ID,
      kind: "supplement",
      name: "MCT oil C8/C10",
      dose: "",
      unit: "",
      active: true,
      times: [{ id: "daily", label: "Daily", time: "08:00" }],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      syncStatus: "local"
    }
  ];

  const SYMPTOMS = [
    "Trembling",
    "Paddling",
    "Drooling",
    "Loss of balance",
    "Urination",
    "Confusion",
    "Pacing",
    "Blindness"
  ];

  const TRIGGERS = [
    "Unknown",
    "Missed or late dose",
    "Stress",
    "Heat",
    "Exercise",
    "Food change",
    "Sleep disruption",
    "Loud noise"
  ];

  const TIMELINE_FILTERS = [
    { id: "all", label: "All" },
    { id: "seizure", label: "Seizures" },
    { id: "dose", label: "Doses" },
    { id: "note", label: "Notes" },
    { id: "vet_visit", label: "Vet" },
    { id: "blood_test", label: "Blood" }
  ];

  function setRuntimeClasses() {
    document.documentElement.classList.toggle("standalone-app", isStandaloneApp());
    document.documentElement.classList.toggle("ios-browser", isIosBrowser());
  }

  function isStandaloneApp() {
    return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
  }

  function isIosDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isIosBrowser() {
    return isIosDevice() && !isStandaloneApp();
  }

  init();

  async function init() {
    if (await resetStaleBrowserCache()) return;
    if (await retireServiceWorker()) return;
    requestPersistentStorage();
    attachGlobalListeners();
    await safeHydrate();
    await initSupabase();
    if (state.settings?.syncEnabled && isSignedIn() && navigator.onLine) {
      await syncWithSupabase({ silent: true });
    }
    render();
    startReminderLoop();
  }

  async function resetStaleBrowserCache() {
    const params = new URLSearchParams(window.location.search || "");
    if (!params.has("fresh") && !params.has("reset")) return false;

    await clearServiceWorkerState();

    params.delete("fresh");
    params.delete("reset");
    const url = new URL(window.location.href);
    url.search = params.toString();
    url.hash = "";
    window.location.replace(url.toString());
    return true;
  }

  async function retireServiceWorker() {
    if (sessionStorage.getItem("sawyerServiceWorkerRetired") === "done") return false;

    const hadServiceWorker = Boolean(navigator.serviceWorker?.controller);
    const cleared = await clearServiceWorkerState();
    if (!hadServiceWorker && !cleared) return false;

    sessionStorage.setItem("sawyerServiceWorkerRetired", "done");
    const url = new URL(window.location.href);
    url.hash = "";
    window.location.replace(url.toString());
    return true;
  }

  async function clearServiceWorkerState() {
    let cleared = false;
    try {
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        if (registrations.length) cleared = true;
        await Promise.all(registrations.map((registration) => registration.unregister()));
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        const trackerKeys = keys.filter((key) => key.startsWith("sawyer-tracker"));
        if (trackerKeys.length) cleared = true;
        await Promise.all(trackerKeys.map((key) => caches.delete(key)));
      }
    } catch (error) {
      // A failed cleanup should not leave the app unusable.
    }
    return cleared;
  }

  function requestPersistentStorage() {
    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }

  function attachGlobalListeners() {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.installPrompt = event;
      render();
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        refreshApp({ silent: true }).catch(() => safeHydrate().then(render).then(checkReminders));
      }
    });
  }

  async function safeHydrate() {
    try {
      await withTimeout(hydrate(), 3500, "Local storage took too long.");
    } catch (error) {
      useStorageFallback(error);
    }
  }

  function useStorageFallback(error) {
    state.storageUnavailable = true;
    state.profile = state.profile || clone(DEFAULT_PROFILE);
    state.settings = normalizeSettings(state.settings || DEFAULT_SETTINGS);
    state.schedules = state.schedules?.length ? state.schedules : DEFAULT_SCHEDULES.map(clone);
    state.events = state.events || [];
    state.syncMessage =
      "Safari storage is unavailable. The app is running in recovery mode; connect Supabase to load shared records.";
    seedMemoryStore("profile", [state.profile]);
    seedMemoryStore("settings", [state.settings]);
    seedMemoryStore("schedules", state.schedules);
    seedMemoryStore("events", state.events);
  }

  function seedMemoryStore(storeName, values) {
    const store = memoryStores[storeName];
    if (!store) return;
    values.forEach((value) => store.set(value.id, clone(value)));
  }

  function withTimeout(promise, ms, message) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
  }

  async function loadSupabaseLibrary() {
    if (window.supabase?.createClient) return true;

    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${SUPABASE_JS_URL}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(true), { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = SUPABASE_JS_URL;
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error("Supabase library could not be loaded."));
      document.head.appendChild(script);
    });
  }

  async function initSupabase() {
    if (!hasSupabaseConfig()) {
      state.supabaseClient = null;
      state.supabaseSession = null;
      return null;
    }

    try {
      await loadSupabaseLibrary();
      state.supabaseClient = window.supabase.createClient(
        state.settings.supabaseUrl,
        state.settings.supabaseAnonKey,
        {
          global: {
            headers: state.householdAccessHash ? { [ACCESS_HEADER]: state.householdAccessHash } : {}
          },
          auth: {
            autoRefreshToken: true,
            detectSessionInUrl: true,
            persistSession: true
          }
        }
      );

      if (startedFromAuthRedirect) {
        await handleAuthRedirect(state.supabaseClient);
      }

      const { data, error } = await state.supabaseClient.auth.getSession();
      if (error) throw error;
      state.supabaseSession = data.session;
      if (startedFromAuthRedirect && data.session?.user) {
        state.syncMessage = "Supabase connected on this version of Sawyer Tracker.";
      }
      if (startedFromAuthRedirect) {
        cleanAuthRedirectUrl();
      }

      const email = data.session?.user?.email || "";
      if (email && state.settings.currentUserEmail !== email) {
        await updateSettings({
          currentUserEmail: email,
          pendingLoginEmail: "",
          emergencyLocalMode: false
        });
      }

      if (!state.supabaseClient.__sawyerAuthBound) {
        state.supabaseClient.auth.onAuthStateChange(async (_event, session) => {
          state.supabaseSession = session;
          if (session?.user?.email) {
            cleanAuthRedirectUrl();
            await updateSettings({
              currentUserEmail: session.user.email,
              pendingLoginEmail: "",
              emergencyLocalMode: false,
              lastSyncMessage: "Supabase connected. Syncing shared records..."
            });
            if (state.settings?.syncEnabled && navigator.onLine) {
              await syncWithSupabase({ silent: true });
            }
          }
          render();
        });
        state.supabaseClient.__sawyerAuthBound = true;
      }

      return state.supabaseClient;
    } catch (error) {
      state.syncMessage = authErrorMessage(error) || "Supabase could not be initialized.";
      if (startedFromAuthRedirect) cleanAuthRedirectUrl();
      return null;
    }
  }

  async function requireSupabaseSession() {
    const client = state.supabaseClient || (await initSupabase());
    if (!client) throw new Error("Add Supabase settings first.");

    if (state.householdAccessHash) return client;

    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    state.supabaseSession = data.session;
    if (!data.session) throw new Error("Enter the household access code before syncing.");

    return client;
  }

  async function handleAuthRedirect(client) {
    const search = new URLSearchParams(window.location.search || "");
    const hashText = window.location.hash?.startsWith("#") ? window.location.hash.slice(1) : "";
    const hash = new URLSearchParams(hashText);
    const authError = search.get("error_description") || hash.get("error_description") || search.get("error") || hash.get("error");
    if (authError) throw new Error(authError);

    const code = search.get("code");
    if (code && client.auth.exchangeCodeForSession) {
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      if (error) throw error;
      state.supabaseSession = data.session;
      return;
    }

    const tokenHash = search.get("token_hash") || hash.get("token_hash");
    if (tokenHash) {
      const type = search.get("type") || hash.get("type") || "email";
      const { data, error } = await client.auth.verifyOtp({
        token_hash: tokenHash,
        type
      });
      if (error) throw error;
      state.supabaseSession = data.session;
    }
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        state.storageUnavailable = true;
        reject(new Error("IndexedDB is not available."));
        return;
      }

      const timeoutId = setTimeout(() => {
        state.storageUnavailable = true;
        reject(new Error("IndexedDB did not respond."));
      }, 2500);
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("profile")) {
          db.createObjectStore("profile", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("schedules")) {
          const schedules = db.createObjectStore("schedules", { keyPath: "id" });
          schedules.createIndex("dogId", "dogId");
          schedules.createIndex("kind", "kind");
        }
        if (!db.objectStoreNames.contains("events")) {
          const events = db.createObjectStore("events", { keyPath: "id" });
          events.createIndex("dogId", "dogId");
          events.createIndex("type", "type");
          events.createIndex("occurredAt", "occurredAt");
          events.createIndex("dayKey", "dayKey");
          events.createIndex("doseKey", "doseKey", { unique: false });
          events.createIndex("syncStatus", "syncStatus");
        }
      };

      request.onsuccess = () => {
        clearTimeout(timeoutId);
        resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timeoutId);
        state.storageUnavailable = true;
        reject(request.error);
      };
      request.onblocked = () => {
        clearTimeout(timeoutId);
        state.storageUnavailable = true;
        reject(new Error("IndexedDB is blocked by another Safari tab."));
      };
    });
  }

  async function dbGetAll(storeName) {
    if (state.storageUnavailable) return memoryGetAll(storeName);
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function dbGet(storeName, key) {
    if (state.storageUnavailable) return memoryGet(storeName, key);
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => db.close();
    });
  }

  async function dbPut(storeName, value) {
    if (state.storageUnavailable) return memoryPut(storeName, value);
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => {
        db.close();
        resolve(value);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbBulkPut(storeName, values) {
    if (state.storageUnavailable) return memoryBulkPut(storeName, values);
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      values.forEach((value) => store.put(value));
      tx.oncomplete = () => {
        db.close();
        resolve(values);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbDelete(storeName, key) {
    if (state.storageUnavailable) return memoryDelete(storeName, key);
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbClear(storeName) {
    if (state.storageUnavailable) return memoryClear(storeName);
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  function memoryGetAll(storeName) {
    return Array.from(memoryStores[storeName]?.values() || []).map(clone);
  }

  function memoryGet(storeName, key) {
    const value = memoryStores[storeName]?.get(key);
    return value ? clone(value) : null;
  }

  function memoryPut(storeName, value) {
    memoryStores[storeName]?.set(value.id, clone(value));
    return clone(value);
  }

  function memoryBulkPut(storeName, values) {
    values.forEach((value) => memoryPut(storeName, value));
    return values.map(clone);
  }

  function memoryDelete(storeName, key) {
    memoryStores[storeName]?.delete(key);
  }

  function memoryClear(storeName) {
    memoryStores[storeName]?.clear();
  }

  function normalizeSettings(settings) {
    const configUrl = externalConfig.supabaseUrl || externalConfig.url || "";
    const configAnonKey = externalConfig.supabaseAnonKey || externalConfig.anonKey || "";
    const configHouseholdId = externalConfig.supabaseHouseholdId || externalConfig.householdId || "";

    return {
      ...DEFAULT_SETTINGS,
      ...(settings || {}),
      supabaseUrl: settings?.supabaseUrl || configUrl,
      supabaseAnonKey: settings?.supabaseAnonKey || configAnonKey,
      supabaseHouseholdId: settings?.supabaseHouseholdId || configHouseholdId,
      syncEnabled: Boolean(
        settings?.syncEnabled ||
          ((settings?.supabaseUrl || configUrl) &&
            (settings?.supabaseAnonKey || configAnonKey) &&
            (settings?.supabaseHouseholdId || configHouseholdId))
      )
    };
  }

  function hasSupabaseConfig() {
    return Boolean(
      state.settings?.supabaseUrl &&
        state.settings?.supabaseAnonKey &&
        state.settings?.supabaseHouseholdId
    );
  }

  function readHouseholdAccessHash() {
    try {
      return localStorage.getItem(ACCESS_KEY_STORAGE) || "";
    } catch {
      return "";
    }
  }

  function writeHouseholdAccessHash(hash) {
    state.householdAccessHash = hash;
    state.supabaseClient = null;
    try {
      if (hash) {
        localStorage.setItem(ACCESS_KEY_STORAGE, hash);
      } else {
        localStorage.removeItem(ACCESS_KEY_STORAGE);
      }
    } catch {
      state.householdAccessHash = hash;
    }
  }

  async function sha256Hex(value) {
    if (!window.crypto?.subtle) throw new Error("This browser cannot save the household access code.");
    const bytes = new TextEncoder().encode(value);
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function canonicalAppUrl() {
    const configured = externalConfig.appUrl || externalConfig.siteUrl || "";
    if (configured) return configured.endsWith("/") ? configured : `${configured}/`;

    const url = new URL(window.location.href);
    url.hash = "";
    url.search = "";
    if (url.pathname.endsWith("/index.html")) {
      url.pathname = url.pathname.slice(0, -"index.html".length);
    }
    if (url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
      return FALLBACK_APP_URL;
    }
    return url.toString();
  }

  function isAuthRedirectUrl() {
    const search = new URLSearchParams(window.location.search || "");
    const hashText = window.location.hash?.startsWith("#") ? window.location.hash.slice(1) : "";
    const hash = new URLSearchParams(hashText);
    return Boolean(
      search.has("code") ||
        search.has("token_hash") ||
        search.has("type") ||
        hash.has("access_token") ||
        hash.has("refresh_token") ||
        hash.has("type")
    );
  }

  function cleanAuthRedirectUrl() {
    if (!isAuthRedirectUrl() || !window.history?.replaceState) return;
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    if (url.pathname.endsWith("/index.html")) {
      url.pathname = url.pathname.slice(0, -"index.html".length);
    }
    window.history.replaceState({}, document.title, url.toString());
  }

  function isSignedIn() {
    return Boolean(state.supabaseSession?.user || state.householdAccessHash);
  }

  function signedInEmail() {
    return state.supabaseSession?.user?.email || state.settings?.currentUserEmail || (state.householdAccessHash ? "Household access" : "");
  }

  function displayUserName() {
    if (state.householdAccessHash && !state.supabaseSession?.user?.email) {
      return `${state.profile?.name || "Sawyer"} team`;
    }
    const email = signedInEmail();
    if (!email) return `${state.profile?.name || "Sawyer"} team`;
    const localPart = email.split("@")[0] || "";
    const first = localPart.split(/[._-]/).filter(Boolean)[0] || localPart;
    return capitalize(first);
  }

  function authErrorMessage(error) {
    const message = String(error?.message || "").trim();
    const status = error?.status || error?.statusCode;
    if (/email rate limit|over_email_send_rate_limit/i.test(message)) {
      return "Supabase email limit hit. Use the household access code instead of email sign-in.";
    }
    if (status === 429 && /rate limit|security purposes/i.test(message)) {
      return "Supabase rate limit hit. Try again shortly.";
    }
    if (/code verifier|auth code|invalid.*code|both auth code/i.test(message)) {
      return "That old sign-in link opened in a different browser or expired. Use the household access code instead.";
    }
    return message || "Supabase could not connect.";
  }

  async function updateSettings(patch) {
    const updated = normalizeSettings({
      ...state.settings,
      ...patch,
      updatedAt: nowIso(),
      syncStatus: "local"
    });
    await dbPut("settings", updated);
    state.settings = updated;
    return updated;
  }

  async function hydrate() {
    let profile = await dbGet("profile", DOG_ID);
    let settings = await dbGet("settings", "main");
    let schedules = await dbGetAll("schedules");

    if (!profile) {
      profile = { ...DEFAULT_PROFILE };
      await dbPut("profile", profile);
    }

    if (!settings) {
      settings = { ...DEFAULT_SETTINGS };
      await dbPut("settings", settings);
    }

    const normalizedSettings = normalizeSettings(settings);
    if (JSON.stringify(normalizedSettings) !== JSON.stringify(settings)) {
      settings = normalizedSettings;
      await dbPut("settings", settings);
    }

    if (schedules.length === 0) {
      schedules = DEFAULT_SCHEDULES.map(clone);
      await dbBulkPut("schedules", schedules);
    }

    state.profile = profile;
    state.settings = settings;
    state.schedules = schedules.filter((schedule) => !schedule.deletedAt);
    state.events = (await dbGetAll("events")).filter((event) => !event.deletedAt);
  }

  function render() {
    const todayEntries = getTodayDoseEntries();
    const summary = getSummary();

    if (shouldShowLoginScreen()) {
      app.innerHTML = `
        <div class="screen login-screen">
          <main class="login-content">
            ${renderLoginScreen()}
          </main>
          <div id="toast" class="toast" role="status"></div>
        </div>
      `;
      bindUi();
      return;
    }

    app.innerHTML = `
      <div class="screen">
        <main class="content">
          <div id="pull-refresh" class="pull-refresh" aria-live="polite">Pull to refresh</div>
          ${renderEmergencySyncBanner()}
          <section class="view ${state.activeTab === "today" ? "active" : ""}" data-view="today">
            ${renderToday(summary, todayEntries)}
          </section>

          <section class="view ${state.activeTab === "log" ? "active" : ""}" data-view="log">
            ${renderLog()}
          </section>

          <section class="view ${state.activeTab === "timeline" ? "active" : ""}" data-view="timeline">
            ${renderTimeline()}
          </section>

          <section class="view ${state.activeTab === "insights" ? "active" : ""}" data-view="insights">
            ${renderInsights(summary)}
          </section>

          <section class="view ${state.activeTab === "backup" ? "active" : ""}" data-view="backup">
            ${renderBackup()}
          </section>
        </main>

        <nav class="bottom-nav" aria-label="Main navigation">
          ${navButton("today", "Today", "⌂")}
          ${navButton("log", "Log", "+")}
          ${navButton("timeline", "History", "≡")}
          ${navButton("insights", "Stats", "▥")}
          ${navButton("backup", "More", "○")}
        </nav>
        <div id="toast" class="toast" role="status"></div>
      </div>
    `;

    bindUi();
    updateTimerFace();
    centerSelectedDayPill();
  }

  function navButton(tab, label, icon) {
    return `
      <button class="nav-btn ${state.activeTab === tab ? "active" : ""}" data-tab="${tab}" type="button">
        <span aria-hidden="true">${icon}</span>${label}
      </button>
    `;
  }

  function renderToday(summary, entries) {
    const installClass = state.installPrompt ? "panel install-banner ready" : "panel install-banner";

    return `
      <div class="home-stack">
        <section class="home-hero glass-panel">
          <div class="home-topline">
            <div class="welcome-copy">
              <p class="eyebrow">${escapeHtml(formatWelcomeDate(new Date()))}</p>
              <h1>${escapeHtml(state.profile?.name || "Sawyer")}'s day</h1>
              <p class="subtle">${escapeHtml(homeGreeting(summary))}</p>
            </div>
          </div>

          <div class="stat-glass-grid" aria-label="Tracking statistics">
            <article class="stat-card featured">
              <span>Seizure-free</span>
              <strong>${summary.daysSinceLast ?? "--"}</strong>
              <small>${summary.daysSinceLast === 1 ? "day" : "days"}</small>
            </article>
            <article class="stat-card">
              <span>Total</span>
              <strong>${summary.totalSeizures}</strong>
              <small>seizures</small>
            </article>
            <article class="stat-card">
              <span>Average gap</span>
              <strong>${summary.averageGapText}</strong>
              <small>between logs</small>
            </article>
          </div>

          <button class="seizure-cta" data-tab="log" data-focus-seizure="true" type="button">
            <span>Log Seizure</span>
            <small>${escapeHtml(summary.lastSeizureText)}</small>
          </button>
        </section>

        ${renderSeizureTrend(summary)}

        ${renderHomeInsight(summary)}

        ${renderMonthStrip()}

        ${renderDayOverview(state.selectedDayKey)}

        <section class="${installClass}">
          <div class="panel-body">
            <div class="dose-main">
              <div>
                <h2>Install</h2>
                <p class="subtle">Add Sawyer Tracker to the home screen for faster access.</p>
              </div>
              <button class="btn primary small" data-action="install-app">Install</button>
            </div>
          </div>
        </section>

        <section class="plan-grid">
          <article class="plan-card care-card">
            <div class="dose-main">
              <div>
                <p class="eyebrow">Today's plan</p>
                <h2>Medication & supplements</h2>
              </div>
              <button class="btn secondary small" data-action="start-timer">Timer</button>
            </div>
            <div class="dose-list">${entries.map(renderDoseRow).join("")}</div>
          </article>

          <article class="plan-card recent-card">
            <div class="dose-main">
              <div>
                <p class="eyebrow">History</p>
                <h2>Recent notes</h2>
              </div>
              <button class="btn ghost small" data-tab="timeline">View all</button>
            </div>
            ${renderRecentList(4)}
          </article>
        </section>
      </div>
    `;
  }

  function homeGreeting(summary) {
    const name = state.profile?.name || "Sawyer";
    if (summary.daysSinceLast === null) return `Ready when ${name} needs a record.`;
    if (summary.daysSinceLast === 0) return "You logged a seizure today. Keep notes gentle and specific.";
    if (summary.daysSinceLast === 1) return `${name} is 1 day seizure-free.`;
    return `${name} is ${summary.daysSinceLast} days seizure-free.`;
  }

  function shouldShowLoginScreen() {
    return hasSupabaseConfig() && !isSignedIn();
  }

  function renderEmergencySyncBanner() {
    if (!state.storageUnavailable) return "";

    return `
      <aside class="emergency-sync-banner glass-panel">
        <div>
          <strong>Safari recovery mode</strong>
          <p>The phone cache is unavailable, so Sawyer Tracker is using Supabase as the live record for this session.</p>
        </div>
        <button class="btn secondary small" data-tab="backup" type="button">Cloud status</button>
      </aside>
    `;
  }

  function renderLoginScreen() {
    return `
      <section class="login-card glass-panel">
        <div>
          <p class="eyebrow">${escapeHtml(formatWelcomeDate(new Date()))}</p>
          <h1>Sawyer Tracker</h1>
          <p class="subtle">Enter the household access code once on this device. After that, Sawyer's records sync directly with Supabase without email sign-in.</p>
        </div>

        ${renderTrustedDeviceLogin(true)}

        <p class="subtle sync-message">${escapeHtml(state.syncMessage || state.settings?.lastSyncMessage || "Use the same access code on both phones to keep one shared Supabase record.")}</p>
      </section>
    `;
  }

  function renderTrustedDeviceLogin(configured) {
    return `
      <form id="access-form" class="form-grid">
        <div class="field">
          <label for="household-access-code">Household access code</label>
          <input id="household-access-code" name="accessCode" type="password" autocomplete="current-password" placeholder="Enter Sawyer's code" required />
        </div>
        <button class="btn primary" type="submit" ${configured ? "" : "disabled"}>Connect to Supabase</button>
      </form>
    `;
  }

  function renderSeizureTrend(summary) {
    const monthly = getMonthlySeizureCounts();
    const max = Math.max(...monthly.map((item) => item.count), 1);
    const chartWidth = 300;
    const chartHeight = 116;
    const leftPad = 16;
    const rightPad = 16;
    const bottomPad = 24;
    const topPad = 14;
    const plotWidth = chartWidth - leftPad - rightPad;
    const plotHeight = chartHeight - topPad - bottomPad;
    const step = plotWidth / Math.max(monthly.length - 1, 1);
    const points = monthly.map((item, index) => {
      const x = leftPad + step * index;
      const y = topPad + plotHeight - (item.count / max) * plotHeight;
      return { ...item, x, y };
    });
    const path = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${round1(point.x)} ${round1(point.y)}`)
      .join(" ");
    const areaPath = `${path} L ${round1(points.at(-1).x)} ${chartHeight - bottomPad} L ${round1(points[0].x)} ${chartHeight - bottomPad} Z`;

    return `
      <section class="trend-card glass-panel">
        <div class="trend-copy">
          <p class="eyebrow">Seizure trend</p>
          <h2>At a glance</h2>
          <p class="subtle">${summary.totalSeizures ? `${summary.totalSeizures} seizure${summary.totalSeizures === 1 ? "" : "s"} tracked across your timeline.` : "Your graph will build as seizures are logged."}</p>
        </div>
        <div class="trend-chart" aria-label="Seizures over the last six months">
          <svg viewBox="0 0 ${chartWidth} ${chartHeight}" role="img" aria-label="Monthly seizure trend">
            <defs>
              <linearGradient id="trendAreaGradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="rgba(255, 107, 87, 0.28)"></stop>
                <stop offset="100%" stop-color="rgba(255, 107, 87, 0.02)"></stop>
              </linearGradient>
              <linearGradient id="trendLineGradient" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stop-color="#ff8a5f"></stop>
                <stop offset="52%" stop-color="#ff6b57"></stop>
                <stop offset="100%" stop-color="#c74e96"></stop>
              </linearGradient>
            </defs>
            <line class="trend-grid-line" x1="${leftPad}" x2="${chartWidth - rightPad}" y1="${topPad + plotHeight * 0.25}" y2="${topPad + plotHeight * 0.25}"></line>
            <line class="trend-grid-line" x1="${leftPad}" x2="${chartWidth - rightPad}" y1="${topPad + plotHeight * 0.5}" y2="${topPad + plotHeight * 0.5}"></line>
            <line class="trend-grid-line" x1="${leftPad}" x2="${chartWidth - rightPad}" y1="${topPad + plotHeight * 0.75}" y2="${topPad + plotHeight * 0.75}"></line>
            <path class="trend-area" d="${areaPath}"></path>
            <path class="trend-line" d="${path}"></path>
            ${points.map((point) => `
              <g>
                <rect class="trend-bar" x="${round1(point.x - 10)}" y="${round1(topPad + plotHeight - (point.count / max) * plotHeight)}" width="20" height="${round1((point.count / max) * plotHeight)}" rx="10"></rect>
                <circle class="trend-dot" cx="${round1(point.x)}" cy="${round1(point.y)}" r="${point.count ? 4.5 : 3.5}"></circle>
                <text class="trend-count" x="${round1(point.x)}" y="${round1(Math.max(10, point.y - 8))}">${point.count}</text>
                <text class="trend-label" x="${round1(point.x)}" y="${chartHeight - 5}">${escapeHtml(point.label)}</text>
              </g>
            `).join("")}
          </svg>
        </div>
      </section>
    `;
  }

  function renderHomeInsight(summary) {
    const insight = buildHomeInsight(summary);

    return `
      <section class="home-insight glass-panel">
        <div>
          <p class="eyebrow">Insight</p>
          <h2>${escapeHtml(insight.title)}</h2>
          <p class="subtle">${escapeHtml(insight.body)}</p>
        </div>
        <button class="btn ghost small" data-tab="insights" type="button">More</button>
      </section>
    `;
  }

  function renderMonthStrip() {
    const today = new Date();
    const selectedDate = dayKeyToDate(state.selectedDayKey);
    const monthStart = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    const daysInMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0).getDate();
    const seizureDays = new Set(
      state.events
        .filter((event) => event.type === "seizure")
        .map((event) => localDateKey(new Date(event.occurredAt)))
    );
    const days = Array.from({ length: daysInMonth }, (_, index) => {
      const date = new Date(monthStart);
      date.setDate(index + 1);
      const isToday = date.toDateString() === today.toDateString();
      const dayKey = localDateKey(date);
      const isSelected = dayKey === state.selectedDayKey;
      const hasSeizure = seizureDays.has(dayKey);
      return `
        <button class="day-pill ${isSelected ? "active" : ""} ${isToday ? "today" : ""} ${hasSeizure ? "marked" : ""}" data-day="${escapeHtml(dayKey)}" type="button" aria-label="${escapeHtml(date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }))}${hasSeizure ? ", seizure logged" : ""}">
          <span>${escapeHtml(date.toLocaleDateString(undefined, { weekday: "short" }))}</span>
          <strong>${date.getDate()}</strong>
        </button>
      `;
    });

    return `
      <section class="month-strip-wrap" aria-label="${escapeHtml(selectedDate.toLocaleDateString(undefined, { month: "long", year: "numeric" }))}">
        <div class="month-strip" data-month-strip>
          ${days.join("")}
        </div>
      </section>
    `;
  }

  function renderDayOverview(dayKey) {
    const date = dayKeyToDate(dayKey);
    const events = eventsForDay(dayKey);
    const doses = getTodayDoseEntries(date);
    const seizures = events.filter((event) => event.type === "seizure");
    const careRecords = events.filter((event) => ["note", "vet_visit", "blood_test"].includes(event.type));
    const exceptions = doses.filter((entry) => entry.status === "missed" || entry.status === "skipped");
    const headline = exceptions.length
      ? `${exceptions.length} dose exception${exceptions.length === 1 ? "" : "s"}`
      : "Medication assumed given";
    const eventList = events.length
      ? events.map((event) => `<li>${escapeHtml(eventTitle(event))}<span>${escapeHtml(formatEventTime(event))}</span></li>`).join("")
      : `<li>No care records<span>${doses.length} scheduled</span></li>`;

    return `
      <section class="day-overview glass-panel">
        <div class="dose-main">
          <div>
            <p class="eyebrow">Day overview</p>
            <h2>${escapeHtml(formatDateShort(date))}</h2>
          </div>
          <span class="status-pill assumed">${escapeHtml(headline)}</span>
        </div>
        <div class="overview-metrics">
          <div><strong>${seizures.length}</strong><span>Seizures</span></div>
          <div><strong>${exceptions.length}</strong><span>Missed</span></div>
          <div><strong>${careRecords.length}</strong><span>Care</span></div>
        </div>
        <ul class="overview-list">${eventList}</ul>
      </section>
    `;
  }

  function renderDoseRow(entry) {
    const classes = ["dose-row"];
    if (entry.status === "given" || entry.status === "assumed") classes.push("done");
    if (entry.status === "missed") classes.push("missed");
    const hasException = entry.status === "missed" || entry.status === "skipped";

    return `
      <article class="${classes.join(" ")}">
        <div class="dose-main">
          <div class="dose-title">
            <strong>${escapeHtml(entry.schedule.name)}</strong>
            <span>${escapeHtml(entry.time.label)} at ${escapeHtml(formatTime(entry.dueAt))}${entry.doseText ? ` · ${escapeHtml(entry.doseText)}` : ""}</span>
          </div>
          <span class="status-pill ${entry.pillClass}">${escapeHtml(entry.statusText)}</span>
        </div>
        <div class="button-row">
          ${
            hasException
              ? `<button class="btn secondary small" data-clear-dose="${entry.log.id}">Undo exception</button>`
              : `<button class="btn secondary small" data-dose="${entry.key}" data-status="missed">Mark missed</button>`
          }
          ${entry.log && !hasException ? `<button class="btn ghost small" data-clear-dose="${entry.log.id}">Clear explicit log</button>` : ""}
        </div>
      </article>
    `;
  }

  function renderLog() {
    const now = new Date();
    const editingSeizure = state.events.find((event) => event.id === state.editingSeizureId && event.type === "seizure");
    const seizureDate = editingSeizure ? new Date(editingSeizure.occurredAt) : now;
    const durationSeconds = editingSeizure ? editingSeizure.durationSeconds || 0 : getTimerSeconds();
    const localDate = toDateInputValue(seizureDate);
    const localTime = toTimeInputValue(seizureDate);
    const timeKnown = editingSeizure ? editingSeizure.timeKnown !== false : false;
    const selectedSeverity = editingSeizure?.severity || state.severity;

    return `
      <div class="stack desktop-two">
        <section class="panel">
          <div class="panel-body">
            <div class="dose-main log-heading">
              <div>
                <p class="eyebrow">${editingSeizure ? "Update record" : "Quick record"}</p>
                <h2>${editingSeizure ? "Edit seizure" : "Log seizure"}</h2>
                <p class="subtle">Add what you remember. Exact time and extra details are optional.</p>
              </div>
              ${editingSeizure ? `<button class="btn ghost small" data-action="cancel-seizure-edit" type="button">Cancel</button>` : ""}
            </div>

            <form id="seizure-form" class="form-grid seizure-form">
              <input type="hidden" name="id" value="${escapeHtml(editingSeizure?.id || "")}" />

              <section class="log-section">
                <div class="log-section-heading">
                  <span>1</span>
                  <div>
                    <strong>When</strong>
                    <small>Date is enough if the time is unclear.</small>
                  </div>
                </div>
                <div class="field">
                  <label for="seizure-date">Date</label>
                  ${renderDateInput("seizure-date", "date", localDate, true)}
                </div>
                <label class="toggle-row" for="seizure-time-known">
                  <span>
                    <strong>Add approximate time</strong>
                    <small>Useful when you remember roughly when it happened.</small>
                  </span>
                  <input id="seizure-time-known" name="timeKnown" type="checkbox" data-time-known ${timeKnown ? "checked" : ""} />
                </label>
                <div class="field optional-time-field" data-optional-time ${timeKnown ? "" : "hidden"}>
                  <label for="seizure-time">Approximate time</label>
                  ${renderTimeInput("seizure-time", "time", localTime)}
                </div>
              </section>

              <section class="log-section">
                <div class="log-section-heading">
                  <span>2</span>
                  <div>
                    <strong>What happened</strong>
                    <small>Duration can be an estimate.</small>
                  </div>
                </div>
                ${editingSeizure ? "" : `
                  <div class="compact-timer">
                    <div>
                      <span>Live duration timer</span>
                      <strong id="timer-face">${formatDuration(getTimerSeconds())}</strong>
                    </div>
                    <div class="button-row">
                      <button class="btn ${state.timerStartedAt ? "danger" : "secondary"} small" data-action="${state.timerStartedAt ? "stop-timer" : "start-timer"}" type="button">
                        ${state.timerStartedAt ? "Stop" : "Start"}
                      </button>
                      ${state.timerStartedAt ? `<button class="btn ghost small" data-action="reset-timer" type="button">Reset</button>` : ""}
                    </div>
                  </div>
                `}
                <div class="grid two duration-grid">
                  <div class="field">
                    <label for="duration-minutes">Minutes</label>
                    <input id="duration-minutes" name="minutes" type="number" min="0" step="1" inputmode="numeric" value="${Math.floor(durationSeconds / 60)}" />
                  </div>
                  <div class="field">
                    <label for="duration-seconds">Seconds</label>
                    <input id="duration-seconds" name="seconds" type="number" min="0" max="59" step="1" inputmode="numeric" value="${durationSeconds % 60}" />
                  </div>
                </div>
                <div class="field">
                  <span class="label">Severity</span>
                  <input id="seizure-severity" name="severity" type="hidden" value="${selectedSeverity}" />
                  <div class="segmented" role="group" aria-label="Severity">
                    ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="${selectedSeverity === n ? "active" : ""}" data-severity="${n}">${n}</button>`).join("")}
                  </div>
                </div>
              </section>

              <details class="log-details" ${editingSeizure ? "open" : ""}>
                <summary>
                  <span>
                    <strong>Symptoms, care and notes</strong>
                    <small>Optional details for Sawyer's history.</small>
                  </span>
                </summary>
                <div class="log-details-body">
                <div class="field">
                  <span class="label">Symptoms</span>
                  <div class="checks">
                    ${SYMPTOMS.map((symptom) => `
                      <label class="check-chip">
                        <input type="checkbox" name="symptoms" value="${escapeHtml(symptom)}" ${editingSeizure?.symptoms?.includes(symptom) ? "checked" : ""} /> ${escapeHtml(symptom)}
                      </label>
                    `).join("")}
                  </div>
                </div>
                <div class="field">
                  <label for="trigger">Possible trigger</label>
                  <select id="trigger" name="trigger">
                    ${TRIGGERS.map((trigger) => `<option value="${escapeHtml(trigger)}" ${editingSeizure?.trigger === trigger ? "selected" : ""}>${escapeHtml(trigger)}</option>`).join("")}
                  </select>
                </div>
                <div class="field">
                  <label for="rescue">Medication or care given during/after</label>
                  <textarea id="rescue" name="rescue" placeholder="Example: stayed with him, cooled room, called vet">${escapeHtml(editingSeizure?.rescue || "")}</textarea>
                </div>
                <div class="field">
                  <label for="recovery">Recovery notes</label>
                  <textarea id="recovery" name="recovery" placeholder="Example: pacing for 20 minutes, ate after">${escapeHtml(editingSeizure?.recovery || "")}</textarea>
                </div>
                <div class="field">
                  <label for="notes">Notes</label>
                  <textarea id="notes" name="notes">${escapeHtml(editingSeizure?.notes || "")}</textarea>
                </div>
                </div>
              </details>

              <div class="button-row log-submit-row">
                <button class="btn primary" type="submit">${editingSeizure ? "Update seizure" : "Save seizure"}</button>
                ${editingSeizure ? `<button class="btn danger" data-delete-event="${escapeHtml(editingSeizure.id)}" type="button">Delete seizure</button>` : ""}
              </div>
            </form>
          </div>
        </section>

        <section class="panel">
          <div class="panel-body">
            <h2>Care Note</h2>
            <form id="note-form" class="form-grid">
              <div class="field">
                <label for="note-title">Title</label>
                <input id="note-title" name="title" placeholder="Appetite, behaviour, vet call" />
              </div>
              <div class="field">
                <label for="note-body">Note</label>
                <textarea id="note-body" name="body" required></textarea>
              </div>
              <button class="btn primary" type="submit">Save Note</button>
            </form>

            <div class="form-divider"></div>

            <h2>Vet Visit</h2>
            <form id="vet-form" class="form-grid">
              <div class="grid two date-time-grid">
                <div class="field">
                  <label for="vet-date">Date</label>
                  ${renderDateInput("vet-date", "date", localDate, true)}
                </div>
                <div class="field">
                  <label for="vet-time">Time</label>
                  ${renderTimeInput("vet-time", "time", localTime)}
                </div>
              </div>
              <div class="field">
                <label for="vet-clinic">Clinic or vet</label>
                <input id="vet-clinic" name="clinic" placeholder="Vet name or clinic" />
              </div>
              <div class="field">
                <label for="vet-reason">Reason</label>
                <input id="vet-reason" name="reason" placeholder="Checkup, seizure review, medication review" required />
              </div>
              <div class="field">
                <label for="vet-weight">Weight</label>
                <input id="vet-weight" name="weight" placeholder="Example: 24.8 kg" />
              </div>
              <div class="field">
                <label for="vet-plan">Plan / medication changes</label>
                <textarea id="vet-plan" name="plan" placeholder="Next steps, dosage changes, follow-up date"></textarea>
              </div>
              <button class="btn primary" type="submit">Save Vet Visit</button>
            </form>

            <div class="form-divider"></div>

            <h2>Blood Test</h2>
            <form id="blood-test-form" class="form-grid">
              <div class="grid two date-time-grid">
                <div class="field">
                  <label for="blood-date">Date</label>
                  ${renderDateInput("blood-date", "date", localDate, true)}
                </div>
                <div class="field">
                  <label for="blood-time">Time</label>
                  ${renderTimeInput("blood-time", "time", localTime)}
                </div>
              </div>
              <div class="field">
                <label for="blood-panel">Test / panel</label>
                <input id="blood-panel" name="panel" placeholder="Phenobarbital level, bromide level, liver panel" required />
              </div>
              <div class="grid two">
                <div class="field">
                  <label for="blood-phenobarbital">Phenobarbital</label>
                  <input id="blood-phenobarbital" name="phenobarbitalLevel" placeholder="Value and units" />
                </div>
                <div class="field">
                  <label for="blood-bromide">Bromide</label>
                  <input id="blood-bromide" name="bromideLevel" placeholder="Value and units" />
                </div>
              </div>
              <div class="field">
                <label for="blood-results">Results</label>
                <textarea id="blood-results" name="results" placeholder="Paste key results or lab notes"></textarea>
              </div>
              <div class="field">
                <label for="blood-notes">Notes</label>
                <textarea id="blood-notes" name="notes" placeholder="Vet interpretation, recheck timing, changes"></textarea>
              </div>
              <button class="btn primary" type="submit">Save Blood Test</button>
            </form>
          </div>
        </section>
      </div>
    `;
  }

  function renderTimeline() {
    const events = filteredTimelineEvents();

    return `
      <div class="stack">
        <section class="panel">
          <div class="panel-body">
            <h2>History</h2>
            <div class="filters">
              ${TIMELINE_FILTERS.map((filter) => `
                <button class="btn small ${state.timelineFilter === filter.id ? "primary" : "secondary"}" data-filter="${filter.id}">
                  ${escapeHtml(filter.label)}
                </button>
              `).join("")}
            </div>
          </div>
        </section>
        ${events.length ? `<div class="timeline-list">${events.map(renderTimelineItem).join("")}</div>` : `<div class="empty">No records in this view yet.</div>`}
      </div>
    `;
  }

  function renderTimelineItem(event) {
    return `
      <article class="timeline-item ${escapeHtml(event.type)}">
        <div class="timeline-head">
          <div>
            <strong>${escapeHtml(eventTitle(event))}</strong>
            <div class="timeline-meta">${escapeHtml(formatEventDateTime(event))}</div>
          </div>
          <div class="timeline-actions">
            ${event.type === "seizure" ? `<button class="btn secondary small" data-edit-seizure="${escapeHtml(event.id)}">Edit</button>` : ""}
            <button class="btn ghost small" data-delete-event="${escapeHtml(event.id)}">Delete</button>
          </div>
        </div>
        ${eventDetail(event)}
      </article>
    `;
  }

  function renderRecentList(limit) {
    const recent = state.events
      .slice()
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
      .slice(0, limit);

    if (!recent.length) return `<div class="empty">No records yet.</div>`;
    return `<div class="timeline-list">${recent.map(renderTimelineItem).join("")}</div>`;
  }

  function renderInsights(summary) {
    const insights = buildInsights(summary);
    const monthly = getMonthlySeizureCounts();
    const max = Math.max(...monthly.map((item) => item.count), 1);

    return `
      <div class="stack">
        <section class="panel">
          <div class="panel-body">
            <h2>Insights</h2>
            <div class="metric-row">
              <div class="metric">
                <span>This month</span>
                <strong>${summary.thisMonthSeizures}</strong>
              </div>
              <div class="metric">
                <span>Longest gap</span>
                <strong>${summary.longestGapText}</strong>
              </div>
              <div class="metric">
                <span>Avg duration</span>
                <strong>${summary.averageDurationText}</strong>
              </div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-body">
            <h2>Observations</h2>
            <div class="insight-list">
              ${insights.map((insight) => `
                <article class="insight">
                  <strong>${escapeHtml(insight.title)}</strong>
                  <p class="subtle">${escapeHtml(insight.body)}</p>
                </article>
              `).join("")}
            </div>
          </div>
        </section>

        ${renderAiInsightPanel()}

        <section class="panel">
          <div class="panel-body">
            <h2>Seizures by Month</h2>
            <div class="bar-chart">
              ${monthly.map((item) => `
                <div class="bar-row">
                  <span>${escapeHtml(item.label)}</span>
                  <div class="bar-track"><div class="bar-fill" style="width: ${(item.count / max) * 100}%"></div></div>
                  <strong>${item.count}</strong>
                </div>
              `).join("")}
            </div>
          </div>
        </section>
      </div>
    `;
  }

  function renderAiInsightPanel() {
    const insight = state.aiInsight;
    const canRun = hasSupabaseConfig() && isSignedIn();

    return `
      <section class="panel ai-panel">
        <div class="panel-body">
          <div class="dose-main">
            <div>
              <p class="eyebrow">AI review</p>
              <h2>${escapeHtml(insight?.title || "Ask AI to review Sawyer's records")}</h2>
            </div>
            <button class="btn primary small" data-action="generate-ai" ${state.aiBusy || !canRun ? "disabled" : ""}>
              ${state.aiBusy ? "Reviewing..." : "Run AI"}
            </button>
          </div>
          <p class="subtle">${escapeHtml(insight?.summary || (canRun ? "Uses synced Supabase records to draft pattern notes and vet questions." : "Connect Supabase before using AI review."))}</p>
          ${state.aiError ? `<p class="subtle danger-text">${escapeHtml(state.aiError)}</p>` : ""}
          ${insight?.bullets?.length ? `
            <div class="insight-list ai-list">
              ${insight.bullets.map((item) => `
                <article class="insight">
                  <strong>${escapeHtml(item.title || "Observation")}</strong>
                  <p class="subtle">${escapeHtml(item.detail || item.body || "")}</p>
                </article>
              `).join("")}
            </div>
          ` : ""}
          ${insight?.questions?.length ? `
            <div class="ai-questions">
              <p class="eyebrow">Ask your vet</p>
              <ul>${insight.questions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ul>
            </div>
          ` : ""}
          <p class="subtle">AI can notice patterns, but it cannot diagnose or replace your vet.</p>
        </div>
      </section>
    `;
  }

  function renderBackup() {
    const notificationText =
      "Notification" in window ? Notification.permission : "Not supported";
    const lastBackup = state.settings?.lastBackupAt
      ? formatDateTime(new Date(state.settings.lastBackupAt))
      : "No backup yet";

    return `
      <div class="stack">
        <section class="panel">
          <div class="panel-body">
            <h2>Care Setup</h2>
            <form id="setup-form" class="form-grid">
              <div class="field">
                <label for="dog-name">Dog name</label>
                <input id="dog-name" name="dogName" value="${escapeHtml(state.profile?.name || "Sawyer")}" required />
              </div>
              <div class="setup-list">
                ${state.schedules.map(renderSetupSchedule).join("")}
              </div>
              <button class="btn primary" type="submit">Save Setup</button>
            </form>
          </div>
        </section>

        <section class="panel">
          <div class="panel-body">
            <h2>Reminders</h2>
            <div class="metric-row">
              <div class="metric">
                <span>Status</span>
                <strong>${state.settings?.remindersEnabled ? "On" : "Off"}</strong>
              </div>
              <div class="metric">
                <span>Permission</span>
                <strong>${escapeHtml(capitalize(notificationText))}</strong>
              </div>
              <div class="metric">
                <span>Window</span>
                <strong>${REMINDER_WINDOW_MINUTES} min</strong>
              </div>
            </div>
            <div class="button-row" style="margin-top: 12px;">
              <button class="btn primary" data-action="enable-reminders">Enable Reminders</button>
              <button class="btn secondary" data-action="disable-reminders">Disable</button>
            </div>
          </div>
        </section>

        ${renderCloudSync()}

        <section class="panel">
          <div class="panel-body">
            <h2>Backup</h2>
            <p class="subtle">Last backup: ${escapeHtml(lastBackup)}</p>
            <div class="button-row">
              <button class="btn primary" data-action="export-json">Export Backup</button>
              <button class="btn secondary" data-action="import-json">Import Backup</button>
              <button class="btn secondary" data-action="export-csv">Export CSV</button>
            </div>
          </div>
        </section>

        <section class="panel danger-zone">
          <div class="panel-body">
            <h2>Reset</h2>
            <p class="subtle">This only clears records on this device.</p>
            <button class="btn danger" data-action="reset-data">Clear Local Data</button>
          </div>
        </section>
      </div>
    `;
  }

  function renderCloudSync() {
    const configured = hasSupabaseConfig();
    const signedIn = isSignedIn();
    const lastSync = state.settings?.lastSyncAt
      ? formatDateTime(new Date(state.settings.lastSyncAt))
      : "Never";
    const syncStatus = state.syncBusy
      ? "Syncing"
      : signedIn
        ? navigator.onLine
          ? "Cloud connected"
          : "Offline"
        : configured
          ? "Needs access code"
          : "Not set up";
    const syncMessage = state.syncMessage || state.settings?.lastSyncMessage || "";
    const sourceMessage = signedIn
      ? "Supabase is the shared source of truth. This device only keeps a cache so the app opens quickly."
      : "Enter Sawyer's household access code before logging records. New entries are saved only when Supabase is connected.";

    return `
      <section class="panel">
        <div class="panel-body">
          <h2>Supabase Sync</h2>
          <div class="metric-row">
            <div class="metric">
              <span>Status</span>
              <strong>${escapeHtml(syncStatus)}</strong>
            </div>
            <div class="metric">
              <span>Access</span>
              <strong>${escapeHtml(signedInEmail() || "--")}</strong>
            </div>
            <div class="metric">
              <span>Last sync</span>
              <strong>${escapeHtml(lastSync)}</strong>
            </div>
          </div>
          <p class="subtle sync-message">${escapeHtml(sourceMessage)}</p>
          ${syncMessage ? `<p class="subtle sync-message">${escapeHtml(syncMessage)}</p>` : ""}

          <form id="sync-config-form" class="form-grid sync-form">
            <div class="field">
              <label for="supabase-url">Project URL</label>
              <input id="supabase-url" name="supabaseUrl" inputmode="url" value="${escapeHtml(state.settings?.supabaseUrl || "")}" placeholder="https://your-project.supabase.co" />
            </div>
            <div class="field">
              <label for="supabase-anon-key">Publishable key</label>
              <input id="supabase-anon-key" name="supabaseAnonKey" value="${escapeHtml(state.settings?.supabaseAnonKey || "")}" placeholder="sb_publishable_..." />
            </div>
            <div class="field">
              <label for="supabase-household-id">Household ID</label>
              <input id="supabase-household-id" name="supabaseHouseholdId" value="${escapeHtml(state.settings?.supabaseHouseholdId || "")}" placeholder="Created by the Supabase setup SQL" />
            </div>
            <button class="btn primary" type="submit">Save Sync Setup</button>
          </form>

          ${
            signedIn
              ? `
                <div class="button-row sync-actions">
                  <button class="btn primary" data-action="sync-now" ${state.syncBusy ? "disabled" : ""}>Sync Now</button>
                  <button class="btn secondary" data-action="sign-out">Forget Access</button>
                </div>
              `
              : `
                <div class="sync-form">${renderTrustedDeviceLogin(configured)}</div>
              `
          }
        </div>
      </section>
    `;
  }

  function renderSetupSchedule(schedule) {
    return `
      <div class="panel">
        <div class="panel-body">
          <h3>${escapeHtml(schedule.name)}</h3>
          <div class="grid two setup-dose-grid">
            <div class="field">
              <label for="${schedule.id}-dose">Dose</label>
              <input id="${schedule.id}-dose" name="${schedule.id}:dose" value="${escapeHtml(schedule.dose || "")}" placeholder="Optional" />
            </div>
            <div class="field">
              <label for="${schedule.id}-unit">Unit</label>
              <input id="${schedule.id}-unit" name="${schedule.id}:unit" value="${escapeHtml(schedule.unit || "")}" placeholder="mg, ml, capsules" />
            </div>
          </div>
          <div class="setup-list" style="margin-top: 10px;">
            ${schedule.times.map((time) => `
              <div class="setup-row">
                <div class="field">
                  <label for="${schedule.id}-${time.id}-label">${escapeHtml(time.label)}</label>
                  <input id="${schedule.id}-${time.id}-label" name="${schedule.id}:${time.id}:label" value="${escapeHtml(time.label)}" />
                </div>
                <div class="field">
                  <label for="${schedule.id}-${time.id}-time">Time</label>
                  ${renderTimeInput(`${schedule.id}-${time.id}-time`, `${schedule.id}:${time.id}:time`, time.time)}
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }

  function bindUi() {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeTab = button.dataset.tab;
        render();
        if (button.dataset.focusSeizure) {
          setTimeout(() => document.querySelector("#seizure-date")?.focus(), 50);
        }
      });
    });

    document.querySelectorAll("[data-dose]").forEach((button) => {
      button.addEventListener("click", () => logDose(button.dataset.dose, button.dataset.status));
    });

    document.querySelectorAll("[data-day]").forEach((button) => {
      button.addEventListener("click", () => {
        if (state.selectedDayKey === button.dataset.day) return;
        state.selectedDayKey = button.dataset.day;
        renderPreservingContentScroll();
      });
    });

    document.querySelectorAll("[data-clear-dose]").forEach((button) => {
      button.addEventListener("click", () => removeEvent(button.dataset.clearDose, "Dose cleared."));
    });

    document.querySelectorAll("[data-delete-event]").forEach((button) => {
      button.addEventListener("click", () => {
        if (confirm("Delete this record?")) removeEvent(button.dataset.deleteEvent, "Record deleted.");
      });
    });

    document.querySelectorAll("[data-edit-seizure]").forEach((button) => {
      button.addEventListener("click", () => editSeizure(button.dataset.editSeizure));
    });

    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.timelineFilter = button.dataset.filter;
        render();
      });
    });

    document.querySelectorAll("[data-severity]").forEach((button) => {
      button.addEventListener("click", () => {
        state.severity = Number(button.dataset.severity);
        const severityInput = document.querySelector("#seizure-severity");
        if (severityInput) severityInput.value = String(state.severity);
        document.querySelectorAll("[data-severity]").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
      });
    });

    document.querySelectorAll(".time-input-shell input[type='time']").forEach((input) => {
      const display = input.closest(".time-input-shell")?.querySelector(".time-input-value");
      const updateDisplay = () => {
        if (display) display.textContent = formatTimeInputValue(input.value);
      };
      input.addEventListener("input", updateDisplay);
      input.addEventListener("change", updateDisplay);
    });

    document.querySelectorAll(".date-input-shell input[type='date']").forEach((input) => {
      const display = input.closest(".date-input-shell")?.querySelector(".date-input-value");
      const updateDisplay = () => {
        if (display) display.textContent = formatDateInputValue(input.value);
      };
      input.addEventListener("input", updateDisplay);
      input.addEventListener("change", updateDisplay);
    });

    const timeKnownToggle = document.querySelector("[data-time-known]");
    const optionalTimeField = document.querySelector("[data-optional-time]");
    const optionalTimeInput = optionalTimeField?.querySelector("input[type='time']");
    if (timeKnownToggle && optionalTimeField && optionalTimeInput) {
      const updateOptionalTime = () => {
        optionalTimeField.hidden = !timeKnownToggle.checked;
        optionalTimeInput.disabled = !timeKnownToggle.checked;
      };
      timeKnownToggle.addEventListener("change", updateOptionalTime);
      updateOptionalTime();
    }

    document.querySelector("#seizure-form")?.addEventListener("submit", saveSeizure);
    document.querySelector("#note-form")?.addEventListener("submit", saveNote);
    document.querySelector("#vet-form")?.addEventListener("submit", saveVetVisit);
    document.querySelector("#blood-test-form")?.addEventListener("submit", saveBloodTest);
    document.querySelector("#setup-form")?.addEventListener("submit", saveSetup);
    document.querySelector("#sync-config-form")?.addEventListener("submit", saveSyncConfig);
    document.querySelector("#access-form")?.addEventListener("submit", saveAccessCode);

    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => handleAction(button.dataset.action));
    });

    bindPullRefresh();
  }

  function centerSelectedDayPill() {
    if (state.activeTab !== "today") return;
    requestAnimationFrame(() => {
      const strip = document.querySelector("[data-month-strip]");
      const active = strip?.querySelector(".day-pill.active");
      if (!strip || !active) return;
      strip.scrollLeft = active.offsetLeft - strip.clientWidth / 2 + active.clientWidth / 2;
    });
  }

  function renderPreservingContentScroll() {
    const restoreScroll = captureContentScroll();
    render();
    restoreScroll();
    centerSelectedDayPill();
  }

  function captureContentScroll() {
    const content = document.querySelector(".content");
    const useWindowScroll = isIosBrowser();
    const scrollTop = useWindowScroll ? window.scrollY || 0 : content?.scrollTop || 0;
    return () => requestAnimationFrame(() => {
      if (useWindowScroll) {
        window.scrollTo({ top: scrollTop, left: 0, behavior: "auto" });
        return;
      }
      const nextContent = document.querySelector(".content");
      if (nextContent) nextContent.scrollTop = scrollTop;
    });
  }

  function bindPullRefresh() {
    if (isIosBrowser()) return;

    const content = document.querySelector(".content");
    const indicator = document.querySelector("#pull-refresh");
    if (!content || !indicator || content.__pullRefreshBound) return;
    content.__pullRefreshBound = true;

    let startY = 0;
    let pull = 0;
    let pulling = false;

    const resetPull = () => {
      pull = 0;
      indicator.style.setProperty("--pull-distance", "0px");
      indicator.classList.remove("visible", "ready", "refreshing");
      indicator.textContent = "Pull to refresh";
    };

    content.addEventListener(
      "touchstart",
      (event) => {
        if (content.scrollTop > 0 || state.pullRefreshing) return;
        startY = event.touches[0].clientY;
        pulling = true;
      },
      { passive: true }
    );

    content.addEventListener(
      "touchmove",
      (event) => {
        if (!pulling || state.pullRefreshing) return;
        const distance = event.touches[0].clientY - startY;
        if (distance <= 0 || content.scrollTop > 0) {
          resetPull();
          return;
        }
        pull = Math.min(110, distance * 0.45);
        indicator.style.setProperty("--pull-distance", `${pull}px`);
        indicator.textContent = pull > 72 ? "Release to refresh" : "Pull to refresh";
        indicator.classList.toggle("ready", pull > 72);
        indicator.classList.add("visible");
      },
      { passive: true }
    );

    content.addEventListener(
      "touchend",
      async () => {
        if (!pulling) return;
        pulling = false;
        if (pull <= 72 || state.pullRefreshing) {
          resetPull();
          return;
        }
        state.pullRefreshing = true;
        indicator.classList.add("refreshing");
        indicator.textContent = "Refreshing...";
        await refreshApp();
        state.pullRefreshing = false;
        resetPull();
      },
      { passive: true }
    );
  }

  async function refreshApp(options = {}) {
    await safeHydrate();
    await initSupabase();
    if (state.settings?.syncEnabled && isSignedIn() && navigator.onLine) {
      await syncWithSupabase({ silent: true });
      render();
    } else {
      render();
    }
    checkReminders();
    if (!options.silent) {
      showToast(isSignedIn() ? "Synced with Supabase." : "This device is not connected to Supabase yet.");
    }
  }

  async function handleAction(action) {
    if (action === "start-timer") startTimer();
    if (action === "stop-timer") stopTimer();
    if (action === "reset-timer") resetTimer();
    if (action === "quick-note") {
      state.activeTab = "log";
      render();
      setTimeout(() => document.querySelector("#note-title")?.focus(), 50);
    }
    if (action === "install-app") installApp();
    if (action === "enable-reminders") enableReminders();
    if (action === "disable-reminders") disableReminders();
    if (action === "export-json") exportJson();
    if (action === "import-json") importJson();
    if (action === "export-csv") exportCsv();
    if (action === "sync-now") syncWithSupabase();
    if (action === "generate-ai") generateAiInsights();
    if (action === "sign-out") signOut();
    if (action === "reset-data") resetData();
    if (action === "cancel-seizure-edit") cancelSeizureEdit();
  }

  async function syncAfterLocalChange() {
    if (state.settings?.syncEnabled && isSignedIn() && navigator.onLine) {
      await syncWithSupabase({ silent: true });
      return;
    }
    throw new Error(cloudSaveBlockMessage());
  }

  function cloudSaveBlockMessage() {
    if (!hasSupabaseConfig()) return "Supabase is not configured yet.";
    if (!state.settings?.syncEnabled) return "Supabase sync is not enabled yet.";
    if (!isSignedIn()) return "Enter the household access code before saving Sawyer's records.";
    if (!navigator.onLine) return "Internet is required before saving Sawyer's records.";
    return "Supabase is not ready yet.";
  }

  function canSaveCloudRecord() {
    if (hasSupabaseConfig() && state.settings?.syncEnabled && isSignedIn() && navigator.onLine) return true;
    const message = cloudSaveBlockMessage();
    state.syncMessage = message;
    showToast(message);
    if (!isSignedIn()) render();
    return false;
  }

  async function logDose(doseKey, status) {
    if (!canSaveCloudRecord()) return;
    const entry = getTodayDoseEntries().find((item) => item.key === doseKey);
    if (!entry) return;

    const restoreScroll = captureContentScroll();
    const existing = entry.log;
    const timestamp = nowIso();
    const event = {
      id: existing?.id || uid(),
      dogId: DOG_ID,
      type: "dose",
      scheduleId: entry.schedule.id,
      timeId: entry.time.id,
      doseKey,
      dayKey: localDateKey(entry.dueAt),
      occurredAt: timestamp,
      dueAt: entry.dueAt.toISOString(),
      status,
      medicationName: entry.schedule.name,
      kind: entry.schedule.kind,
      dose: entry.schedule.dose || "",
      unit: entry.schedule.unit || "",
      label: entry.time.label,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      syncStatus: "local"
    };

    await dbPut("events", event);
    await hydrate();
    await syncAfterLocalChange();
    render();
    restoreScroll();
    showToast(`${entry.schedule.name} marked ${status}.`);
  }

  async function removeEvent(id, message) {
    if (!canSaveCloudRecord()) return;
    const restoreScroll = captureContentScroll();
    const existing = await dbGet("events", id);
    if (existing) {
      const timestamp = nowIso();
      await dbPut("events", {
        ...existing,
        deletedAt: timestamp,
        updatedAt: timestamp,
        syncStatus: "local"
      });
    }
    if (state.editingSeizureId === id) state.editingSeizureId = "";
    await refreshAutomaticClusterFlags();
    await hydrate();
    await syncAfterLocalChange();
    render();
    restoreScroll();
    showToast(message);
  }

  async function editSeizure(id) {
    const existing = state.events.find((event) => event.id === id && event.type === "seizure") || (await dbGet("events", id));
    if (!existing || existing.type !== "seizure") {
      showToast("That seizure record could not be opened.");
      return;
    }

    state.editingSeizureId = existing.id;
    state.severity = existing.severity || 3;
    state.activeTab = "log";
    render();
    setTimeout(() => document.querySelector("#seizure-date")?.focus(), 50);
  }

  function cancelSeizureEdit() {
    state.editingSeizureId = "";
    render();
  }

  async function saveSeizure(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const existingId = String(form.get("id") || "").trim();
    const existing = existingId ? await dbGet("events", existingId) : null;
    const date = String(form.get("date") || localDateKey(new Date()));
    const timeKnown = form.get("timeKnown") === "on";
    const time = timeKnown ? String(form.get("time") || "12:00") : "12:00";
    const occurredAt = localTimeToDate(date, time);
    const minutes = clamp(Number(form.get("minutes") || 0), 0, 999);
    const seconds = clamp(Number(form.get("seconds") || 0), 0, 59);
    const durationSeconds = minutes * 60 + seconds;
    const timestamp = nowIso();

    const record = {
      id: existing?.id || uid(),
      dogId: DOG_ID,
      type: "seizure",
      dayKey: localDateKey(occurredAt),
      occurredAt: occurredAt.toISOString(),
      timeKnown,
      durationSeconds,
      severity: Number(form.get("severity") || state.severity || existing?.severity || 3),
      cluster: false,
      clusterSource: "automatic",
      symptoms: form.getAll("symptoms"),
      trigger: form.get("trigger") || "Unknown",
      rescue: String(form.get("rescue") || "").trim(),
      recovery: String(form.get("recovery") || "").trim(),
      notes: String(form.get("notes") || "").trim(),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      syncStatus: "local"
    };

    await dbPut("events", record);
    await refreshAutomaticClusterFlags();
    if (existing) {
      state.editingSeizureId = "";
    } else {
      resetTimer(false);
    }
    await hydrate();
    const clusterDetected = isAutomaticCluster(record);
    await syncAfterLocalChange();
    state.activeTab = "today";
    render();
    showToast(
      clusterDetected
        ? `${existing ? "Seizure updated" : "Seizure saved"}. Multiple seizures were logged within 24 hours.`
        : existing
          ? "Seizure updated."
          : "Seizure saved."
    );
  }

  async function saveNote(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") || "Care note").trim() || "Care note";
    const body = String(form.get("body") || "").trim();
    if (!body) return;
    const timestamp = nowIso();

    await dbPut("events", {
      id: uid(),
      dogId: DOG_ID,
      type: "note",
      dayKey: localDateKey(new Date()),
      occurredAt: timestamp,
      title,
      body,
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: "local"
    });

    await hydrate();
    await syncAfterLocalChange();
    state.activeTab = "today";
    render();
    showToast("Note saved.");
  }

  async function saveVetVisit(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const date = String(form.get("date") || toDateInputValue(new Date()));
    const time = String(form.get("time") || "12:00");
    const occurredAt = new Date(`${date}T${time}`);
    const timestamp = nowIso();

    await dbPut("events", {
      id: uid(),
      dogId: DOG_ID,
      type: "vet_visit",
      dayKey: localDateKey(occurredAt),
      occurredAt: occurredAt.toISOString(),
      clinic: String(form.get("clinic") || "").trim(),
      reason: String(form.get("reason") || "Vet visit").trim() || "Vet visit",
      weight: String(form.get("weight") || "").trim(),
      plan: String(form.get("plan") || "").trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: "local"
    });

    await hydrate();
    await syncAfterLocalChange();
    state.activeTab = "today";
    render();
    showToast("Vet visit saved.");
  }

  async function saveBloodTest(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const date = String(form.get("date") || toDateInputValue(new Date()));
    const time = String(form.get("time") || "12:00");
    const occurredAt = new Date(`${date}T${time}`);
    const timestamp = nowIso();

    await dbPut("events", {
      id: uid(),
      dogId: DOG_ID,
      type: "blood_test",
      dayKey: localDateKey(occurredAt),
      occurredAt: occurredAt.toISOString(),
      panel: String(form.get("panel") || "Blood test").trim() || "Blood test",
      phenobarbitalLevel: String(form.get("phenobarbitalLevel") || "").trim(),
      bromideLevel: String(form.get("bromideLevel") || "").trim(),
      results: String(form.get("results") || "").trim(),
      notes: String(form.get("notes") || "").trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
      syncStatus: "local"
    });

    await hydrate();
    await syncAfterLocalChange();
    state.activeTab = "today";
    render();
    showToast("Blood test saved.");
  }

  async function saveSetup(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const timestamp = nowIso();
    const dogName = String(form.get("dogName") || "Sawyer").trim() || "Sawyer";
    const changeNotes = [];

    await dbPut("profile", {
      ...state.profile,
      name: dogName,
      updatedAt: timestamp,
      syncStatus: "local"
    });

    const updatedSchedules = state.schedules.map((schedule) => ({
      ...schedule,
      dose: String(form.get(`${schedule.id}:dose`) || "").trim(),
      unit: String(form.get(`${schedule.id}:unit`) || "").trim(),
      times: schedule.times.map((time) => ({
        ...time,
        label: String(form.get(`${schedule.id}:${time.id}:label`) || time.label).trim() || time.label,
        time: String(form.get(`${schedule.id}:${time.id}:time`) || time.time)
      })),
      updatedAt: timestamp,
      syncStatus: "local"
    }));

    updatedSchedules.forEach((updated) => {
      const original = state.schedules.find((schedule) => schedule.id === updated.id);
      if (!original) return;
      const originalDose = [original.dose, original.unit].filter(Boolean).join(" ") || "no dose set";
      const updatedDose = [updated.dose, updated.unit].filter(Boolean).join(" ") || "no dose set";
      if (originalDose !== updatedDose) {
        changeNotes.push(`${updated.name} dose changed from ${originalDose} to ${updatedDose}`);
      }
      updated.times.forEach((time) => {
        const originalTime = original.times.find((item) => item.id === time.id);
        if (originalTime && originalTime.time !== time.time) {
          changeNotes.push(`${updated.name} ${time.label} time changed from ${originalTime.time} to ${time.time}`);
        }
      });
    });

    await dbBulkPut("schedules", updatedSchedules);

    if (changeNotes.length) {
      await dbPut("events", {
        id: uid(),
        dogId: DOG_ID,
        type: "note",
        dayKey: localDateKey(new Date()),
        occurredAt: timestamp,
        title: "Care setup updated",
        body: changeNotes.join(". "),
        createdAt: timestamp,
        updatedAt: timestamp,
        syncStatus: "local"
      });
    }

    await hydrate();
    await syncAfterLocalChange();
    render();
    showToast("Setup saved.");
  }

  async function saveSyncConfig(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const supabaseUrl = String(form.get("supabaseUrl") || "").trim().replace(/\/$/, "");
    const supabaseAnonKey = String(form.get("supabaseAnonKey") || "").trim();
    const supabaseHouseholdId = String(form.get("supabaseHouseholdId") || "").trim();

    await updateSettings({
      supabaseUrl,
      supabaseAnonKey,
      supabaseHouseholdId,
      syncEnabled: Boolean(supabaseUrl && supabaseAnonKey && supabaseHouseholdId),
      lastSyncMessage: "Sync setup saved."
    });

    await initSupabase();
    render();
    showToast("Sync setup saved.");
  }

  async function saveAccessCode(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const accessCode = String(form.get("accessCode") || "").trim();
    if (accessCode.length < 10) {
      showToast("Enter Sawyer's household access code.");
      return;
    }

    try {
      const hash = await sha256Hex(accessCode);
      writeHouseholdAccessHash(hash);
      await initSupabase();
      await syncWithSupabase({ silent: true, throwOnError: true });
      await updateSettings({
        currentUserEmail: "",
        pendingLoginEmail: "",
        emergencyLocalMode: false,
        lastSyncMessage: "Household access saved. Supabase is connected."
      });
      render();
      showToast("Supabase connected.");
    } catch (error) {
      writeHouseholdAccessHash("");
      state.syncMessage = error.message || "That household access code did not work.";
      await updateSettings({ lastSyncMessage: state.syncMessage });
      render();
      showToast(state.syncMessage);
    }
  }

  async function signOut() {
    try {
      const client = state.supabaseClient || (await initSupabase());
      if (client) await client.auth.signOut();
      writeHouseholdAccessHash("");
      state.supabaseSession = null;
      await updateSettings({
        currentUserEmail: "",
        pendingLoginEmail: "",
        emergencyLocalMode: false,
        lastSyncMessage: "Household access removed from this device."
      });
      render();
      showToast("Household access removed.");
    } catch (error) {
      state.syncMessage = error.message || "Could not sign out.";
      render();
    }
  }

  async function generateAiInsights() {
    if (state.aiBusy) return;

    try {
      if (!hasSupabaseConfig()) throw new Error("Supabase sync needs to be configured first.");
      if (!isSignedIn()) throw new Error("Connect Supabase so AI can review the shared records.");
      if (!navigator.onLine) throw new Error("You need to be online to run AI review.");

      state.aiBusy = true;
      state.aiError = "";
      render();

      await syncWithSupabase({ silent: true });
      const client = state.supabaseClient || (await initSupabase());
      if (!client) throw new Error("Supabase is not available.");

      const { data, error } = await client.functions.invoke("sawyer-ai-insights", {
        headers: state.householdAccessHash ? { [ACCESS_HEADER]: state.householdAccessHash } : {},
        body: {
          householdId: state.settings.supabaseHouseholdId,
          dogName: state.profile?.name || "Sawyer"
        }
      });
      if (error) throw error;

      state.aiInsight = normalizeAiInsight(data);
      state.aiError = "";
      showToast("AI review updated.");
    } catch (error) {
      state.aiError = error.message || "AI review failed.";
      showToast(state.aiError);
    } finally {
      state.aiBusy = false;
      render();
    }
  }

  function normalizeAiInsight(data) {
    const fallback = {
      title: "AI review",
      summary: "No AI response was returned.",
      bullets: [],
      questions: []
    };
    if (!data || typeof data !== "object") return fallback;

    return {
      title: String(data.title || fallback.title),
      summary: String(data.summary || fallback.summary),
      provider: String(data.provider || ""),
      bullets: Array.isArray(data.bullets)
        ? data.bullets.slice(0, 6).map((item) => ({
            title: String(item?.title || "Observation"),
            detail: String(item?.detail || item?.body || "")
          }))
        : [],
      questions: Array.isArray(data.questions)
        ? data.questions.slice(0, 6).map((item) => String(item))
        : []
    };
  }

  function queueBackgroundSync() {
    if (!state.settings?.syncEnabled || !isSignedIn() || !navigator.onLine) return;
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => {
      syncWithSupabase({ silent: true }).catch(() => {});
    }, 1500);
  }

  async function syncWithSupabase(options = {}) {
    if (state.syncBusy) return;
    const silent = Boolean(options.silent);

    try {
      if (!navigator.onLine) throw new Error("You are offline. Supabase will update when this device is online.");
      if (!hasSupabaseConfig()) throw new Error("Add Supabase settings first.");

      state.syncBusy = true;
      state.syncMessage = "Syncing this device with Supabase...";
      if (!silent) render();

      const client = await requireSupabaseSession();
      const householdId = state.settings.supabaseHouseholdId;

      const dogResult = await syncStore({
        client,
        householdId,
        storeName: "profile",
        tableName: SUPABASE_TABLES.dogs,
        localRecords: [await dbGet("profile", DOG_ID)].filter(Boolean)
      });
      const scheduleResult = await syncStore({
        client,
        householdId,
        storeName: "schedules",
        tableName: SUPABASE_TABLES.schedules,
        localRecords: await dbGetAll("schedules")
      });
      const eventResult = await syncStore({
        client,
        householdId,
        storeName: "events",
        tableName: SUPABASE_TABLES.events,
        localRecords: await dbGetAll("events")
      });

      let uploaded = dogResult.uploaded + scheduleResult.uploaded + eventResult.uploaded;
      let downloaded = dogResult.downloaded + scheduleResult.downloaded + eventResult.downloaded;

      await hydrate();
      const clusterUpdates = await refreshAutomaticClusterFlags();
      if (clusterUpdates) {
        const clusterResult = await syncStore({
          client,
          householdId,
          storeName: "events",
          tableName: SUPABASE_TABLES.events,
          localRecords: await dbGetAll("events")
        });
        uploaded += clusterResult.uploaded;
        downloaded += clusterResult.downloaded;
      }

      const message = `Synced ${uploaded} up and ${downloaded} down.`;

      await updateSettings({
        syncEnabled: true,
        currentUserEmail: state.supabaseSession?.user?.email || "",
        lastSyncAt: nowIso(),
        lastSyncMessage: message
      });
      await hydrate();
      await initSupabase();
      state.syncMessage = message;
      if (!silent) showToast(message);
    } catch (error) {
      state.syncMessage = error.message || "Sync failed.";
      if (!silent) showToast(state.syncMessage);
      if (options.throwOnError) throw error;
    } finally {
      state.syncBusy = false;
      if (!silent) render();
    }
  }

  async function syncStore({ client, householdId, storeName, tableName, localRecords }) {
    const { data: remoteRows, error: selectError } = await client
      .from(tableName)
      .select("id,dog_id,payload,updated_at,deleted_at")
      .eq("household_id", householdId);
    if (selectError) throw selectError;

    const remoteMap = new Map((remoteRows || []).map((row) => [row.id, row]));
    let downloaded = 0;

    for (const row of remoteRows || []) {
      const local = localRecords.find((record) => record?.id === row.id);
      const remoteRecord = remotePayloadToLocal(row);
      if (!local || isNewer(remoteRecord, local) || shouldPreferRemoteSeed(storeName, local, remoteRecord)) {
        await dbPut(storeName, remoteRecord);
        downloaded += 1;
      }
    }

    const refreshedLocalRecords =
      storeName === "profile"
        ? [await dbGet("profile", DOG_ID)].filter(Boolean)
        : await dbGetAll(storeName);
    const uploads = refreshedLocalRecords.filter((record) => {
      const remote = remoteMap.get(record.id);
      if (!remote) return true;
      if (shouldPreferRemoteSeed(storeName, record, remotePayloadToLocal(remote))) return false;
      return isNewer(record, remotePayloadToLocal(remote));
    });

    if (uploads.length) {
      const rows = uploads.map((record) => localToRemoteRow(householdId, record));
      const { error: upsertError } = await client
        .from(tableName)
        .upsert(rows, { onConflict: "household_id,id" });
      if (upsertError) throw upsertError;

      await dbBulkPut(
        storeName,
        uploads.map((record) => ({
          ...record,
          syncStatus: "synced"
        }))
      );
    }

    return { uploaded: uploads.length, downloaded };
  }

  function localToRemoteRow(householdId, record) {
    const updatedAt = record.updatedAt || record.createdAt || nowIso();
    const payload = {
      ...record,
      syncStatus: "synced",
      updatedAt
    };

    return {
      household_id: householdId,
      id: record.id,
      dog_id: record.dogId || (record.id === DOG_ID ? record.id : DOG_ID),
      payload,
      updated_at: updatedAt,
      deleted_at: record.deletedAt || null
    };
  }

  function remotePayloadToLocal(row) {
    const payload = row.payload || {};
    return {
      ...payload,
      id: payload.id || row.id,
      dogId: payload.dogId || row.dog_id || DOG_ID,
      updatedAt: payload.updatedAt || row.updated_at || nowIso(),
      deletedAt: payload.deletedAt || row.deleted_at || null,
      syncStatus: "synced"
    };
  }

  function isNewer(a, b) {
    return new Date(recordUpdatedAt(a)).getTime() > new Date(recordUpdatedAt(b)).getTime();
  }

  function shouldPreferRemoteSeed(storeName, local, remote) {
    if (state.settings?.lastSyncAt || !local || !remote) return false;
    if (storeName === "profile") {
      return local.name === DEFAULT_PROFILE.name && remote.name && remote.name !== local.name;
    }
    if (storeName !== "schedules") return false;

    return isDefaultSchedule(local) && !recordsEquivalent(local, remote);
  }

  function isDefaultSchedule(record) {
    const seed = DEFAULT_SCHEDULES.find((schedule) => schedule.id === record.id);
    if (!seed) return false;

    return (
      record.kind === seed.kind &&
      record.name === seed.name &&
      !record.dose &&
      !record.unit &&
      JSON.stringify(record.times || []) === JSON.stringify(seed.times || [])
    );
  }

  function recordsEquivalent(a, b) {
    const comparableA = { ...a };
    const comparableB = { ...b };
    ["createdAt", "updatedAt", "syncStatus", "deletedAt"].forEach((key) => {
      delete comparableA[key];
      delete comparableB[key];
    });
    return JSON.stringify(comparableA) === JSON.stringify(comparableB);
  }

  function recordUpdatedAt(record) {
    return record.updatedAt || record.updated_at || record.createdAt || "1970-01-01T00:00:00.000Z";
  }

  function startTimer() {
    if (!state.timerStartedAt) {
      state.timerStartedAt = Date.now();
    }
    if (state.activeTab !== "log") state.activeTab = "log";
    render();
    ensureTimerTick();
  }

  function stopTimer() {
    const seconds = getTimerSeconds();
    state.timerStartedAt = null;
    clearInterval(state.timerTick);
    state.timerTick = null;
    render();
    const minutesInput = document.querySelector("#duration-minutes");
    const secondsInput = document.querySelector("#duration-seconds");
    if (minutesInput) minutesInput.value = String(Math.floor(seconds / 60));
    if (secondsInput) secondsInput.value = String(seconds % 60);
  }

  function resetTimer(shouldRender = true) {
    state.timerStartedAt = null;
    clearInterval(state.timerTick);
    state.timerTick = null;
    if (shouldRender) render();
  }

  function ensureTimerTick() {
    if (state.timerTick) clearInterval(state.timerTick);
    if (!state.timerStartedAt) return;
    state.timerTick = setInterval(updateTimerFace, 1000);
  }

  function updateTimerFace() {
    const face = document.querySelector("#timer-face");
    if (face) face.textContent = formatDuration(getTimerSeconds());
  }

  function getTimerSeconds() {
    if (!state.timerStartedAt) return 0;
    return Math.max(0, Math.floor((Date.now() - state.timerStartedAt) / 1000));
  }

  async function installApp() {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice.catch(() => null);
    state.installPrompt = null;
    render();
  }

  async function enableReminders() {
    if (!("Notification" in window)) {
      showToast("Notifications are not supported in this browser.");
      return;
    }

    const permission = await Notification.requestPermission();
    const timestamp = nowIso();
    await dbPut("settings", {
      ...state.settings,
      remindersEnabled: permission === "granted",
      updatedAt: timestamp,
      syncStatus: "local"
    });
    await hydrate();
    render();
    showToast(permission === "granted" ? "Reminders enabled." : "Notification permission was not granted.");
  }

  async function disableReminders() {
    const timestamp = nowIso();
    await dbPut("settings", {
      ...state.settings,
      remindersEnabled: false,
      updatedAt: timestamp,
      syncStatus: "local"
    });
    await hydrate();
    render();
    showToast("Reminders disabled.");
  }

  function startReminderLoop() {
    checkReminders();
    setInterval(checkReminders, 60 * 1000);
  }

  function checkReminders() {
    if (!state.settings?.remindersEnabled || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    const now = new Date();
    getTodayDoseEntries().forEach((entry) => {
      if (entry.log) return;
      const minutesUntilDue = Math.round((entry.dueAt - now) / 60000);
      const isInReminderWindow =
        minutesUntilDue <= state.settings.reminderLeadMinutes &&
        minutesUntilDue >= -REMINDER_WINDOW_MINUTES;
      if (!isInReminderWindow) return;

      const reminderKey = `reminded:${entry.key}:${localDateKey(now)}`;
      if (localStorage.getItem(reminderKey)) return;
      localStorage.setItem(reminderKey, nowIso());

      new Notification(`${entry.schedule.name} for ${state.profile?.name || "Sawyer"}`, {
        body: `${entry.time.label} dose is due at ${formatTime(entry.dueAt)}.`,
        icon: "./icon.svg",
        tag: entry.key
      });
    });

    checkMilestoneNotifications();
  }

  function checkMilestoneNotifications() {
    const seizures = getSeizuresAsc();
    const last = seizures.at(-1);
    if (!last) return;

    const days = Math.floor((startOfDay(new Date()) - startOfDay(new Date(last.occurredAt))) / 86400000);
    const milestones = [7, 14, 30, 60, 90, 120, 180, 365];
    if (!milestones.includes(days)) return;

    const key = `milestone:${last.id}:${days}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, nowIso());

    new Notification(`${state.profile?.name || "Sawyer"} milestone`, {
      body: `${days} days since the last logged seizure.`,
      icon: "./icon.svg",
      tag: key
    });
  }

  function getTodayDoseEntries(date = new Date()) {
    const dayKey = localDateKey(date);
    return state.schedules
      .filter((schedule) => schedule.active)
      .flatMap((schedule) =>
        schedule.times.map((time) => {
          const dueAt = localTimeToDate(dayKey, time.time);
          const key = `${dayKey}:${schedule.id}:${time.id}`;
          const log = state.events.find((event) => event.type === "dose" && event.doseKey === key);
          const status = log?.status || "assumed";
          const pillClass =
            status === "given"
              ? "given"
              : status === "missed"
                ? "missed"
                : status === "skipped"
                  ? "skipped"
                  : "assumed";
          const statusText =
            status === "given"
              ? "Given"
              : status === "missed"
                ? "Missed"
                : status === "skipped"
                  ? "Skipped"
                  : "Assumed";
          const doseText = [schedule.dose, schedule.unit].filter(Boolean).join(" ");

          return {
            key,
            schedule,
            time,
            log,
            status,
            dueAt,
            shortLabel: `${schedule.name} ${time.label}`,
            pillClass,
            statusText,
            doseText
          };
        })
      )
      .sort((a, b) => a.dueAt - b.dueAt || a.schedule.name.localeCompare(b.schedule.name));
  }

  function getNextDueEntry(entries) {
    const now = new Date();
    return (
      entries.find((entry) => !entry.log && entry.dueAt >= now) ||
      null
    );
  }

  function dayKeyToDate(dayKey) {
    return localTimeToDate(dayKey || localDateKey(new Date()), "00:00");
  }

  function eventsForDay(dayKey) {
    return state.events
      .filter((event) => eventDayKey(event) === dayKey)
      .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  }

  function eventDayKey(event) {
    if (event.dayKey) return event.dayKey;
    return localDateKey(new Date(event.occurredAt || nowIso()));
  }

  function getSeizuresAsc() {
    return state.events
      .filter((event) => event.type === "seizure")
      .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  }

  function automaticClusterIds(seizures) {
    const ids = new Set();
    const active = seizures
      .filter((event) => event.type === "seizure" && !event.deletedAt)
      .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));

    for (let firstIndex = 0; firstIndex < active.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < active.length; secondIndex += 1) {
        const first = active[firstIndex];
        const second = active[secondIndex];
        if (seizuresShareClusterWindow(first, second)) {
          ids.add(first.id);
          ids.add(second.id);
        }

        if (
          first.timeKnown !== false &&
          second.timeKnown !== false &&
          new Date(second.occurredAt).getTime() - new Date(first.occurredAt).getTime() >= CLUSTER_WINDOW_MS
        ) {
          break;
        }
      }
    }

    return ids;
  }

  function seizuresShareClusterWindow(first, second) {
    if (first.timeKnown === false || second.timeKnown === false) {
      return eventDayKey(first) === eventDayKey(second);
    }
    const difference = Math.abs(new Date(second.occurredAt).getTime() - new Date(first.occurredAt).getTime());
    return difference < CLUSTER_WINDOW_MS;
  }

  function isAutomaticCluster(event, seizures = state.events) {
    if (!event || event.type !== "seizure") return false;
    return automaticClusterIds(seizures).has(event.id);
  }

  async function refreshAutomaticClusterFlags() {
    const records = await dbGetAll("events");
    const clusteredIds = automaticClusterIds(records);
    const timestamp = nowIso();
    const updates = records
      .filter((record) => record.type === "seizure" && !record.deletedAt)
      .filter(
        (record) =>
          Boolean(record.cluster) !== clusteredIds.has(record.id) ||
          record.clusterSource !== "automatic"
      )
      .map((record) => ({
        ...record,
        cluster: clusteredIds.has(record.id),
        clusterSource: "automatic",
        updatedAt: timestamp,
        syncStatus: "local"
      }));

    if (updates.length) await dbBulkPut("events", updates);
    return updates.length;
  }

  function getSummary() {
    const seizures = getSeizuresAsc();
    const now = new Date();
    const last = seizures.at(-1);
    const gaps = getSeizureGaps(seizures);
    const durations = seizures.map((event) => event.durationSeconds || 0).filter(Boolean);
    const monthKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const thisMonthSeizures = seizures.filter((event) => eventDayKey(event).startsWith(monthKey)).length;

    const daysSinceLast = last ? Math.floor((startOfDay(now) - startOfDay(new Date(last.occurredAt))) / 86400000) : null;
    const longestGap = gaps.length ? Math.max(...gaps.map((gap) => gap.days)) : null;
    const averageGap = gaps.length ? mean(gaps.map((gap) => gap.days)) : null;
    const averageDuration = durations.length ? mean(durations) : null;

    return {
      totalSeizures: seizures.length,
      daysSinceLast,
      lastSeizureText: last ? `Last seizure: ${formatEventDateTime(last)}` : "No seizure logged yet",
      averageGapText: averageGap ? `${round1(averageGap)} days` : "--",
      longestGapText: longestGap ? `${round1(longestGap)} days` : "--",
      averageDurationText: averageDuration ? formatDuration(Math.round(averageDuration)) : "--",
      thisMonthSeizures
    };
  }

  function getSeizureGaps(seizures) {
    const gaps = [];
    for (let index = 1; index < seizures.length; index += 1) {
      const previous = new Date(seizures[index - 1].occurredAt);
      const current = new Date(seizures[index].occurredAt);
      gaps.push({
        from: seizures[index - 1],
        to: seizures[index],
        days: (current - previous) / 86400000
      });
    }
    return gaps;
  }

  function buildInsights(summary) {
    const seizures = getSeizuresAsc();
    const gaps = getSeizureGaps(seizures);
    const latestVet = latestEventOfType("vet_visit");
    const latestBlood = latestEventOfType("blood_test");
    const insights = [];

    if (!seizures.length) {
      insights.push({
        title: "Baseline",
        body: "Once seizures are logged, patterns will appear here as observations over time."
      });
      if (latestVet) {
        insights.push({
          title: "Latest vet visit",
          body: `${eventTitle(latestVet)} was logged on ${formatDateShort(new Date(latestVet.occurredAt))}.`
        });
      }
      if (latestBlood) {
        insights.push({
          title: "Latest blood test",
          body: `${eventTitle(latestBlood)} was logged on ${formatDateShort(new Date(latestBlood.occurredAt))}.`
        });
      }
      return insights;
    }

    const latestSeizure = seizures.at(-1);
    const latestCluster = seizures.filter(
      (seizure) =>
        seizure.id === latestSeizure.id ||
        seizuresShareClusterWindow(latestSeizure, seizure)
    );
    if (latestCluster.length > 1) {
      const clusterIsCurrent =
        latestSeizure.timeKnown === false
          ? eventDayKey(latestSeizure) === localDateKey(new Date())
          : Date.now() - new Date(latestSeizure.occurredAt).getTime() < CLUSTER_WINDOW_MS;
      insights.push({
        title: clusterIsCurrent ? "Cluster pattern detected" : "Last cluster pattern",
        body: clusterIsCurrent
          ? `${latestCluster.length} seizures were logged within the same 24-hour window. Follow Sawyer's emergency plan and contact his veterinary team.`
          : `${latestCluster.length} seizures were logged within 24 hours of each other, ending ${formatDateShort(new Date(latestSeizure.occurredAt))}.`
      });
    }

    const milestone = nextMilestone(summary.daysSinceLast || 0);
    insights.push({
      title: milestone.reached ? "Milestone reached" : "Next milestone",
      body: milestone.reached
        ? `${state.profile?.name || "Sawyer"} has reached ${milestone.value} days since the last logged seizure.`
        : `${milestone.value - (summary.daysSinceLast || 0)} days until the next ${milestone.value}-day seizure-free milestone.`
    });

    if (gaps.length >= 2) {
      const recent = gaps.at(-1).days;
      const previousAverage = mean(gaps.slice(0, -1).map((gap) => gap.days));
      const direction = recent >= previousAverage ? "farther apart" : "closer together";
      insights.push({
        title: "Recent spacing",
        body: `The latest seizure gap was ${round1(recent)} days. Previous gaps averaged ${round1(previousAverage)} days, so the latest logged gap is ${direction}.`
      });
    }

    const missedNearSeizures = countSeizuresNearMissedDose(seizures);
    if (missedNearSeizures.total > 0) {
      insights.push({
        title: "Dose timing context",
        body: `${missedNearSeizures.total} logged seizure${missedNearSeizures.total === 1 ? "" : "s"} occurred within 24 hours after a missed or late dose record.`
      });
    }

    const mctInsight = buildMctInsight(seizures, gaps);
    if (mctInsight) insights.push(mctInsight);

    const timeBucket = mostCommonSeizureTime(seizures);
    if (timeBucket) {
      insights.push({
        title: "Time of day",
        body: `${timeBucket.label} is the most common logged window so far, with ${timeBucket.count} seizure${timeBucket.count === 1 ? "" : "s"}.`
      });
    }

    if (latestBlood) {
      const levels = [
        latestBlood.phenobarbitalLevel ? `phenobarbital ${latestBlood.phenobarbitalLevel}` : "",
        latestBlood.bromideLevel ? `bromide ${latestBlood.bromideLevel}` : ""
      ].filter(Boolean);
      insights.push({
        title: "Latest blood test",
        body: `${latestBlood.panel || "Blood test"} was logged on ${formatDateShort(new Date(latestBlood.occurredAt))}${levels.length ? ` with ${levels.join(" and ")}.` : "."}`
      });
    }

    if (latestVet) {
      insights.push({
        title: "Latest vet visit",
        body: `${latestVet.reason || "Vet visit"} was logged on ${formatDateShort(new Date(latestVet.occurredAt))}${latestVet.plan ? ` with plan notes saved.` : "."}`
      });
    }

    insights.push({
      title: "Vet wording",
      body: "These are tracking observations only. Use them as notes for your vet, not as medical conclusions."
    });

    return insights;
  }

  function buildHomeInsight(summary) {
    const insights = buildInsights(summary).filter((insight) => insight.title !== "Vet wording");
    const latestBlood = latestEventOfType("blood_test");
    const latestVet = latestEventOfType("vet_visit");
    const clusterInsight = insights.find((insight) => insight.title === "Cluster pattern detected");

    if (clusterInsight) return clusterInsight;

    if (latestBlood?.phenobarbitalLevel || latestBlood?.bromideLevel) {
      const levels = [
        latestBlood.phenobarbitalLevel ? `phenobarbital ${latestBlood.phenobarbitalLevel}` : "",
        latestBlood.bromideLevel ? `bromide ${latestBlood.bromideLevel}` : ""
      ].filter(Boolean);
      return {
        title: "Blood result saved",
        body: `${latestBlood.panel || "Latest blood test"} includes ${levels.join(" and ")}. Compare this with future seizure spacing in Stats.`
      };
    }

    if (latestBlood) {
      return {
        title: "Blood test logged",
        body: `${latestBlood.panel || "Latest blood test"} is saved from ${formatDateShort(new Date(latestBlood.occurredAt))}. Add future results to compare against seizure spacing.`
      };
    }

    if (latestVet) {
      return {
        title: "Vet visit logged",
        body: `${latestVet.reason || "Latest vet visit"} is saved from ${formatDateShort(new Date(latestVet.occurredAt))}${latestVet.plan ? " with plan notes attached." : "."}`
      };
    }

    return insights[0] || {
      title: "Start building a pattern",
      body: `${state.profile?.name || "Sawyer"}'s medication plan is tracked automatically. Add seizure, vet, and blood-test records as they happen.`
    };
  }

  function latestEventOfType(type) {
    return state.events
      .filter((event) => event.type === type)
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0] || null;
  }

  function nextMilestone(days) {
    const milestones = [7, 14, 30, 60, 90, 120, 180, 365];
    const reached = milestones.filter((value) => days >= value).at(-1);
    if (reached) return { value: reached, reached: true };
    return { value: milestones.find((value) => days < value) || 365, reached: false };
  }

  function countSeizuresNearMissedDose(seizures) {
    const doseEvents = state.events.filter((event) => event.type === "dose");
    let total = 0;

    seizures.filter((seizure) => seizure.timeKnown !== false).forEach((seizure) => {
      const seizureTime = new Date(seizure.occurredAt).getTime();
      const nearby = doseEvents.some((dose) => {
        const dueAt = new Date(dose.dueAt || dose.occurredAt).getTime();
        const occurredAt = new Date(dose.occurredAt).getTime();
        const wasLate = dose.status === "given" && occurredAt - dueAt > OVERDUE_MINUTES * 60000;
        const wasMissed = dose.status === "missed";
        return (wasLate || wasMissed) && seizureTime - dueAt >= 0 && seizureTime - dueAt <= 86400000;
      });
      if (nearby) total += 1;
    });

    return { total };
  }

  function buildMctInsight(seizures, gaps) {
    const firstMct = state.events
      .filter((event) => event.type === "dose" && event.scheduleId === "supp-mct-c8-c10" && event.status === "given")
      .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt))[0];

    if (!firstMct || gaps.length < 3) return null;

    const firstMctTime = new Date(firstMct.occurredAt).getTime();
    const before = gaps.filter((gap) => new Date(gap.to.occurredAt).getTime() < firstMctTime).map((gap) => gap.days);
    const after = gaps.filter((gap) => new Date(gap.from.occurredAt).getTime() >= firstMctTime).map((gap) => gap.days);

    if (before.length < 1 || after.length < 1) return null;

    const beforeAvg = mean(before);
    const afterAvg = mean(after);
    const direction = afterAvg >= beforeAvg ? "longer" : "shorter";

    return {
      title: "MCT oil context",
      body: `Logged seizure gaps average ${round1(beforeAvg)} days before the first MCT oil record and ${round1(afterAvg)} days after. The after-MCT logged gaps are ${direction} so far.`
    };
  }

  function mostCommonSeizureTime(seizures) {
    const buckets = [
      { label: "Overnight", start: 0, end: 6, count: 0 },
      { label: "Morning", start: 6, end: 12, count: 0 },
      { label: "Afternoon", start: 12, end: 18, count: 0 },
      { label: "Evening", start: 18, end: 24, count: 0 }
    ];

    seizures.filter((seizure) => seizure.timeKnown !== false).forEach((seizure) => {
      const hour = new Date(seizure.occurredAt).getHours();
      const bucket = buckets.find((item) => hour >= item.start && hour < item.end);
      if (bucket) bucket.count += 1;
    });

    const winner = buckets.sort((a, b) => b.count - a.count)[0];
    return winner.count ? winner : null;
  }

  function getMonthlySeizureCounts() {
    const now = new Date();
    const months = [];

    for (let index = 5; index >= 0; index -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
      const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
      months.push({
        key,
        label: date.toLocaleDateString(undefined, { month: "short" }),
        count: state.events.filter((event) => event.type === "seizure" && eventDayKey(event).startsWith(key)).length
      });
    }

    return months;
  }

  function filteredTimelineEvents() {
    return state.events
      .filter((event) => state.timelineFilter === "all" || event.type === state.timelineFilter)
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  }

  function eventTitle(event) {
    if (event.type === "seizure") return `Seizure · severity ${event.severity || "--"}`;
    if (event.type === "dose") return `${capitalize(event.status || "dose")} · ${event.medicationName || "Dose"}`;
    if (event.type === "note") return event.title || "Care note";
    if (event.type === "vet_visit") return `Vet visit · ${event.reason || event.clinic || "Checkup"}`;
    if (event.type === "blood_test") return `Blood test · ${event.panel || "Results"}`;
    return capitalize(event.type || "Record");
  }

  function eventDetail(event) {
    if (event.type === "seizure") {
      const parts = [
        event.durationSeconds ? `Duration: ${formatDuration(event.durationSeconds)}` : "",
        isAutomaticCluster(event) ? "Cluster pattern: another seizure was logged within 24 hours" : "",
        event.trigger ? `Trigger: ${event.trigger}` : "",
        event.symptoms?.length ? `Symptoms: ${event.symptoms.join(", ")}` : "",
        event.rescue ? `Care: ${event.rescue}` : "",
        event.recovery ? `Recovery: ${event.recovery}` : "",
        event.notes ? `Notes: ${event.notes}` : ""
      ].filter(Boolean);
      return parts.map((part) => `<p class="subtle">${escapeHtml(part)}</p>`).join("");
    }

    if (event.type === "dose") {
      const dose = [event.dose, event.unit].filter(Boolean).join(" ");
      const due = event.dueAt ? `Due ${formatTime(new Date(event.dueAt))}` : "";
      return `<p class="subtle">${escapeHtml([event.label, dose, due].filter(Boolean).join(" · "))}</p>`;
    }

    if (event.type === "note") {
      return `<p class="subtle">${escapeHtml(event.body || "")}</p>`;
    }

    if (event.type === "vet_visit") {
      const parts = [
        event.clinic ? `Clinic/vet: ${event.clinic}` : "",
        event.weight ? `Weight: ${event.weight}` : "",
        event.plan ? `Plan: ${event.plan}` : ""
      ].filter(Boolean);
      return parts.map((part) => `<p class="subtle">${escapeHtml(part)}</p>`).join("");
    }

    if (event.type === "blood_test") {
      const parts = [
        event.phenobarbitalLevel ? `Phenobarbital: ${event.phenobarbitalLevel}` : "",
        event.bromideLevel ? `Bromide: ${event.bromideLevel}` : "",
        event.results ? `Results: ${event.results}` : "",
        event.notes ? `Notes: ${event.notes}` : ""
      ].filter(Boolean);
      return parts.map((part) => `<p class="subtle">${escapeHtml(part)}</p>`).join("");
    }

    return "";
  }

  function exportJson() {
    const payload = {
      app: "sawyer-tracker",
      version: 1,
      exportedAt: nowIso(),
      profile: state.profile,
      settings: state.settings,
      schedules: state.schedules,
      events: state.events
    };

    downloadBlob(
      JSON.stringify(payload, null, 2),
      `sawyer-tracker-backup-${localDateKey(new Date())}.json`,
      "application/json"
    );

    dbPut("settings", {
      ...state.settings,
      lastBackupAt: nowIso(),
      updatedAt: nowIso(),
      syncStatus: "local"
    }).then(hydrate);
    showToast("Backup exported.");
  }

  function importJson() {
    const template = document.querySelector("#file-input-template");
    const input = template.content.firstElementChild.cloneNode();
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data.app !== "sawyer-tracker") throw new Error("Invalid backup");

        await dbClear("profile");
        await dbClear("settings");
        await dbClear("schedules");
        await dbClear("events");
        await dbPut("profile", { ...data.profile, syncStatus: "local" });
        await dbPut("settings", { ...DEFAULT_SETTINGS, ...(data.settings || {}), syncStatus: "local" });
        await dbBulkPut("schedules", (data.schedules || []).map((item) => ({ ...item, syncStatus: "local" })));
        await dbBulkPut("events", (data.events || []).map((item) => ({ ...item, syncStatus: "local" })));
        await hydrate();
        render();
        showToast("Backup imported.");
      } catch (error) {
        showToast("That backup could not be imported.");
      }
    });
    input.click();
  }

  function exportCsv() {
    const headers = [
      "type",
      "date_time",
      "time_recorded",
      "cluster_detected",
      "name",
      "status",
      "severity",
      "duration_seconds",
      "trigger",
      "symptoms",
      "clinic",
      "weight",
      "panel",
      "phenobarbital_level",
      "bromide_level",
      "results",
      "notes"
    ];

    const rows = state.events
      .slice()
      .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt))
      .map((event) => [
        event.type,
        event.type === "seizure" && event.timeKnown === false ? eventDayKey(event) : event.occurredAt,
        event.type === "seizure" ? event.timeKnown !== false : "",
        event.type === "seizure" ? isAutomaticCluster(event) : "",
        event.medicationName || event.title || "",
        event.status || "",
        event.severity || "",
        event.durationSeconds || "",
        event.trigger || "",
        (event.symptoms || []).join("; "),
        event.clinic || "",
        event.weight || "",
        event.panel || "",
        event.phenobarbitalLevel || "",
        event.bromideLevel || "",
        event.results || "",
        event.notes || event.body || event.recovery || event.plan || ""
      ]);

    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    downloadBlob(csv, `sawyer-tracker-events-${localDateKey(new Date())}.csv`, "text/csv");
    showToast("CSV exported.");
  }

  async function resetData() {
    if (!confirm("Clear Sawyer Tracker's browser cache on this device? Supabase records are not deleted.")) {
      return;
    }

    await dbClear("events");
    await dbClear("schedules");
    await dbClear("profile");
    await dbClear("settings");
    await hydrate();
    state.activeTab = "today";
    render();
    showToast("Device cache cleared.");
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function localTimeToDate(dayKey, time) {
    return new Date(`${dayKey}T${time || "00:00"}:00`);
  }

  function localDateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function toDateInputValue(date) {
    return localDateKey(date);
  }

  function toTimeInputValue(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function renderTimeInput(id, name, value, required = false) {
    return `
      <div class="time-input-shell">
        <span class="time-input-value" aria-hidden="true">${escapeHtml(formatTimeInputValue(value))}</span>
        <input id="${escapeHtml(id)}" name="${escapeHtml(name)}" type="time" value="${escapeHtml(value)}" ${required ? "required" : ""} />
      </div>
    `;
  }

  function renderDateInput(id, name, value, required = false) {
    return `
      <div class="date-input-shell">
        <span class="date-input-value" aria-hidden="true">${escapeHtml(formatDateInputValue(value))}</span>
        <input id="${escapeHtml(id)}" name="${escapeHtml(name)}" type="date" value="${escapeHtml(value)}" ${required ? "required" : ""} />
      </div>
    `;
  }

  function formatDateInputValue(value) {
    const [year, month, day] = String(value || "").split("-").map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return "Select date";
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric"
    });
  }

  function formatTimeInputValue(value) {
    const [hours, minutes] = String(value || "").split(":").map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return "Select time";
    return formatTime(new Date(2000, 0, 1, hours, minutes));
  }

  function formatDateShort(date) {
    return date.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric"
    });
  }

  function formatWelcomeDate(date) {
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric"
    });
  }

  function formatDateTime(date) {
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function formatEventDateTime(event) {
    const date = new Date(event.occurredAt);
    if (event.type === "seizure" && event.timeKnown === false) {
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric"
      });
    }
    return formatDateTime(date);
  }

  function formatEventTime(event) {
    if (event.type === "seizure" && event.timeKnown === false) return "Time not recorded";
    return formatTime(new Date(event.occurredAt));
  }

  function formatTime(date) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function formatDuration(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safe / 60);
    const remainder = safe % 60;
    return `${pad(minutes)}:${pad(remainder)}`;
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function capitalize(value) {
    const text = String(value || "");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function csvCell(value) {
    const text = String(value ?? "");
    return `"${text.replaceAll('"', '""')}"`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function showToast(message) {
    const toast = document.querySelector("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }
})();
