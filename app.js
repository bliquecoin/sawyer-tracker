(function () {
  "use strict";

  const DB_NAME = "sawyer-care-tracker";
  const DB_VERSION = 1;
  const DOG_ID = "sawyer";
  const REMINDER_WINDOW_MINUTES = 15;
  const OVERDUE_MINUTES = 45;
  const CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;
  const HISTORY_PAGE_SIZE = 30;
  const SYNC_PAGE_SIZE = 500;
  const SYNC_UPLOAD_BATCH_SIZE = 200;
  const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0";
  const FFLATE_JS_URL = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js";
  const FALLBACK_APP_URL = "https://bliquecoin.github.io/sawyer-tracker/";
  const ACCESS_KEY_STORAGE = "sawyer-household-access-key-hash";
  const ACCESS_HEADER = "x-sawyer-access-key";
  const SUPABASE_TABLES = {
    dogs: "sawyer_dogs",
    schedules: "sawyer_care_schedules",
    events: "sawyer_care_events",
    documents: "sawyer_vet_documents"
  };
  const VET_DOCUMENT_BUCKET = "sawyer-vet-documents";
  const MAX_VET_DOCUMENT_BYTES = 20 * 1024 * 1024;
  const VET_DOCUMENT_CATEGORIES = [
    { id: "visit_summary", label: "Visit summary" },
    { id: "lab_results", label: "Lab results" },
    { id: "prescription", label: "Prescription" },
    { id: "imaging", label: "Imaging report" },
    { id: "insurance", label: "Insurance" },
    { id: "other", label: "Other" }
  ];
  const app = document.querySelector("#app");
  const externalConfig = window.SAWYER_SUPABASE_CONFIG || {};
  const CORE = window.SawyerTrackerCore;
  if (!CORE) throw new Error("Sawyer Tracker core could not be loaded.");

  const state = {
    activeTab: "today",
    timelineFilter: "all",
    timelineSearch: "",
    timelineLimit: HISTORY_PAGE_SIZE,
    profile: null,
    schedules: [],
    events: [],
    settings: null,
    toastTimer: null,
    installPrompt: null,
    supabaseClient: null,
    supabaseFingerprint: "",
    supabaseSession: null,
    householdAccessHash: readHouseholdAccessHash(),
    accessVerified: false,
    syncBusy: false,
    syncFlight: CORE.createSingleFlight(),
    syncMessage: "",
    syncTimer: null,
    storageUnavailable: false,
    aiBusy: false,
    aiInsight: null,
    aiError: "",
    homeInsightIndex: 0,
    homeInsightSignature: "",
    homeInsightTimer: null,
    homeTrendRange: "6",
    homeSelectedMonthKey: "",
    statsInsightIndex: 0,
    statsInsightSignature: "",
    statsSelectedMonthKey: "",
    statsRange: "6",
    vetDocuments: [],
    documentsBusy: false,
    documentsMessage: "",
    backupBusy: false,
    backupMessage: "",
    selectedDayKey: localDateKey(new Date()),
    pullDistance: 0,
    pullRefreshing: false,
    editingSeizureId: "",
    editingRecordId: "",
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
      effectiveFrom: "",
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
      effectiveFrom: "",
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
      effectiveFrom: "",
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
    { id: "blood_test", label: "Blood" },
    { id: "regimen_change", label: "Regimen" }
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
    if (state.settings?.syncEnabled && hasStoredAccess() && navigator.onLine) {
      await syncWithSupabase({ silent: true }).catch(() => {});
      if (isSignedIn()) await loadVetDocuments({ silent: true });
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

    window.addEventListener("online", () => {
      queueBackgroundSync();
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
    if (typeof externalConfig.clientFactory === "function") return true;
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

  async function loadFflateLibrary() {
    if (window.fflate?.zipSync && window.fflate?.unzipSync) return window.fflate;

    await new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${FFLATE_JS_URL}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = FFLATE_JS_URL;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Backup tools could not be loaded."));
      document.head.appendChild(script);
    });

    if (!window.fflate?.zipSync || !window.fflate?.unzipSync) {
      throw new Error("Backup tools could not be initialized.");
    }
    return window.fflate;
  }

  async function initSupabase() {
    if (!hasSupabaseConfig()) {
      state.supabaseClient = null;
      state.supabaseFingerprint = "";
      state.supabaseSession = null;
      return null;
    }

    try {
      await loadSupabaseLibrary();
      const fingerprint = [
        state.settings.supabaseUrl,
        state.settings.supabaseAnonKey,
        state.householdAccessHash
      ].join("|");
      if (state.supabaseClient && state.supabaseFingerprint === fingerprint) {
        return state.supabaseClient;
      }

      const createClient = externalConfig.clientFactory || window.supabase.createClient;
      state.supabaseClient = createClient(
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
      state.supabaseFingerprint = fingerprint;

      if (startedFromAuthRedirect) {
        await handleAuthRedirect(state.supabaseClient);
      }

      const { data, error } = await state.supabaseClient.auth.getSession();
      if (error) throw error;
      state.supabaseSession = data.session;
      if (data.session?.user) state.accessVerified = true;
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
          state.accessVerified = Boolean(session?.user);
          if (session?.user?.email) {
            cleanAuthRedirectUrl();
            await updateSettings({
              currentUserEmail: session.user.email,
              pendingLoginEmail: "",
              emergencyLocalMode: false,
              lastSyncMessage: "Supabase connected. Syncing shared records..."
            });
            if (state.settings?.syncEnabled && navigator.onLine) {
              await syncWithSupabase({ silent: true }).catch(() => {});
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

    if (state.householdAccessHash) {
      try {
        await verifyHouseholdAccess(client);
        state.accessVerified = true;
        return client;
      } catch (error) {
        state.accessVerified = false;
        if (/does not match Sawyer's household/i.test(String(error?.message || ""))) {
          writeHouseholdAccessHash("");
        }
        throw error;
      }
    }

    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    state.supabaseSession = data.session;
    if (!data.session) throw new Error("Enter the household access code before syncing.");
    state.accessVerified = true;

    return client;
  }

  async function verifyHouseholdAccess(client) {
    const householdId = state.settings?.supabaseHouseholdId;
    if (!householdId) throw new Error("Sawyer's household is not configured.");

    const { data, error } = await client
      .from("sawyer_households")
      .select("id")
      .eq("id", householdId)
      .limit(1);
    if (error) throw error;
    if (!data?.length) {
      throw new Error("That access code does not match Sawyer's household. Check the code and try again.");
    }
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
    state.accessVerified = false;
    state.supabaseClient = null;
    state.supabaseFingerprint = "";
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
    return Boolean(state.supabaseSession?.user || (state.householdAccessHash && state.accessVerified));
  }

  function hasStoredAccess() {
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
            ${renderToday(summary)}
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
    startHomeInsightRotation();
    centerSelectedDayPill();
  }

  function navButton(tab, label, icon) {
    return `
      <button class="nav-btn ${state.activeTab === tab ? "active" : ""}" data-tab="${tab}" type="button">
        <span aria-hidden="true">${icon}</span>${label}
      </button>
    `;
  }

  function renderToday(summary) {
    const installClass = state.installPrompt ? "panel install-banner ready" : "panel install-banner";
    const now = new Date();
    const streakTone = seizureFreeTone(summary);
    const statusTone = streakTone === "recent-seizure" ? "attention" : streakTone === "no-history" ? "neutral" : "steady";

    return `
      <div class="home-stack">
        <section class="home-hero glass-panel">
          <div class="home-topline">
            <div class="welcome-copy">
              <p class="welcome-date">${escapeHtml(formatWelcomeDate(now))}</p>
              <h1>
                <span>${escapeHtml(timeOfDayGreeting(now))}.</span>
                Here's ${escapeHtml(state.profile?.name || "Sawyer")}'s day.
              </h1>
              <p class="welcome-status ${statusTone}">
                <span aria-hidden="true"></span>
                ${escapeHtml(homeGreeting(summary))}
              </p>
            </div>
            <figure class="sawyer-welcome-art">
              <img
                src="./assets/icons/sawyer-welcome-8bit-v4.png?v=1"
                alt="8-bit portrait of Sawyer surrounded by his favourite treats"
              />
            </figure>
          </div>

          <div class="stat-glass-grid" aria-label="Tracking statistics">
            <article class="stat-card featured milestone-card seizure-free-card ${streakTone}">
              <i class="pixel-sparkle sparkle-one" aria-hidden="true"></i>
              <div class="seizure-free-header">
                <span>Seizure-free</span>
              </div>
              <div class="stat-value-row">
                <strong>${summary.daysSinceLast ?? "--"}</strong>
                ${renderStreakHearts(summary.daysSinceLast)}
              </div>
              <small class="seizure-free-unit">${summary.daysSinceLast === 1 ? "day" : "days"}</small>
              ${renderSeizureFreeProgress(summary.daysSinceLast)}
            </article>
            <article class="stat-card">
              <span>Longest streak</span>
              <strong>${summary.homeLongestGapText}</strong>
              <small>between episodes</small>
            </article>
            <article class="stat-card">
              <span>Average gap</span>
              <strong>${summary.homeAverageGapText}</strong>
              <small>between episodes</small>
            </article>
          </div>

          <button class="seizure-cta" data-tab="log" data-focus-seizure="true" type="button">
            <span>Log Seizure</span>
            <small>${escapeHtml(summary.lastSeizureText)}</small>
          </button>
        </section>

        ${renderSeizureTrend(summary)}

        ${renderHomeInsight(summary)}

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

  function renderStreakHearts(daysSinceLast) {
    if (!Number.isFinite(daysSinceLast)) return "";
    const heartCount = Math.floor(daysSinceLast / 5);
    if (heartCount <= 0) return "";
    const visibleHearts = Math.min(heartCount, 5);
    const label = `${heartCount} seizure-free heart${heartCount === 1 ? "" : "s"} earned. Sawyer receives one heart for every 5 seizure-free days.`;
    return `
      <span class="streak-hearts" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
        ${Array.from({ length: visibleHearts }, (_, index) => `
          <span class="pixel-icon pixel-heart" style="--heart-index: ${index}" aria-hidden="true"></span>
        `).join("")}
        ${heartCount > visibleHearts ? `<span class="heart-count" aria-hidden="true">x${heartCount}</span>` : ""}
      </span>
    `;
  }

  function renderSeizureFreeProgress(daysSinceLast) {
    if (!Number.isFinite(daysSinceLast)) {
      return `
        <div class="streak-progress" style="--streak-progress: 0%;">
          <span></span>
          <small>First heart: 5 days</small>
        </div>
      `;
    }

    const previous = Math.floor(daysSinceLast / 5) * 5;
    const next = previous + 5;
    const span = Math.max(1, next - previous);
    const progress = clamp(((daysSinceLast - previous) / span) * 100, 0, 100);
    const remaining = Math.max(0, next - daysSinceLast);
    const message = remaining === 0
      ? `${next / 5} hearts earned`
      : `${remaining} ${remaining === 1 ? "day" : "days"} to next heart`;

    return `
      <div class="streak-progress" style="--streak-progress: ${round1(progress)}%;">
        <span></span>
        <small>${escapeHtml(message)}</small>
      </div>
    `;
  }

  function renderPixelIcon(type) {
    return `<span class="pixel-icon pixel-${escapeHtml(type)}" aria-hidden="true"></span>`;
  }

  function timeOfDayGreeting(date) {
    const hour = date.getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  }

  function shouldShowLoginScreen() {
    return hasSupabaseConfig() && !hasStoredAccess();
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
    const monthly = getStatsMonthlyData(state.homeTrendRange);
    const selectedMonth = getSelectedHomeMonth(monthly);
    const previousMonth = monthly[monthly.findIndex((item) => item.key === selectedMonth.key) - 1];
    const max = Math.max(...monthly.map((item) => item.count), 1);
    const trendText = selectedMonth.count
      ? `${selectedMonth.count} seizure${selectedMonth.count === 1 ? "" : "s"} in ${selectedMonth.fullLabel}${previousMonth ? `, ${formatMonthDeltaPhrase(selectedMonth.count - previousMonth.count, previousMonth.fullLabel)}.` : "."}`
      : `No seizures logged in ${selectedMonth.fullLabel}.`;
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
    const labelStep = Math.max(1, Math.ceil(monthly.length / 6));
    const trendRangeLabel = state.homeTrendRange === "all" ? "all recorded months" : `the last ${state.homeTrendRange} months`;
    const path = points
      .map((point, index) => `${index === 0 ? "M" : "L"} ${round1(point.x)} ${round1(point.y)}`)
      .join(" ");
    const areaPath = `${path} L ${round1(points.at(-1).x)} ${chartHeight - bottomPad} L ${round1(points[0].x)} ${chartHeight - bottomPad} Z`;

    return `
      <section class="trend-card glass-panel">
        <div class="trend-topline">
          <div class="pixel-heading-lockup trend-copy">
            ${renderPixelIcon("trend")}
            <div>
              <p class="eyebrow">Seizure trend</p>
              <h2>At a glance</h2>
            </div>
            <p class="subtle">${summary.totalSeizures ? `${summary.totalSeizures} seizure${summary.totalSeizures === 1 ? "" : "s"} tracked across your timeline.` : "Your graph will build as seizures are logged."}</p>
          </div>
          <button class="btn ghost small trend-stats-btn" data-tab="insights" type="button">Stats</button>
        </div>

        <div class="trend-section">
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
                  <stop offset="100%" stop-color="#d94c3c"></stop>
                </linearGradient>
              </defs>
              <line class="trend-grid-line" x1="${leftPad}" x2="${chartWidth - rightPad}" y1="${topPad + plotHeight * 0.25}" y2="${topPad + plotHeight * 0.25}"></line>
              <line class="trend-grid-line" x1="${leftPad}" x2="${chartWidth - rightPad}" y1="${topPad + plotHeight * 0.5}" y2="${topPad + plotHeight * 0.5}"></line>
              <line class="trend-grid-line" x1="${leftPad}" x2="${chartWidth - rightPad}" y1="${topPad + plotHeight * 0.75}" y2="${topPad + plotHeight * 0.75}"></line>
              <path class="trend-area" d="${areaPath}"></path>
              <path class="trend-line" d="${path}"></path>
              ${points.map((point, index) => `
                <g>
                  <rect class="trend-bar" x="${round1(point.x - 10)}" y="${round1(topPad + plotHeight - (point.count / max) * plotHeight)}" width="20" height="${round1((point.count / max) * plotHeight)}" rx="10"></rect>
                  <circle class="trend-dot" cx="${round1(point.x)}" cy="${round1(point.y)}" r="${point.count ? 4.5 : 3.5}"></circle>
                  <text class="trend-count" x="${round1(point.x)}" y="${round1(Math.max(10, point.y - 8))}">${point.count}</text>
                  ${(index === 0 || index === points.length - 1 || index % labelStep === 0) ? `<text class="trend-label" x="${round1(point.x)}" y="${chartHeight - 5}">${escapeHtml(point.label)}</text>` : ""}
                </g>
              `).join("")}
            </svg>
          </div>
        </div>

        <div class="trend-section monthly-outlook-section">
          <div class="pixel-heading-lockup trend-copy">
            ${renderPixelIcon("calendar")}
            <div>
              <p class="eyebrow">Monthly outlook</p>
              <h2>Seizures by month</h2>
            </div>
            <p class="subtle">${escapeHtml(`${trendText} Showing ${trendRangeLabel}.`)}</p>
          </div>
          <div class="stats-range-control home-trend-range-control" aria-label="Choose homepage seizure trend range">
            ${[
              ["6", "6M"],
              ["12", "12M"],
              ["all", "All"]
            ].map(([value, label]) => `
              <button
                class="${state.homeTrendRange === value ? "active" : ""}"
                data-home-trend-range="${escapeHtml(value)}"
                type="button"
                aria-pressed="${state.homeTrendRange === value ? "true" : "false"}"
              >${escapeHtml(label)}</button>
            `).join("")}
          </div>
          <div class="home-month-chart" aria-label="Monthly seizure counts for ${escapeHtml(trendRangeLabel)}">
            ${monthly.map((item, index) => `
              <button
                class="home-month-bar ${item.key === selectedMonth.key ? "active" : ""}"
                data-home-stats-month="${escapeHtml(item.key)}"
                type="button"
                aria-pressed="${item.key === selectedMonth.key ? "true" : "false"}"
                aria-label="${escapeHtml(`${item.fullLabel}: ${item.count} seizure${item.count === 1 ? "" : "s"}. Show month details.`)}"
              >
                <span class="home-month-count">${item.count}</span>
                <span class="home-month-track" aria-hidden="true">
                  <span class="home-month-fill" style="height: ${(item.count / max) * 100}%"></span>
                </span>
                <span class="home-month-name">${escapeHtml(item.label)}</span>
                <span class="home-month-delta ${item.delta > 0 ? "up" : item.delta < 0 ? "down" : ""}">
                  ${index === 0 ? "base" : formatSignedDelta(item.delta)}
                </span>
              </button>
            `).join("")}
          </div>
          ${renderSelectedStatsMonth(selectedMonth)}
        </div>
      </section>
    `;
  }

  function getSelectedHomeMonth(months) {
    if (!months.length) return null;
    const selected = months.find((item) => item.key === state.homeSelectedMonthKey);
    if (selected) return selected;
    const latestWithSeizure = [...months].reverse().find((item) => item.count > 0);
    const fallback = latestWithSeizure || months.at(-1);
    state.homeSelectedMonthKey = fallback.key;
    return fallback;
  }

  function renderHomeInsight(summary) {
    const insights = buildHomeInsights(summary);
    const signature = insights.map((insight) => `${insight.title}:${insight.body}`).join("|");
    if (signature !== state.homeInsightSignature) {
      state.homeInsightSignature = signature;
      state.homeInsightIndex = 0;
    }
    state.homeInsightIndex = clamp(state.homeInsightIndex, 0, Math.max(0, insights.length - 1));
    const insight = insights[state.homeInsightIndex];

    return `
      <section class="home-insight glass-panel" data-home-insight aria-roledescription="carousel" aria-label="Dynamic insights">
        <div class="home-insight-topline">
          <p class="eyebrow">Live insight</p>
          <button class="btn ghost small" data-tab="insights" type="button">More</button>
        </div>
        <div class="home-insight-copy" aria-live="polite">
          <h2 data-home-insight-title>${escapeHtml(insight.title)}</h2>
          <p class="subtle" data-home-insight-body>${escapeHtml(insight.body)}</p>
        </div>
        <div class="home-insight-controls">
          <button class="insight-arrow" data-insight-direction="-1" type="button" aria-label="Previous insight">←</button>
          <div class="insight-dots" aria-label="Choose insight">
            ${insights.map((item, index) => `
              <button
                class="${index === state.homeInsightIndex ? "active" : ""}"
                data-insight-index="${index}"
                type="button"
                aria-label="Insight ${index + 1}: ${escapeHtml(item.title)}"
                aria-current="${index === state.homeInsightIndex ? "true" : "false"}"
              ></button>
            `).join("")}
          </div>
          <button class="insight-arrow" data-insight-direction="1" type="button" aria-label="Next insight">→</button>
          <span class="insight-counter" data-insight-counter>${state.homeInsightIndex + 1} of ${insights.length}</span>
        </div>
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
      <div class="month-strip-wrap" aria-label="${escapeHtml(selectedDate.toLocaleDateString(undefined, { month: "long", year: "numeric" }))}">
        <div class="day-browser-heading">
          <div>
            <p class="eyebrow">${escapeHtml(selectedDate.toLocaleDateString(undefined, { month: "long", year: "numeric" }))}</p>
            <h2>${escapeHtml(formatDateShort(selectedDate))}</h2>
          </div>
          <span class="day-position">${selectedDate.getDate()} of ${daysInMonth}</span>
        </div>
        <div class="month-strip" data-month-strip>
          ${days.join("")}
        </div>
      </div>
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
      <div class="day-overview">
        <div class="day-overview-heading">
          <p class="eyebrow">Day overview</p>
          <span class="status-pill assumed">${escapeHtml(headline)}</span>
        </div>
        <div class="overview-metrics">
          <div><strong>${seizures.length}</strong><span>Seizures</span></div>
          <div><strong>${exceptions.length}</strong><span>Missed</span></div>
          <div><strong>${careRecords.length}</strong><span>Care</span></div>
        </div>
        <ul class="overview-list">${eventList}</ul>
      </div>
    `;
  }

  function renderMedicationPlan(entries) {
    const exceptions = entries.filter((entry) => entry.status === "missed" || entry.status === "skipped");
    const groups = [];
    entries.forEach((entry) => {
      const key = entry.time.label || formatTime(entry.dueAt);
      let group = groups.find((item) => item.key === key);
      if (!group) {
        group = { key, label: entry.time.label || "Scheduled", entries: [] };
        groups.push(group);
      }
      group.entries.push(entry);
    });

    return `
      <section class="plan-card care-card medication-plan">
        <div class="medication-plan-heading">
          <div>
            <p class="eyebrow">Today's medication</p>
            <h2>Daily check</h2>
            <p class="subtle">Assumed given unless you mark a dose as missed.</p>
          </div>
          <span class="status-pill ${exceptions.length ? "missed" : "assumed"}">
            ${exceptions.length ? `${exceptions.length} missed` : "All assumed"}
          </span>
        </div>
        <div class="dose-groups">
          ${groups.map(renderDoseGroup).join("")}
        </div>
      </section>
    `;
  }

  function renderDoseGroup(group) {
    const times = [...new Set(group.entries.map((entry) => formatTime(entry.dueAt)))];
    return `
      <section class="dose-group">
        <header>
          <strong>${escapeHtml(group.label)}</strong>
          <span>${escapeHtml(times.join(", "))}</span>
        </header>
        <div>
          ${group.entries.map(renderDoseRow).join("")}
        </div>
      </section>
    `;
  }

  function renderDoseRow(entry) {
    const hasException = entry.status === "missed" || entry.status === "skipped";
    const details = [entry.statusText, entry.doseText].filter(Boolean).join(" · ");
    return `
      <article class="medication-row ${hasException ? "missed" : ""}">
        <div class="medication-copy">
          <strong>${escapeHtml(entry.schedule.name)}</strong>
          <span class="medication-meta">
            <span class="medication-state ${entry.pillClass}">${escapeHtml(details)}</span>
          </span>
        </div>
        ${
          hasException
            ? `<button class="missed-toggle active" data-clear-dose="${entry.log.id}" type="button">Undo missed</button>`
            : `<button class="missed-toggle" data-dose="${entry.key}" data-status="missed" type="button">Mark missed</button>`
        }
      </article>
    `;
  }

  function renderLog() {
    const now = new Date();
    const todayEntries = getTodayDoseEntries(now);
    const editingSeizure = state.events.find((event) => event.id === state.editingSeizureId && event.type === "seizure");
    const seizureDate = editingSeizure ? new Date(editingSeizure.occurredAt) : now;
    const durationSeconds = clamp(editingSeizure?.durationSeconds || 0, 0, 120);
    const localDate = toDateInputValue(seizureDate);
    const localTime = toTimeInputValue(seizureDate);
    const timeKnown = editingSeizure ? editingSeizure.timeKnown !== false : false;
    const selectedSeverity = editingSeizure?.severity || state.severity;
    const editingRecord = state.events.find(
      (event) =>
        event.id === state.editingRecordId &&
        ["note", "vet_visit", "blood_test"].includes(event.type)
    );
    const recordDate = editingRecord ? new Date(editingRecord.occurredAt) : now;
    const recordLocalDate = toDateInputValue(recordDate);
    const recordLocalTime = toTimeInputValue(recordDate);

    return `
      <div class="stack desktop-two">
        <section class="panel">
          <div class="panel-body">
            <div class="dose-main log-heading">
              <div>
                <p class="eyebrow">${editingSeizure ? "Update record" : "Quick record"}</p>
                <h2>${editingSeizure ? "Edit seizure" : "Log seizure"}</h2>
                <p class="subtle">Date, duration and severity. Everything else is optional.</p>
              </div>
              ${editingSeizure ? `<button class="btn ghost small" data-action="cancel-seizure-edit" type="button">Cancel</button>` : ""}
            </div>

            <form id="seizure-form" class="form-grid seizure-form">
              <input type="hidden" name="id" value="${escapeHtml(editingSeizure?.id || "")}" />

              <section class="log-section">
                <div class="quick-when-grid">
                  <div class="field">
                    <label for="seizure-date">Date</label>
                    ${renderDateInput("seizure-date", "date", localDate, true)}
                  </div>
                  <label class="quick-time-toggle" for="seizure-time-known">
                    <span class="label">Approximate time</span>
                    <span class="quick-time-control">
                      <span data-time-status>${timeKnown ? "Included" : "Not needed"}</span>
                      <input id="seizure-time-known" name="timeKnown" type="checkbox" data-time-known ${timeKnown ? "checked" : ""} />
                    </span>
                  </label>
                </div>
                <div class="field optional-time-field" data-optional-time ${timeKnown ? "" : "hidden"}>
                  <label for="seizure-time">Approximate time</label>
                  ${renderTimeInput("seizure-time", "time", localTime)}
                </div>
              </section>

              <section class="log-section seizure-measures">
                <div class="duration-wheel">
                  <div class="duration-wheel-heading">
                    <div>
                      <span class="label">Duration</span>
                      <small>Slide to the closest estimate</small>
                    </div>
                    <output id="duration-output" for="seizure-duration">${formatDuration(durationSeconds)}</output>
                  </div>
                  <input
                    id="seizure-duration"
                    name="durationSeconds"
                    type="range"
                    min="0"
                    max="120"
                    step="5"
                    value="${durationSeconds}"
                    style="--duration-progress: ${(durationSeconds / 120) * 100}%"
                    aria-label="Seizure duration in seconds"
                  />
                  <div class="duration-scale" aria-hidden="true">
                    <span>0 sec</span>
                    <span>1 min</span>
                    <span>2 min</span>
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

              <div class="button-row log-submit-row">
                <button class="btn primary" type="submit">${editingSeizure ? "Update seizure" : "Save seizure"}</button>
                ${editingSeizure ? `<button class="btn danger" data-delete-event="${escapeHtml(editingSeizure.id)}" type="button">Delete seizure</button>` : ""}
              </div>

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
            </form>
          </div>
        </section>

        ${renderMedicationPlan(todayEntries)}

        <section class="panel document-library-panel">
          <div class="panel-body">
            ${renderVetDocuments(localDate)}
          </div>
        </section>

        <section class="panel other-records-panel">
          <div class="panel-body">
            <div class="records-heading">
              <p class="eyebrow">Other records</p>
              <h2>Add to Sawyer's history</h2>
              <p class="subtle">Open the record you need. The others stay out of the way.</p>
            </div>

            <div class="record-accordions">
              <details class="record-disclosure" data-record-disclosure ${editingRecord?.type === "note" ? "open" : ""}>
                <summary>
                  <span>
                    <strong>Care note</strong>
                    <small>Appetite, behaviour or a general observation</small>
                  </span>
                </summary>
                <form id="note-form" class="form-grid record-form">
                  <input type="hidden" name="id" value="${escapeHtml(editingRecord?.type === "note" ? editingRecord.id : "")}" />
                  <div class="field">
                    <label for="note-title">Title</label>
                    <input id="note-title" name="title" value="${escapeHtml(editingRecord?.type === "note" ? editingRecord.title || "" : "")}" placeholder="Appetite, behaviour, vet call" />
                  </div>
                  <div class="field">
                    <label for="note-body">Note</label>
                    <textarea id="note-body" name="body" required>${escapeHtml(editingRecord?.type === "note" ? editingRecord.body || "" : "")}</textarea>
                  </div>
                  <div class="button-row">
                    <button class="btn primary" type="submit">${editingRecord?.type === "note" ? "Update Note" : "Save Note"}</button>
                    ${editingRecord?.type === "note" ? `<button class="btn secondary" data-action="cancel-record-edit" type="button">Cancel</button>` : ""}
                  </div>
                </form>
              </details>

              <details class="record-disclosure" data-record-disclosure ${editingRecord?.type === "vet_visit" ? "open" : ""}>
                <summary>
                  <span>
                    <strong>Vet visit</strong>
                    <small>Appointment details, weight and treatment plan</small>
                  </span>
                </summary>
                <form id="vet-form" class="form-grid record-form">
                  <input type="hidden" name="id" value="${escapeHtml(editingRecord?.type === "vet_visit" ? editingRecord.id : "")}" />
                  <div class="grid two date-time-grid">
                    <div class="field">
                      <label for="vet-date">Date</label>
                      ${renderDateInput("vet-date", "date", editingRecord?.type === "vet_visit" ? recordLocalDate : localDate, true)}
                    </div>
                    <div class="field">
                      <label for="vet-time">Time</label>
                      ${renderTimeInput("vet-time", "time", editingRecord?.type === "vet_visit" ? recordLocalTime : localTime)}
                    </div>
                  </div>
                  <div class="field">
                    <label for="vet-clinic">Clinic or vet</label>
                    <input id="vet-clinic" name="clinic" value="${escapeHtml(editingRecord?.type === "vet_visit" ? editingRecord.clinic || "" : "")}" placeholder="Vet name or clinic" />
                  </div>
                  <div class="field">
                    <label for="vet-reason">Reason</label>
                    <input id="vet-reason" name="reason" value="${escapeHtml(editingRecord?.type === "vet_visit" ? editingRecord.reason || "" : "")}" placeholder="Checkup, seizure review, medication review" required />
                  </div>
                  <div class="field">
                    <label for="vet-weight">Weight</label>
                    <input id="vet-weight" name="weight" value="${escapeHtml(editingRecord?.type === "vet_visit" ? editingRecord.weight || "" : "")}" placeholder="Example: 24.8 kg" />
                  </div>
                  <div class="field">
                    <label for="vet-plan">Plan / medication changes</label>
                    <textarea id="vet-plan" name="plan" placeholder="Next steps, dosage changes, follow-up date">${escapeHtml(editingRecord?.type === "vet_visit" ? editingRecord.plan || "" : "")}</textarea>
                  </div>
                  <div class="button-row">
                    <button class="btn primary" type="submit">${editingRecord?.type === "vet_visit" ? "Update Vet Visit" : "Save Vet Visit"}</button>
                    ${editingRecord?.type === "vet_visit" ? `<button class="btn secondary" data-action="cancel-record-edit" type="button">Cancel</button>` : ""}
                  </div>
                </form>
              </details>

              <details class="record-disclosure" data-record-disclosure ${editingRecord?.type === "blood_test" ? "open" : ""}>
                <summary>
                  <span>
                    <strong>Blood test</strong>
                    <small>Levels, panel results and the vet's interpretation</small>
                  </span>
                </summary>
                <form id="blood-test-form" class="form-grid record-form">
                  <input type="hidden" name="id" value="${escapeHtml(editingRecord?.type === "blood_test" ? editingRecord.id : "")}" />
                  <div class="grid two date-time-grid">
                    <div class="field">
                      <label for="blood-date">Date</label>
                      ${renderDateInput("blood-date", "date", editingRecord?.type === "blood_test" ? recordLocalDate : localDate, true)}
                    </div>
                    <div class="field">
                      <label for="blood-time">Time</label>
                      ${renderTimeInput("blood-time", "time", editingRecord?.type === "blood_test" ? recordLocalTime : localTime)}
                    </div>
                  </div>
                  <div class="field">
                    <label for="blood-panel">Test / panel</label>
                    <input id="blood-panel" name="panel" value="${escapeHtml(editingRecord?.type === "blood_test" ? editingRecord.panel || "" : "")}" placeholder="Phenobarbital level, bromide level, liver panel" required />
                  </div>
                  ${renderLabLevelFields("Phenobarbital", "phenobarbital", editingRecord?.type === "blood_test" ? editingRecord.phenobarbital : null)}
                  ${renderLabLevelFields("Bromide", "bromide", editingRecord?.type === "blood_test" ? editingRecord.bromide : null)}
                  ${
                    editingRecord?.type === "blood_test" &&
                    !editingRecord.phenobarbital &&
                    editingRecord.phenobarbitalLevel
                      ? `<p class="subtle">Legacy phenobarbital entry: ${escapeHtml(editingRecord.phenobarbitalLevel)}</p>`
                      : ""
                  }
                  ${
                    editingRecord?.type === "blood_test" &&
                    !editingRecord.bromide &&
                    editingRecord.bromideLevel
                      ? `<p class="subtle">Legacy bromide entry: ${escapeHtml(editingRecord.bromideLevel)}</p>`
                      : ""
                  }
                  <div class="field">
                    <label for="blood-results">Results</label>
                    <textarea id="blood-results" name="results" placeholder="Paste key results or lab notes">${escapeHtml(editingRecord?.type === "blood_test" ? editingRecord.results || "" : "")}</textarea>
                  </div>
                  <div class="field">
                    <label for="blood-notes">Notes</label>
                    <textarea id="blood-notes" name="notes" placeholder="Vet interpretation, recheck timing, changes">${escapeHtml(editingRecord?.type === "blood_test" ? editingRecord.notes || "" : "")}</textarea>
                  </div>
                  <div class="button-row">
                    <button class="btn primary" type="submit">${editingRecord?.type === "blood_test" ? "Update Blood Test" : "Save Blood Test"}</button>
                    ${editingRecord?.type === "blood_test" ? `<button class="btn secondary" data-action="cancel-record-edit" type="button">Cancel</button>` : ""}
                  </div>
                </form>
              </details>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  function renderVetDocuments(localDate) {
    const documents = state.vetDocuments || [];
    const message = state.documentsMessage
      ? `<p class="subtle document-message">${escapeHtml(state.documentsMessage)}</p>`
      : "";

    return `
      <section class="vet-documents">
        <div class="dose-main">
          <div>
            <h2>Vet Documents</h2>
            <p class="subtle">Private PDFs shared between both phones.</p>
          </div>
          <span class="status-pill">${documents.length} stored</span>
        </div>

        <details class="record-disclosure document-upload-disclosure">
          <summary>
            <span>
              <strong>Upload a PDF</strong>
              <small>Visit summaries, lab results and prescriptions</small>
            </span>
          </summary>
          <form id="vet-document-form" class="form-grid record-form document-upload-form">
            <div class="field">
              <label for="vet-document-file">PDF document</label>
              <input id="vet-document-file" name="file" type="file" accept="application/pdf,.pdf" required />
              <small class="field-help">PDF only, up to 20 MB.</small>
            </div>
            <div class="grid two">
              <div class="field">
                <label for="vet-document-category">Document type</label>
                <select id="vet-document-category" name="category">
                  ${VET_DOCUMENT_CATEGORIES.map((category) => `<option value="${category.id}">${escapeHtml(category.label)}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label for="vet-document-date">Document date</label>
                ${renderDateInput("vet-document-date", "documentDate", localDate)}
              </div>
            </div>
            <div class="field">
              <label for="vet-document-notes">Notes</label>
              <input id="vet-document-notes" name="notes" placeholder="Optional description" />
            </div>
            <button class="btn primary" type="submit" ${state.documentsBusy ? "disabled" : ""}>
              ${state.documentsBusy ? "Uploading..." : "Upload PDF"}
            </button>
          </form>
        </details>

        ${message}

        <div class="document-list">
          ${
            documents.length
              ? documents.map(renderVetDocument).join("")
              : `<div class="empty">No vet documents uploaded yet.</div>`
          }
        </div>
      </section>
    `;
  }

  function renderLabLevelFields(label, prefix, level) {
    return `
      <fieldset class="lab-level">
        <legend>${escapeHtml(label)}</legend>
        <div class="lab-level-grid">
          <div class="field">
            <label for="blood-${prefix}-value">Value</label>
            <input id="blood-${prefix}-value" name="${prefix}Value" type="number" inputmode="decimal" step="any" value="${escapeHtml(level?.value ?? "")}" placeholder="Number" />
          </div>
          <div class="field">
            <label for="blood-${prefix}-unit">Unit</label>
            <input id="blood-${prefix}-unit" name="${prefix}Unit" value="${escapeHtml(level?.unit || "")}" placeholder="mg/L" />
          </div>
          <div class="field">
            <label for="blood-${prefix}-range">Target range</label>
            <input id="blood-${prefix}-range" name="${prefix}ReferenceRange" value="${escapeHtml(level?.referenceRange || "")}" placeholder="Vet or lab range" />
          </div>
        </div>
      </fieldset>
    `;
  }

  function renderVetDocument(document) {
    const category = VET_DOCUMENT_CATEGORIES.find((item) => item.id === document.category)?.label || "Other";
    const date = document.document_date
      ? formatDateShort(localTimeToDate(document.document_date, "12:00"))
      : "Date not set";
    return `
      <article class="document-row">
        <div class="document-copy">
          <strong>${escapeHtml(document.file_name || "Vet document.pdf")}</strong>
          <span>${escapeHtml(category)} · ${escapeHtml(date)} · ${escapeHtml(formatFileSize(document.size_bytes))}</span>
          ${document.notes ? `<p>${escapeHtml(document.notes)}</p>` : ""}
        </div>
        <div class="button-row">
          <button class="btn secondary small" data-view-vet-document="${escapeHtml(document.id)}" type="button">Open</button>
          <button class="btn ghost small" data-delete-vet-document="${escapeHtml(document.id)}" type="button">Delete</button>
        </div>
      </article>
    `;
  }

  function renderTimeline() {
    const events = filteredTimelineEvents();
    const visibleEvents = events.slice(0, state.timelineLimit);
    const groups = groupTimelineEvents(visibleEvents);
    const totalRecords = state.events.length;

    return `
      <div class="stack history-view">
        <section class="panel history-controls">
          <div class="panel-body">
            <div class="history-heading">
              <div>
                <p class="eyebrow">Sawyer's record</p>
                <h2>History</h2>
              </div>
              <span class="status-pill">${totalRecords} total</span>
            </div>

            <form id="history-search-form" class="history-search" role="search">
              <input
                name="query"
                type="search"
                aria-label="Search history"
                placeholder="Search seizures, notes, results..."
                value="${escapeHtml(state.timelineSearch)}"
              />
              <button class="btn secondary small" type="submit">Search</button>
              ${state.timelineSearch ? `<button class="btn ghost small" data-action="clear-history-search" type="button">Clear</button>` : ""}
            </form>

            <div class="filters">
              ${TIMELINE_FILTERS.map((filter) => `
                <button class="history-filter ${state.timelineFilter === filter.id ? "active" : ""}" data-filter="${filter.id}" type="button">
                  <span>${escapeHtml(filter.label)}</span>
                  <small>${timelineFilterCount(filter.id)}</small>
                </button>
              `).join("")}
            </div>
          </div>
        </section>

        ${
          groups.length
            ? `<div class="history-groups">${groups.map(renderTimelineGroup).join("")}</div>`
            : `<div class="empty">No records match this view.</div>`
        }

        ${
          events.length > visibleEvents.length
            ? `<button class="btn secondary history-more" data-action="history-more" type="button">Load ${Math.min(HISTORY_PAGE_SIZE, events.length - visibleEvents.length)} older records</button>`
            : events.length
              ? `<p class="history-end">Showing all ${events.length} matching record${events.length === 1 ? "" : "s"}.</p>`
              : ""
        }
      </div>
    `;
  }

  function renderTimelineGroup(group) {
    return `
      <section class="history-day">
        <header class="history-day-heading">
          <h3>${escapeHtml(formatHistoryDate(group.date))}</h3>
          <span>${group.events.length} record${group.events.length === 1 ? "" : "s"}</span>
        </header>
        <div class="timeline-list">
          ${group.events.map(renderTimelineItem).join("")}
        </div>
      </section>
    `;
  }

  function renderTimelineItem(event) {
    return `
      <details class="timeline-item ${escapeHtml(event.type)}">
        <summary>
          <span class="timeline-marker" aria-hidden="true"></span>
          <span class="timeline-summary-copy">
            <strong>${escapeHtml(eventTitle(event))}</strong>
            <span class="timeline-meta">${escapeHtml(formatEventTime(event))}</span>
          </span>
        </summary>
        <div class="timeline-item-body">
          ${eventDetail(event)}
          <div class="timeline-actions">
            ${event.type === "seizure" ? `<button class="btn secondary small" data-edit-seizure="${escapeHtml(event.id)}">Edit</button>` : ""}
            ${["note", "vet_visit", "blood_test"].includes(event.type) ? `<button class="btn secondary small" data-edit-record="${escapeHtml(event.id)}">Edit</button>` : ""}
            <button class="btn ghost small" data-delete-event="${escapeHtml(event.id)}">Delete</button>
          </div>
        </div>
      </details>
    `;
  }

  function renderInsights(summary) {
    const monthly = getStatsMonthlyData(state.statsRange);
    const selectedMonth = getSelectedStatsMonth(monthly);
    const max = Math.max(...monthly.map((item) => item.count), 1);
    const patternCards = buildStatsPatternCards(summary, selectedMonth, monthly);

    return `
      <div class="stack">
        <section class="panel stats-hero-panel">
          <div class="panel-body">
            <div class="stats-hero-heading">
              <div>
                <p class="eyebrow">Pattern dashboard</p>
                <h2>Sawyer's stats</h2>
              </div>
              <span>${escapeHtml(selectedMonth.fullLabel)}</span>
            </div>
            <div class="metric-row stats-metrics">
              <div class="metric">
                <span>Seizures</span>
                <strong>${summary.totalSeizures}</strong>
              </div>
              <div class="metric">
                <span>Current gap</span>
                <strong>${summary.daysSinceLast === null ? "--" : `${summary.daysSinceLast}d`}</strong>
              </div>
              <div class="metric">
                <span>Average gap</span>
                <strong>${summary.averageGapText}</strong>
              </div>
              <div class="metric">
                <span>Longest gap</span>
                <strong>${summary.longestGapText}</strong>
              </div>
            </div>
          </div>
        </section>

        <section class="panel stats-month-panel">
          <div class="panel-body">
            <div class="stats-panel-heading">
              <div>
                <p class="eyebrow">Seizures by month</p>
                <h2>Tap a month</h2>
              </div>
              <div class="stats-range-control" aria-label="Choose stats range">
                ${[
                  ["6", "6M"],
                  ["12", "12M"],
                  ["all", "All"]
                ].map(([value, label]) => `
                  <button
                    class="${state.statsRange === value ? "active" : ""}"
                    data-stats-range="${escapeHtml(value)}"
                    type="button"
                    aria-pressed="${state.statsRange === value ? "true" : "false"}"
                  >${escapeHtml(label)}</button>
                `).join("")}
              </div>
            </div>
            <div class="stats-month-chart" aria-label="Monthly seizure counts">
              ${monthly.map((item, index) => `
                <button
                  class="stats-month-bar ${item.key === selectedMonth.key ? "active" : ""}"
                  data-stats-month="${escapeHtml(item.key)}"
                  type="button"
                  aria-pressed="${item.key === selectedMonth.key ? "true" : "false"}"
                  aria-label="${escapeHtml(`${item.fullLabel}: ${item.count} seizure${item.count === 1 ? "" : "s"}`)}"
                >
                  <span class="stats-month-count">${item.count}</span>
                  <span class="stats-month-track" aria-hidden="true">
                    <span class="stats-month-fill" style="height: ${(item.count / max) * 100}%"></span>
                  </span>
                  <span class="stats-month-name">${escapeHtml(item.label)}</span>
                  <span class="stats-month-delta ${item.delta > 0 ? "up" : item.delta < 0 ? "down" : ""}">
                    ${index === 0 ? "base" : formatSignedDelta(item.delta)}
                  </span>
                </button>
              `).join("")}
            </div>
            ${renderSelectedStatsMonth(selectedMonth)}
          </div>
        </section>

        <section class="stats-pattern-grid" aria-label="Pattern breakdown">
          ${patternCards.map((card) => `
            <article class="stats-pattern-card ${escapeHtml(card.tone || "")}">
              <span>${escapeHtml(card.label)}</span>
              <strong>${escapeHtml(card.value)}</strong>
              <p>${escapeHtml(card.body)}</p>
            </article>
          `).join("")}
        </section>

        ${renderAiInsightPanel()}
      </div>
    `;
  }

  function renderSelectedStatsMonth(month) {
    return `
      <div class="stats-month-detail" data-stats-month-detail>
        <div>
          <span class="detail-kicker">${escapeHtml(month.fullLabel)}</span>
          <h3>${month.count ? `${month.count} seizure${month.count === 1 ? "" : "s"} logged` : "No seizures logged"}</h3>
          <p class="subtle">${escapeHtml(month.summary)}</p>
        </div>
        <div class="stats-detail-grid">
          <div>
            <span>Severity</span>
            <strong>${month.averageSeverityText}</strong>
          </div>
          <div>
            <span>Duration</span>
            <strong>${month.averageDurationText}</strong>
          </div>
          <div>
            <span>Clusters</span>
            <strong>${month.clusterCount}</strong>
          </div>
          <div>
            <span>Usual time</span>
            <strong>${escapeHtml(month.timeWindowText)}</strong>
          </div>
        </div>
      </div>
    `;
  }

  function buildStatsPatternCards(summary, selectedMonth, months) {
    const seizures = getSeizuresAsc();
    const gaps = getSeizureGaps(seizures);
    const latestBlood = latestEventOfType("blood_test");
    const latestVet = latestEventOfType("vet_visit");
    const previousMonth = months[months.findIndex((item) => item.key === selectedMonth.key) - 1];
    const cards = [];

    cards.push({
      label: "Selected month",
      value: `${selectedMonth.count}`,
      body: previousMonth
        ? formatMonthDeltaSentence(selectedMonth.count - previousMonth.count, previousMonth.fullLabel)
        : `${selectedMonth.fullLabel} is the first month in this view.`,
      tone: selectedMonth.count ? "warm" : "calm"
    });

    if (summary.daysSinceLast === null) {
      cards.push({
        label: "Current gap",
        value: "--",
        body: "Log Sawyer's first seizure to start tracking seizure-free spacing.",
        tone: "calm"
      });
    } else {
      const averageGap = gaps.length ? mean(gaps.map((gap) => gap.days)) : null;
      cards.push({
        label: "Current gap",
        value: `${summary.daysSinceLast} days`,
        body: averageGap
          ? `${round1(Math.abs(summary.daysSinceLast - averageGap))} days ${summary.daysSinceLast >= averageGap ? "above" : "below"} the completed-gap average.`
          : "A second seizure log will unlock gap comparisons.",
        tone: summary.daysSinceLast >= (averageGap || 0) ? "positive" : "warm"
      });
    }

    cards.push({
      label: "Cluster watch",
      value: `${selectedMonth.clusterCount}`,
      body: selectedMonth.clusterCount
        ? `${selectedMonth.clusterCount} seizure${selectedMonth.clusterCount === 1 ? " was" : "s were"} flagged as part of a 24-hour cluster in ${selectedMonth.fullLabel}.`
        : `No cluster flags inside ${selectedMonth.fullLabel}.`,
      tone: selectedMonth.clusterCount ? "alert" : "positive"
    });

    const missedNearSeizures = countSeizuresNearMissedDose(seizures);
    cards.push({
      label: "Dose context",
      value: `${missedNearSeizures.total}`,
      body: missedNearSeizures.total
        ? `Logged seizure${missedNearSeizures.total === 1 ? "" : "s"} occurred within 24 hours after a missed or late dose record.`
        : "No logged seizures are currently near a missed or late dose record.",
      tone: missedNearSeizures.total ? "warm" : "positive"
    });

    if (latestBlood || latestVet) {
      const latest = [latestBlood, latestVet]
        .filter(Boolean)
        .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0];
      cards.push({
        label: "Medical context",
        value: latest.type === "blood_test" ? "Blood" : "Vet",
        body: `${eventTitle(latest)} was saved on ${formatDateShort(new Date(latest.occurredAt))}. Compare it against month changes here.`,
        tone: "calm"
      });
    }

    return cards.slice(0, 5);
  }

  function getSelectedStatsMonth(months) {
    if (!months.length) return null;
    const selected = months.find((item) => item.key === state.statsSelectedMonthKey);
    if (selected) return selected;
    const latestWithSeizure = [...months].reverse().find((item) => item.count > 0);
    const fallback = latestWithSeizure || months.at(-1);
    state.statsSelectedMonthKey = fallback.key;
    return fallback;
  }

  function formatSignedDelta(value) {
    if (value > 0) return `+${value}`;
    return String(value);
  }

  function formatMonthDeltaSentence(value, comparisonLabel) {
    if (value > 0) return `${value} more than ${comparisonLabel}.`;
    if (value < 0) return `${Math.abs(value)} fewer than ${comparisonLabel}.`;
    return `No change from ${comparisonLabel}.`;
  }

  function formatMonthDeltaPhrase(value, comparisonLabel) {
    if (value > 0) return `${value} more than ${comparisonLabel}`;
    if (value < 0) return `${Math.abs(value)} fewer than ${comparisonLabel}`;
    return `no change from ${comparisonLabel}`;
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
            <h2>In-app reminders</h2>
            <p class="subtle">These reminders can appear while Sawyer Tracker is open. iPhone may pause them after the app is closed.</p>
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
            <p class="subtle">Complete backups include every cloud record, deletion marker and private vet PDF.</p>
            ${state.backupMessage ? `<p class="subtle sync-message">${escapeHtml(state.backupMessage)}</p>` : ""}
            <div class="button-row">
              <button class="btn primary" data-action="export-json" ${state.backupBusy ? "disabled" : ""}>${state.backupBusy ? "Working..." : "Download Complete Backup"}</button>
              <button class="btn secondary" data-action="import-json" ${state.backupBusy ? "disabled" : ""}>Restore Backup</button>
              <button class="btn secondary" data-action="export-csv" ${state.backupBusy ? "disabled" : ""}>Export CSV</button>
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
    const storedAccess = hasStoredAccess();
    const lastSync = state.settings?.lastSyncAt
      ? formatDateTime(new Date(state.settings.lastSyncAt))
      : "Never";
    const syncStatus = state.syncBusy
      ? "Syncing"
      : signedIn
        ? navigator.onLine
          ? "Cloud connected"
          : "Offline"
        : storedAccess
          ? navigator.onLine
            ? "Access not verified"
            : "Offline"
        : configured
          ? "Needs access code"
          : "Not set up";
    const syncMessage = state.syncMessage || state.settings?.lastSyncMessage || "";
    const sourceMessage = signedIn
      ? "Supabase is the shared source of truth. This device only keeps a cache so the app opens quickly."
      : storedAccess
        ? "This device has a saved access code, but Supabase has not verified it yet."
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

          <details class="sync-advanced">
            <summary>Advanced connection settings</summary>
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
          </details>

          ${
            storedAccess
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
          <div class="field setup-effective-date">
            <label for="${schedule.id}-effective-from">Current regimen effective from</label>
            ${renderDateInput(`${schedule.id}-effective-from`, `${schedule.id}:effectiveFrom`, schedule.effectiveFrom || "")}
            <small class="field-help">Leave blank when the start date is unknown.</small>
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

    document.querySelectorAll("[data-edit-record]").forEach((button) => {
      button.addEventListener("click", () => editRecord(button.dataset.editRecord));
    });

    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.timelineFilter = button.dataset.filter;
        state.timelineLimit = HISTORY_PAGE_SIZE;
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

    const durationInput = document.querySelector("#seizure-duration");
    durationInput?.addEventListener("input", () => {
      const duration = clamp(Number(durationInput.value), 0, 120);
      durationInput.style.setProperty("--duration-progress", `${(duration / 120) * 100}%`);
      const output = document.querySelector("#duration-output");
      if (output) output.textContent = formatDuration(duration);
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
    const timeKnownStatus = document.querySelector("[data-time-status]");
    if (timeKnownToggle && optionalTimeField && optionalTimeInput) {
      const updateOptionalTime = () => {
        optionalTimeField.hidden = !timeKnownToggle.checked;
        optionalTimeInput.disabled = !timeKnownToggle.checked;
        if (timeKnownStatus) timeKnownStatus.textContent = timeKnownToggle.checked ? "Included" : "Not needed";
      };
      timeKnownToggle.addEventListener("change", updateOptionalTime);
      updateOptionalTime();
    }

    document.querySelectorAll("[data-record-disclosure]").forEach((disclosure) => {
      disclosure.addEventListener("toggle", () => {
        if (!disclosure.open) return;
        document.querySelectorAll("[data-record-disclosure]").forEach((other) => {
          if (other !== disclosure) other.open = false;
        });
      });
    });

    document.querySelectorAll("[data-insight-direction]").forEach((button) => {
      button.addEventListener("click", () => {
        showHomeInsight(state.homeInsightIndex + Number(button.dataset.insightDirection || 0));
      });
    });

    document.querySelectorAll("[data-insight-index]").forEach((button) => {
      button.addEventListener("click", () => {
        showHomeInsight(Number(button.dataset.insightIndex || 0));
      });
    });

    document.querySelectorAll("[data-stats-insight-direction]").forEach((button) => {
      button.addEventListener("click", () => {
        showStatsInsight(state.statsInsightIndex + Number(button.dataset.statsInsightDirection || 0));
      });
    });

    document.querySelectorAll("[data-stats-insight-index]").forEach((button) => {
      button.addEventListener("click", () => {
        showStatsInsight(Number(button.dataset.statsInsightIndex || 0));
      });
    });

    document.querySelectorAll("[data-stats-range]").forEach((button) => {
      button.addEventListener("click", () => {
        state.statsRange = button.dataset.statsRange || "6";
        state.statsSelectedMonthKey = "";
        renderPreservingContentScroll();
      });
    });

    document.querySelectorAll("[data-stats-month]").forEach((button) => {
      button.addEventListener("click", () => {
        state.statsSelectedMonthKey = button.dataset.statsMonth || "";
        renderPreservingContentScroll();
      });
    });

    document.querySelectorAll("[data-home-trend-range]").forEach((button) => {
      button.addEventListener("click", () => {
        state.homeTrendRange = button.dataset.homeTrendRange || "6";
        state.homeSelectedMonthKey = "";
        renderPreservingContentScroll();
      });
    });

    document.querySelectorAll("[data-home-stats-month]").forEach((button) => {
      button.addEventListener("click", () => {
        state.homeSelectedMonthKey = button.dataset.homeStatsMonth || "";
        renderPreservingContentScroll();
      });
    });

    const homeInsight = document.querySelector("[data-home-insight]");
    if (homeInsight) {
      let touchStartX = 0;
      let touchStartY = 0;
      homeInsight.addEventListener(
        "touchstart",
        (event) => {
          touchStartX = event.touches[0]?.clientX || 0;
          touchStartY = event.touches[0]?.clientY || 0;
        },
        { passive: true }
      );
      homeInsight.addEventListener(
        "touchend",
        (event) => {
          const touch = event.changedTouches[0];
          if (!touch) return;
          const deltaX = touch.clientX - touchStartX;
          const deltaY = touch.clientY - touchStartY;
          if (Math.abs(deltaX) < 45 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
          showHomeInsight(state.homeInsightIndex + (deltaX < 0 ? 1 : -1));
        },
        { passive: true }
      );
    }

    const statsInsight = document.querySelector("[data-stats-insight]");
    if (statsInsight) {
      let touchStartX = 0;
      let touchStartY = 0;
      statsInsight.addEventListener(
        "touchstart",
        (event) => {
          touchStartX = event.touches[0]?.clientX || 0;
          touchStartY = event.touches[0]?.clientY || 0;
        },
        { passive: true }
      );
      statsInsight.addEventListener(
        "touchend",
        (event) => {
          const touch = event.changedTouches[0];
          if (!touch) return;
          const deltaX = touch.clientX - touchStartX;
          const deltaY = touch.clientY - touchStartY;
          if (Math.abs(deltaX) < 45 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
          showStatsInsight(state.statsInsightIndex + (deltaX < 0 ? 1 : -1));
        },
        { passive: true }
      );
    }

    document.querySelector("#seizure-form")?.addEventListener("submit", saveSeizure);
    document.querySelector("#note-form")?.addEventListener("submit", saveNote);
    document.querySelector("#vet-form")?.addEventListener("submit", saveVetVisit);
    document.querySelector("#blood-test-form")?.addEventListener("submit", saveBloodTest);
    document.querySelector("#vet-document-form")?.addEventListener("submit", uploadVetDocument);
    document.querySelector("#history-search-form")?.addEventListener("submit", searchHistory);
    document.querySelector("#setup-form")?.addEventListener("submit", saveSetup);
    document.querySelector("#sync-config-form")?.addEventListener("submit", saveSyncConfig);
    document.querySelector("#access-form")?.addEventListener("submit", saveAccessCode);

    document.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", () => handleAction(button.dataset.action));
    });

    document.querySelectorAll("[data-view-vet-document]").forEach((button) => {
      button.addEventListener("click", () => openVetDocument(button.dataset.viewVetDocument));
    });

    document.querySelectorAll("[data-delete-vet-document]").forEach((button) => {
      button.addEventListener("click", () => deleteVetDocument(button.dataset.deleteVetDocument));
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

  function showHomeInsight(index, options = {}) {
    const container = document.querySelector("[data-home-insight]");
    if (!container) return;
    const insights = buildHomeInsights(getSummary());
    if (!insights.length) return;

    const signature = insights.map((insight) => `${insight.title}:${insight.body}`).join("|");
    if (signature !== state.homeInsightSignature) {
      state.homeInsightSignature = signature;
      index = 0;
    }

    state.homeInsightIndex = ((index % insights.length) + insights.length) % insights.length;
    const insight = insights[state.homeInsightIndex];
    const copy = container.querySelector(".home-insight-copy");
    const title = container.querySelector("[data-home-insight-title]");
    const body = container.querySelector("[data-home-insight-body]");
    const counter = container.querySelector("[data-insight-counter]");
    if (title) title.textContent = insight.title;
    if (body) body.textContent = insight.body;
    if (counter) counter.textContent = `${state.homeInsightIndex + 1} of ${insights.length}`;
    if (copy) {
      copy.classList.remove("changing");
      void copy.offsetWidth;
      copy.classList.add("changing");
    }

    container.querySelectorAll("[data-insight-index]").forEach((button) => {
      const active = Number(button.dataset.insightIndex) === state.homeInsightIndex;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "true" : "false");
    });

    if (options.restart !== false) startHomeInsightRotation();
  }

  function startHomeInsightRotation() {
    clearInterval(state.homeInsightTimer);
    state.homeInsightTimer = null;
    if (state.activeTab !== "today" || !document.querySelector("[data-home-insight]")) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    if (buildHomeInsights(getSummary()).length < 2) return;

    state.homeInsightTimer = setInterval(() => {
      if (!document.hidden) showHomeInsight(state.homeInsightIndex + 1, { restart: false });
    }, 10000);
  }

  function showStatsInsight(index) {
    const container = document.querySelector("[data-stats-insight]");
    if (!container) return;
    const insights = buildInsights(getSummary());
    if (!insights.length) return;

    const signature = insights.map((insight) => `${insight.title}:${insight.body}`).join("|");
    if (signature !== state.statsInsightSignature) {
      state.statsInsightSignature = signature;
      index = 0;
    }

    state.statsInsightIndex = ((index % insights.length) + insights.length) % insights.length;
    const insight = insights[state.statsInsightIndex];
    const copy = container.querySelector(".stats-observation-copy");
    const kicker = container.querySelector("[data-stats-insight-kicker]");
    const title = container.querySelector("[data-stats-insight-title]");
    const body = container.querySelector("[data-stats-insight-body]");
    const counter = container.querySelector("[data-stats-insight-counter]");
    if (kicker) kicker.textContent = `Observation ${String(state.statsInsightIndex + 1).padStart(2, "0")}`;
    if (title) title.textContent = insight.title;
    if (body) body.textContent = insight.body;
    if (counter) counter.textContent = `${state.statsInsightIndex + 1} of ${insights.length}`;
    if (copy) {
      copy.classList.remove("changing");
      void copy.offsetWidth;
      copy.classList.add("changing");
    }

    container.querySelectorAll("[data-stats-insight-index]").forEach((button) => {
      const active = Number(button.dataset.statsInsightIndex) === state.statsInsightIndex;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "true" : "false");
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
    const horizontalScrolls = [".home-month-chart", ".stats-month-chart"]
      .map((selector) => {
        const element = document.querySelector(selector);
        return element ? { selector, scrollLeft: element.scrollLeft } : null;
      })
      .filter(Boolean);
    return () => requestAnimationFrame(() => {
      if (useWindowScroll) {
        window.scrollTo({ top: scrollTop, left: 0, behavior: "auto" });
      } else {
        const nextContent = document.querySelector(".content");
        if (nextContent) nextContent.scrollTop = scrollTop;
      }
      horizontalScrolls.forEach(({ selector, scrollLeft }) => {
        const element = document.querySelector(selector);
        if (element) element.scrollLeft = scrollLeft;
      });
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
    try {
      if (state.settings?.syncEnabled && hasStoredAccess() && navigator.onLine) {
        const result = await syncWithSupabase({ silent: true });
        await loadVetDocuments({ silent: true });
        render();
        if (!options.silent) showToast(result.message);
      } else {
        render();
        if (!options.silent) {
          showToast(hasStoredAccess() ? "Internet is required to refresh Supabase." : "This device is not connected to Supabase yet.");
        }
      }
    } catch (error) {
      render();
      if (!options.silent) showToast(error.message || "Supabase refresh failed.");
    }
    checkReminders();
  }

  async function handleAction(action) {
    if (action === "quick-note") {
      state.activeTab = "log";
      render();
      setTimeout(() => {
        const noteTitle = document.querySelector("#note-title");
        if (noteTitle?.closest("details")) noteTitle.closest("details").open = true;
        noteTitle?.focus();
      }, 50);
    }
    if (action === "install-app") installApp();
    if (action === "enable-reminders") enableReminders();
    if (action === "disable-reminders") disableReminders();
    if (action === "export-json") exportJson();
    if (action === "import-json") importJson();
    if (action === "export-csv") exportCsv();
    if (action === "sync-now") refreshApp();
    if (action === "generate-ai") generateAiInsights();
    if (action === "sign-out") signOut();
    if (action === "reset-data") resetData();
    if (action === "cancel-seizure-edit") cancelSeizureEdit();
    if (action === "cancel-record-edit") cancelRecordEdit();
    if (action === "clear-history-search") {
      state.timelineSearch = "";
      state.timelineLimit = HISTORY_PAGE_SIZE;
      render();
    }
    if (action === "history-more") {
      const restoreScroll = captureContentScroll();
      state.timelineLimit += HISTORY_PAGE_SIZE;
      render();
      restoreScroll();
    }
  }

  function searchHistory(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.timelineSearch = String(form.get("query") || "").trim();
    state.timelineLimit = HISTORY_PAGE_SIZE;
    render();
  }

  async function persistEventMutation(record) {
    const records = await dbGetAll("events");
    const nextById = new Map(records.map((item) => [item.id, item]));
    nextById.set(record.id, record);
    const nextRecords = Array.from(nextById.values());
    const clusterUpdates = buildAutomaticClusterUpdates(nextRecords);
    const writesById = new Map([[record.id, record]]);
    clusterUpdates.forEach((item) => writesById.set(item.id, item));
    return persistCloudRecords({
      storeName: "events",
      tableName: SUPABASE_TABLES.events,
      records: Array.from(writesById.values())
    });
  }

  function cloudSaveBlockMessage() {
    if (!hasSupabaseConfig()) return "Supabase is not configured yet.";
    if (!state.settings?.syncEnabled) return "Supabase sync is not enabled yet.";
    if (!hasStoredAccess()) return "Enter the household access code before saving Sawyer's records.";
    if (!navigator.onLine) return "Internet is required before saving Sawyer's records.";
    return "Supabase is not ready yet.";
  }

  function canSaveCloudRecord() {
    if (hasSupabaseConfig() && state.settings?.syncEnabled && hasStoredAccess() && navigator.onLine) return true;
    const message = cloudSaveBlockMessage();
    state.syncMessage = message;
    showToast(message);
    if (!hasStoredAccess()) render();
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

    try {
      await persistEventMutation(event);
      await hydrate();
      render();
      restoreScroll();
      showToast(`${entry.schedule.name} marked ${status}.`);
    } catch (error) {
      reportCloudSaveFailure(error);
      restoreScroll();
    }
  }

  async function removeEvent(id, message) {
    if (!canSaveCloudRecord()) return;
    const restoreScroll = captureContentScroll();
    const existing = await dbGet("events", id);
    if (!existing) return;

    try {
      const timestamp = nowIso();
      await persistEventMutation({
        ...existing,
        deletedAt: timestamp,
        updatedAt: timestamp,
        syncStatus: "local"
      });
      if (state.editingSeizureId === id) state.editingSeizureId = "";
      if (state.editingRecordId === id) state.editingRecordId = "";
      await hydrate();
      render();
      restoreScroll();
      showToast(message);
    } catch (error) {
      reportCloudSaveFailure(error);
      restoreScroll();
    }
  }

  async function editSeizure(id) {
    const existing = state.events.find((event) => event.id === id && event.type === "seizure") || (await dbGet("events", id));
    if (!existing || existing.type !== "seizure") {
      showToast("That seizure record could not be opened.");
      return;
    }

    state.editingSeizureId = existing.id;
    state.editingRecordId = "";
    state.severity = existing.severity || 3;
    state.activeTab = "log";
    render();
    setTimeout(() => document.querySelector("#seizure-date")?.focus(), 50);
  }

  function cancelSeizureEdit() {
    state.editingSeizureId = "";
    render();
  }

  function editRecord(id) {
    const record = state.events.find(
      (event) => event.id === id && ["note", "vet_visit", "blood_test"].includes(event.type)
    );
    if (!record) {
      showToast("That record could not be opened.");
      return;
    }
    state.editingRecordId = id;
    state.editingSeizureId = "";
    state.activeTab = "log";
    render();
  }

  function cancelRecordEdit() {
    state.editingRecordId = "";
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
    const durationSeconds = clamp(Number(form.get("durationSeconds") || 0), 0, 120);
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

    try {
      await persistEventMutation(record);
      if (existing) state.editingSeizureId = "";
      await hydrate();
      const savedRecord = state.events.find((item) => item.id === record.id) || record;
      const clusterDetected = isAutomaticCluster(savedRecord);
      state.activeTab = "today";
      render();
      showToast(
        clusterDetected
          ? `${existing ? "Seizure updated" : "Seizure saved"}. Multiple seizures were logged within 24 hours.`
          : existing
            ? "Seizure updated."
            : "Seizure saved."
      );
    } catch (error) {
      reportCloudSaveFailure(error);
    }
  }

  async function saveNote(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const existingId = String(form.get("id") || "").trim();
    const existing = existingId ? await dbGet("events", existingId) : null;
    const title = String(form.get("title") || "Care note").trim() || "Care note";
    const body = String(form.get("body") || "").trim();
    if (!body) return;
    const timestamp = nowIso();

    const record = {
      id: existing?.id || uid(),
      dogId: DOG_ID,
      type: "note",
      dayKey: existing?.dayKey || localDateKey(new Date()),
      occurredAt: existing?.occurredAt || timestamp,
      title,
      body,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      syncStatus: "local"
    };

    try {
      await persistEventMutation(record);
      await hydrate();
      if (existing) state.editingRecordId = "";
      state.activeTab = "today";
      render();
      showToast(existing ? "Note updated." : "Note saved.");
    } catch (error) {
      reportCloudSaveFailure(error);
    }
  }

  async function saveVetVisit(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const existingId = String(form.get("id") || "").trim();
    const existing = existingId ? await dbGet("events", existingId) : null;
    const date = String(form.get("date") || toDateInputValue(new Date()));
    const time = String(form.get("time") || "12:00");
    const occurredAt = new Date(`${date}T${time}`);
    const timestamp = nowIso();

    const record = {
      id: existing?.id || uid(),
      dogId: DOG_ID,
      type: "vet_visit",
      dayKey: localDateKey(occurredAt),
      occurredAt: occurredAt.toISOString(),
      clinic: String(form.get("clinic") || "").trim(),
      reason: String(form.get("reason") || "Vet visit").trim() || "Vet visit",
      weight: String(form.get("weight") || "").trim(),
      plan: String(form.get("plan") || "").trim(),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      syncStatus: "local"
    };

    try {
      await persistEventMutation(record);
      await hydrate();
      if (existing) state.editingRecordId = "";
      state.activeTab = "today";
      render();
      showToast(existing ? "Vet visit updated." : "Vet visit saved.");
    } catch (error) {
      reportCloudSaveFailure(error);
    }
  }

  async function saveBloodTest(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const existingId = String(form.get("id") || "").trim();
    const existing = existingId ? await dbGet("events", existingId) : null;
    const date = String(form.get("date") || toDateInputValue(new Date()));
    const time = String(form.get("time") || "12:00");
    const occurredAt = new Date(`${date}T${time}`);
    const timestamp = nowIso();
    const phenobarbital = readLabLevel(form, "phenobarbital");
    const bromide = readLabLevel(form, "bromide");

    const record = {
      id: existing?.id || uid(),
      dogId: DOG_ID,
      type: "blood_test",
      dayKey: localDateKey(occurredAt),
      occurredAt: occurredAt.toISOString(),
      panel: String(form.get("panel") || "Blood test").trim() || "Blood test",
      phenobarbital,
      bromide,
      phenobarbitalLevel: phenobarbital ? formatLabLevel(phenobarbital) : existing?.phenobarbitalLevel || "",
      bromideLevel: bromide ? formatLabLevel(bromide) : existing?.bromideLevel || "",
      results: String(form.get("results") || "").trim(),
      notes: String(form.get("notes") || "").trim(),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      syncStatus: "local"
    };

    try {
      await persistEventMutation(record);
      await hydrate();
      if (existing) state.editingRecordId = "";
      state.activeTab = "today";
      render();
      showToast(existing ? "Blood test updated." : "Blood test saved.");
    } catch (error) {
      reportCloudSaveFailure(error);
    }
  }

  function readLabLevel(form, prefix) {
    const rawValue = String(form.get(`${prefix}Value`) || "").trim();
    if (!rawValue) return null;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return null;
    return {
      value,
      unit: String(form.get(`${prefix}Unit`) || "").trim(),
      referenceRange: String(form.get(`${prefix}ReferenceRange`) || "").trim()
    };
  }

  function formatLabLevel(level) {
    if (!level || !Number.isFinite(Number(level.value))) return "";
    return [String(level.value), level.unit || "", level.referenceRange ? `(target ${level.referenceRange})` : ""]
      .filter(Boolean)
      .join(" ");
  }

  async function loadVetDocuments(options = {}) {
    if (!hasSupabaseConfig() || !isSignedIn() || !navigator.onLine) {
      state.vetDocuments = [];
      return;
    }

    try {
      const client = await requireSupabaseSession();
      const { data, error } = await client
        .from(SUPABASE_TABLES.documents)
        .select("id,file_name,content_type,size_bytes,category,document_date,notes,created_at,updated_at")
        .eq("household_id", state.settings.supabaseHouseholdId)
        .order("document_date", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      state.vetDocuments = data || [];
      state.documentsMessage = "";
    } catch (error) {
      state.documentsMessage = error.message || "Vet documents could not be loaded.";
      if (!options.silent) showToast(state.documentsMessage);
    }
  }

  async function invokeVetDocumentAction(action, payload = {}) {
    const client = state.supabaseClient || (await initSupabase());
    if (!client) throw new Error("Supabase is not available.");
    const { data, error } = await client.functions.invoke("sawyer-vet-documents", {
      headers: state.householdAccessHash ? { [ACCESS_HEADER]: state.householdAccessHash } : {},
      body: {
        action,
        householdId: state.settings.supabaseHouseholdId,
        ...payload
      }
    });
    if (error) {
      let message = error.message || "Document request failed.";
      try {
        const details = await error.context?.json();
        if (details?.message) message = details.message;
      } catch {
        // Keep the original function error.
      }
      throw new Error(message);
    }
    return data || {};
  }

  async function uploadVetDocument(event) {
    event.preventDefault();
    if (!canSaveCloudRecord() || state.documentsBusy) return;

    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || !file.name) {
      showToast("Choose a PDF first.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      showToast("Choose a PDF document.");
      return;
    }
    if (file.size <= 0 || file.size > MAX_VET_DOCUMENT_BYTES) {
      showToast("PDFs must be 20 MB or smaller.");
      return;
    }

    const restoreScroll = captureContentScroll();
    let uploadSession = null;
    state.documentsBusy = true;
    state.documentsMessage = "Preparing secure upload...";
    render();
    restoreScroll();

    try {
      uploadSession = await invokeVetDocumentAction("create-upload", {
        fileName: file.name,
        sizeBytes: file.size
      });
      const client = state.supabaseClient || (await initSupabase());
      if (!client) throw new Error("Supabase is not available.");

      state.documentsMessage = "Uploading PDF...";
      render();
      restoreScroll();
      const { error: uploadError } = await client.storage
        .from(VET_DOCUMENT_BUCKET)
        .uploadToSignedUrl(
          uploadSession.storagePath,
          uploadSession.token,
          file,
          {
            contentType: "application/pdf",
            upsert: false
          }
        );
      if (uploadError) throw uploadError;

      await invokeVetDocumentAction("finalize-upload", {
        ...uploadSession,
        fileName: file.name,
        sizeBytes: file.size,
        category: String(form.get("category") || "other"),
        documentDate: String(form.get("documentDate") || ""),
        notes: String(form.get("notes") || "")
      });

      await loadVetDocuments({ silent: true });
      state.documentsMessage = "";
      showToast("Vet PDF uploaded.");
    } catch (error) {
      if (uploadSession?.documentId && uploadSession?.storagePath) {
        await invokeVetDocumentAction("abort-upload", uploadSession).catch(() => {});
      }
      state.documentsMessage = error.message || "PDF upload failed.";
      showToast(state.documentsMessage);
    } finally {
      state.documentsBusy = false;
      render();
      restoreScroll();
    }
  }

  async function openVetDocument(documentId) {
    if (!documentId || state.documentsBusy) return;
    const viewer = window.open("", "_blank");
    try {
      const data = await invokeVetDocumentAction("create-view-url", { documentId });
      if (!data.url) throw new Error("A secure document link could not be created.");
      if (viewer) {
        viewer.opener = null;
        viewer.location.href = data.url;
      } else {
        window.location.href = data.url;
      }
    } catch (error) {
      if (viewer) viewer.close();
      showToast(error.message || "Document could not be opened.");
    }
  }

  async function deleteVetDocument(documentId) {
    if (!documentId || state.documentsBusy) return;
    if (!confirm("Delete this vet PDF permanently?")) return;

    const restoreScroll = captureContentScroll();
    state.documentsBusy = true;
    state.documentsMessage = "Deleting PDF...";
    render();
    restoreScroll();
    try {
      await invokeVetDocumentAction("delete", { documentId });
      await loadVetDocuments({ silent: true });
      state.documentsMessage = "";
      showToast("Vet PDF deleted.");
    } catch (error) {
      state.documentsMessage = error.message || "Document could not be deleted.";
      showToast(state.documentsMessage);
    } finally {
      state.documentsBusy = false;
      render();
      restoreScroll();
    }
  }

  async function saveSetup(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const timestamp = nowIso();
    const dogName = String(form.get("dogName") || "Sawyer").trim() || "Sawyer";
    const regimenChanges = [];

    const updatedProfile = {
      ...state.profile,
      name: dogName,
      updatedAt: timestamp,
      syncStatus: "local"
    };

    const updatedSchedules = state.schedules.map((schedule) => ({
      ...schedule,
      dose: String(form.get(`${schedule.id}:dose`) || "").trim(),
      unit: String(form.get(`${schedule.id}:unit`) || "").trim(),
      effectiveFrom: String(form.get(`${schedule.id}:effectiveFrom`) || "").trim(),
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
      const previous = scheduleRegimenSnapshot(original);
      const next = scheduleRegimenSnapshot(updated);
      if (JSON.stringify(previous) === JSON.stringify(next)) return;

      const effectiveDate = updated.effectiveFrom || localDateKey(new Date());
      const occurredAt = updated.effectiveFrom
        ? localTimeToDate(updated.effectiveFrom, "12:00").toISOString()
        : timestamp;
      regimenChanges.push({
        id: uid(),
        dogId: DOG_ID,
        type: "regimen_change",
        scheduleId: updated.id,
        medicationName: updated.name,
        kind: updated.kind,
        effectiveFrom: updated.effectiveFrom || "",
        effectiveDateKnown: Boolean(updated.effectiveFrom),
        previous,
        next,
        dayKey: effectiveDate,
        occurredAt,
        createdAt: timestamp,
        updatedAt: timestamp,
        syncStatus: "local"
      });
    });

    try {
      await persistCloudRecords({
        storeName: "profile",
        tableName: SUPABASE_TABLES.dogs,
        records: [updatedProfile]
      });
      await persistCloudRecords({
        storeName: "schedules",
        tableName: SUPABASE_TABLES.schedules,
        records: updatedSchedules
      });
      if (regimenChanges.length) {
        await persistCloudRecords({
          storeName: "events",
          tableName: SUPABASE_TABLES.events,
          records: regimenChanges
        });
      }
      await hydrate();
      render();
      showToast("Setup saved.");
    } catch (error) {
      reportCloudSaveFailure(error);
    }
  }

  function scheduleRegimenSnapshot(schedule) {
    return {
      dose: schedule.dose || "",
      unit: schedule.unit || "",
      effectiveFrom: schedule.effectiveFrom || "",
      times: (schedule.times || []).map((time) => ({
        id: time.id,
        label: time.label,
        time: time.time
      }))
    };
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
      await syncWithSupabase({ silent: true });
      await loadVetDocuments({ silent: true });
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
      state.vetDocuments = [];
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
    if (!state.settings?.syncEnabled || !hasStoredAccess() || !navigator.onLine) return;
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => {
      syncWithSupabase({ silent: true }).catch(() => {});
    }, 1500);
  }

  async function syncWithSupabase(options = {}) {
    return state.syncFlight.run(() => runSupabaseSync(options));
  }

  async function runSupabaseSync(options = {}) {
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
      return { ok: true, uploaded, downloaded, message };
    } catch (error) {
      state.syncMessage = error.message || "Sync failed.";
      if (!silent) showToast(state.syncMessage);
      throw error;
    } finally {
      state.syncBusy = false;
      if (!silent) render();
    }
  }

  async function persistCloudRecords({ storeName, tableName, records }) {
    if (!records.length) return [];
    if (!navigator.onLine) throw new Error("Internet is required before saving Sawyer's records.");

    const client = await requireSupabaseSession();
    const householdId = state.settings?.supabaseHouseholdId;
    if (!householdId) throw new Error("Sawyer's household is not configured.");

    const rows = records.map((record) => localToRemoteRow(householdId, record));
    const { data, error } = await client
      .from(tableName)
      .upsert(rows, { onConflict: "household_id,id" })
      .select("id,updated_at,deleted_at");
    if (error) throw error;
    if ((data || []).length !== rows.length) {
      throw new Error("Supabase did not confirm every record. Nothing was marked as saved on this device.");
    }

    const confirmed = records.map((record) => ({
      ...record,
      syncStatus: "synced"
    }));
    await dbBulkPut(storeName, confirmed);
    state.accessVerified = true;
    return confirmed;
  }

  function reportCloudSaveFailure(error) {
    const detail = error?.message || "Supabase did not confirm this change.";
    state.syncMessage = `Not saved: ${detail}`;
    showToast(state.syncMessage);
  }

  async function syncStore({ client, householdId, storeName, tableName, localRecords }) {
    const remoteRows = await fetchAllRemoteRows(client, householdId, tableName);
    const planOptions = {
      toLocal: remotePayloadToLocal,
      isNewer,
      preferRemote: (local, remote) => shouldPreferRemoteSeed(storeName, local, remote)
    };
    const downloadPlan = CORE.buildSyncPlan(localRecords, remoteRows, planOptions);
    let downloaded = 0;

    for (const remoteRecord of downloadPlan.downloads) {
      await dbPut(storeName, remoteRecord);
      downloaded += 1;
    }

    const refreshedLocalRecords =
      storeName === "profile"
        ? [await dbGet("profile", DOG_ID)].filter(Boolean)
        : await dbGetAll(storeName);
    const uploads = CORE.buildSyncPlan(refreshedLocalRecords, remoteRows, planOptions).uploads;

    if (uploads.length) {
      for (const batch of CORE.chunk(uploads, SYNC_UPLOAD_BATCH_SIZE)) {
        const rows = batch.map((record) => localToRemoteRow(householdId, record));
        const { error: upsertError } = await client
          .from(tableName)
          .upsert(rows, { onConflict: "household_id,id" });
        if (upsertError) throw upsertError;
      }

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

  async function fetchAllRemoteRows(client, householdId, tableName) {
    return CORE.fetchAllRemoteRows(client, householdId, tableName, SYNC_PAGE_SIZE);
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
    return CORE.automaticClusterIds(seizures, CLUSTER_WINDOW_MS);
  }

  function seizuresShareClusterWindow(first, second) {
    return CORE.seizuresShareClusterWindow(first, second, CLUSTER_WINDOW_MS);
  }

  function isAutomaticCluster(event, seizures = state.events) {
    if (!event || event.type !== "seizure") return false;
    return automaticClusterIds(seizures).has(event.id);
  }

  async function refreshAutomaticClusterFlags() {
    const records = await dbGetAll("events");
    const updates = buildAutomaticClusterUpdates(records);
    if (updates.length) await dbBulkPut("events", updates);
    return updates.length;
  }

  function buildAutomaticClusterUpdates(records) {
    const clusteredIds = automaticClusterIds(records);
    const timestamp = nowIso();
    return records
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
  }

  function getSummary() {
    const seizures = getSeizuresAsc();
    const now = new Date();
    const last = seizures.at(-1);
    const gaps = getSeizureGaps(seizures);
    const episodeGaps = CORE.seizureEpisodeGaps(seizures, CLUSTER_WINDOW_MS);
    const durations = seizures.map((event) => event.durationSeconds || 0).filter(Boolean);
    const monthKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const thisMonthSeizures = seizures.filter((event) => eventDayKey(event).startsWith(monthKey)).length;

    const lastSeizureAt = last ? seizureCounterReferenceTime(last) : null;
    const elapsedSinceLastMs = lastSeizureAt ? Math.max(0, now - lastSeizureAt) : null;
    const daysSinceLast = elapsedSinceLastMs === null ? null : Math.floor(elapsedSinceLastMs / 86400000);
    const longestGap = gaps.length ? Math.max(...gaps.map((gap) => gap.days)) : null;
    const averageGap = gaps.length ? mean(gaps.map((gap) => gap.days)) : null;
    const homeLongestGap = episodeGaps.length ? Math.max(...episodeGaps.map((gap) => gap.days)) : null;
    const homeAverageGap = episodeGaps.length ? mean(episodeGaps.map((gap) => gap.days)) : null;
    const averageDuration = durations.length ? mean(durations) : null;

    return {
      totalSeizures: seizures.length,
      daysSinceLast,
      elapsedSinceLastMs,
      lastSeizureText: last ? `Last seizure: ${formatEventDateTime(last)}` : "No seizure logged yet",
      averageGapText: averageGap ? `${round1(averageGap)} days` : "--",
      longestGapText: longestGap ? `${round1(longestGap)} days` : "--",
      homeAverageGapText: homeAverageGap ? `${round1(homeAverageGap)} days` : "--",
      homeLongestGapText: homeLongestGap ? `${round1(homeLongestGap)} days` : "--",
      averageDurationText: averageDuration ? formatDuration(Math.round(averageDuration)) : "--",
      thisMonthSeizures
    };
  }

  function seizureCounterReferenceTime(event) {
    const occurredAt = new Date(event.occurredAt);
    if (event.timeKnown !== false) return occurredAt;

    const createdAt = new Date(event.createdAt);
    if (
      !Number.isNaN(createdAt.getTime()) &&
      eventDayKey(event) === localDateKey(createdAt)
    ) {
      return createdAt;
    }
    return occurredAt;
  }

  function seizureFreeTone(summary) {
    if (summary.elapsedSinceLastMs === null) return "no-history";
    if (summary.elapsedSinceLastMs < 86400000) return "recent-seizure";
    if (summary.elapsedSinceLastMs < 5 * 86400000) return "building-streak";
    return "calm-streak";
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

    if (gaps.length && summary.daysSinceLast !== null) {
      const completedAverage = mean(gaps.map((gap) => gap.days));
      const completedLongest = Math.max(...gaps.map((gap) => gap.days));
      const currentInterval = summary.daysSinceLast;
      if (currentInterval > completedLongest) {
        insights.push({
          title: "Longest current interval",
          body: `${currentInterval} days have passed since the last logged seizure. That is ${round1(currentInterval - completedLongest)} days beyond Sawyer's longest completed gap in this record.`
        });
      } else if (Math.abs(currentInterval - completedAverage) >= 1) {
        const difference = Math.abs(currentInterval - completedAverage);
        insights.push({
          title: "Current interval",
          body: `${currentInterval} days have passed since the last logged seizure, ${round1(difference)} days ${currentInterval >= completedAverage ? "longer" : "shorter"} than the historical average gap of ${round1(completedAverage)} days.`
        });
      }
    }

    if (gaps.length >= 2) {
      const recent = gaps.at(-1).days;
      const previousAverage = mean(gaps.slice(0, -1).map((gap) => gap.days));
      const direction = recent >= previousAverage ? "farther apart" : "closer together";
      insights.push({
        title: "Recent spacing",
        body: `The latest seizure gap was ${round1(recent)} days. Previous gaps averaged ${round1(previousAverage)} days, so the latest logged gap is ${direction}.`
      });
    }

    if (seizures.length >= 3) {
      const now = Date.now();
      const thirtyDays = 30 * 86400000;
      const recentCount = seizures.filter((event) => {
        const time = new Date(event.occurredAt).getTime();
        return time <= now && time > now - thirtyDays;
      }).length;
      const previousCount = seizures.filter((event) => {
        const time = new Date(event.occurredAt).getTime();
        return time <= now - thirtyDays && time > now - 2 * thirtyDays;
      }).length;
      if (recentCount !== previousCount && recentCount + previousCount > 0) {
        insights.push({
          title: "30-day frequency",
          body: `${recentCount} seizure${recentCount === 1 ? "" : "s"} were logged in the most recent 30 days, compared with ${previousCount} in the preceding 30 days.`
        });
      }
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

    const severityValues = seizures
      .map((event) => Number(event.severity))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (severityValues.length >= 5) {
      const recentSeverity = mean(severityValues.slice(-3));
      const earlierSeverity = mean(severityValues.slice(0, -3));
      if (Math.abs(recentSeverity - earlierSeverity) >= 0.4) {
        insights.push({
          title: "Logged severity trend",
          body: `The latest three seizures average severity ${round1(recentSeverity)}, compared with ${round1(earlierSeverity)} across earlier records.`
        });
      }
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

  function buildHomeInsights(summary) {
    const insights = buildInsights(summary).filter((insight) => insight.title !== "Vet wording");
    const latestBlood = latestEventOfType("blood_test");
    const clusterInsight = insights.find((insight) => insight.title === "Cluster pattern detected");
    const ordered = [];

    if (clusterInsight) ordered.push(clusterInsight);

    if (latestBlood?.phenobarbitalLevel || latestBlood?.bromideLevel) {
      const levels = [
        latestBlood.phenobarbitalLevel ? `phenobarbital ${latestBlood.phenobarbitalLevel}` : "",
        latestBlood.bromideLevel ? `bromide ${latestBlood.bromideLevel}` : ""
      ].filter(Boolean);
      ordered.push({
        title: "Blood result saved",
        body: `${latestBlood.panel || "Latest blood test"} includes ${levels.join(" and ")}. Compare this with future seizure spacing in Stats.`
      });
    }

    insights.forEach((insight) => {
      if (insight === clusterInsight) return;
      if (
        (latestBlood?.phenobarbitalLevel || latestBlood?.bromideLevel) &&
        insight.title === "Latest blood test"
      ) {
        return;
      }
      ordered.push(insight);
    });

    if (!ordered.length) {
      ordered.push({
        title: "Start building a pattern",
        body: `${state.profile?.name || "Sawyer"}'s medication plan is tracked automatically. Add seizure, vet, and blood-test records as they happen.`
      });
    }

    return ordered
      .filter(
        (insight, index, all) =>
          all.findIndex((candidate) => candidate.title === insight.title && candidate.body === insight.body) === index
      )
      .slice(0, 8);
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
    return {
      total: CORE.countSeizuresNearDoseException(state.events, seizures, OVERDUE_MINUTES)
    };
  }

  function buildMctInsight(seizures, gaps) {
    const metrics = CORE.mctInsightMetrics(state.events, state.schedules, gaps);
    if (!metrics) return null;
    const beforeAvg = metrics.beforeAverage;
    const afterAvg = metrics.afterAverage;
    const direction = afterAvg >= beforeAvg ? "longer" : "shorter";

    return {
      title: "MCT oil context",
      body: `Logged seizure gaps average ${round1(beforeAvg)} days before the recorded MCT regimen start and ${round1(afterAvg)} days after. The after-MCT logged gaps are ${direction} so far.`
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
    return getStatsMonthlyData("6");
  }

  function getStatsMonthlyData(range = "6") {
    const now = new Date();
    const seizures = getSeizuresAsc();
    const numericRange = Number(range);
    let monthCount = Number.isFinite(numericRange) ? numericRange : 6;
    if (range === "all" && seizures.length) {
      const first = new Date(seizures[0].occurredAt);
      monthCount =
        (now.getFullYear() - first.getFullYear()) * 12 +
        (now.getMonth() - first.getMonth()) +
        1;
    }
    monthCount = clamp(monthCount, 1, 120);
    const months = [];

    for (let index = monthCount - 1; index >= 0; index -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
      const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
      const monthSeizures = seizures.filter((event) => eventDayKey(event).startsWith(key));
      const severityValues = monthSeizures
        .map((event) => Number(event.severity))
        .filter((value) => Number.isFinite(value) && value > 0);
      const durationValues = monthSeizures
        .map((event) => Number(event.durationSeconds))
        .filter((value) => Number.isFinite(value) && value > 0);
      const timeWindow = mostCommonSeizureTime(monthSeizures);
      months.push({
        key,
        label: date.toLocaleDateString(undefined, { month: "short" }),
        yearLabel: date.toLocaleDateString(undefined, { year: "numeric" }),
        fullLabel: date.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
        count: monthSeizures.length,
        delta: 0,
        averageSeverityText: severityValues.length ? round1(mean(severityValues)).toString() : "--",
        averageDurationText: durationValues.length ? formatDuration(Math.round(mean(durationValues))) : "--",
        clusterCount: monthSeizures.filter((event) => event.cluster).length,
        timeWindowText: timeWindow ? timeWindow.label : "--",
        summary: describeStatsMonth(date, monthSeizures)
      });
    }

    months.forEach((item, index) => {
      item.delta = index === 0 ? 0 : item.count - months[index - 1].count;
    });

    return months;
  }

  function describeStatsMonth(date, seizures) {
    if (!seizures.length) {
      return `No seizures were logged in ${date.toLocaleDateString(undefined, { month: "long", year: "numeric" })}.`;
    }
    const first = seizures[0];
    const last = seizures.at(-1);
    if (seizures.length === 1) {
      return `One seizure was logged on ${formatDateShort(new Date(first.occurredAt))}.`;
    }
    return `${seizures.length} seizures were logged between ${formatDateShort(new Date(first.occurredAt))} and ${formatDateShort(new Date(last.occurredAt))}.`;
  }

  function filteredTimelineEvents() {
    const query = state.timelineSearch.trim().toLowerCase();
    return state.events
      .filter((event) => state.timelineFilter === "all" || event.type === state.timelineFilter)
      .filter((event) => !query || timelineSearchText(event).includes(query))
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
  }

  function timelineSearchText(event) {
    return [
      eventTitle(event),
      formatEventDateTime(event),
      event.medicationName,
      event.title,
      event.body,
      event.reason,
      event.clinic,
      event.plan,
      event.panel,
      event.results,
      event.notes,
      event.trigger,
      event.type === "regimen_change" ? formatRegimenSummary(event.next) : "",
      ...(event.symptoms || [])
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function timelineFilterCount(filterId) {
    if (filterId === "all") return state.events.length;
    return state.events.filter((event) => event.type === filterId).length;
  }

  function groupTimelineEvents(events) {
    const groups = [];
    events.forEach((event) => {
      const date = new Date(event.occurredAt);
      const dayKey = localDateKey(date);
      let group = groups.find((item) => item.dayKey === dayKey);
      if (!group) {
        group = { dayKey, date, events: [] };
        groups.push(group);
      }
      group.events.push(event);
    });
    return groups;
  }

  function eventTitle(event) {
    if (event.type === "seizure") return `Seizure · severity ${event.severity || "--"}`;
    if (event.type === "dose") return `${capitalize(event.status || "dose")} · ${event.medicationName || "Dose"}`;
    if (event.type === "note") return event.title || "Care note";
    if (event.type === "vet_visit") return `Vet visit · ${event.reason || event.clinic || "Checkup"}`;
    if (event.type === "blood_test") return `Blood test · ${event.panel || "Results"}`;
    if (event.type === "regimen_change") return `Regimen change · ${event.medicationName || "Medication"}`;
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
        formatLabLevel(event.phenobarbital) || event.phenobarbitalLevel
          ? `Phenobarbital: ${formatLabLevel(event.phenobarbital) || event.phenobarbitalLevel}`
          : "",
        formatLabLevel(event.bromide) || event.bromideLevel
          ? `Bromide: ${formatLabLevel(event.bromide) || event.bromideLevel}`
          : "",
        event.results ? `Results: ${event.results}` : "",
        event.notes ? `Notes: ${event.notes}` : ""
      ].filter(Boolean);
      return parts.map((part) => `<p class="subtle">${escapeHtml(part)}</p>`).join("");
    }

    if (event.type === "regimen_change") {
      const parts = [
        `Previous: ${formatRegimenSummary(event.previous)}`,
        `New: ${formatRegimenSummary(event.next)}`,
        event.effectiveDateKnown && event.effectiveFrom
          ? `Effective from: ${formatDateShort(localTimeToDate(event.effectiveFrom, "12:00"))}`
          : "Effective date was not recorded"
      ];
      return parts.map((part) => `<p class="subtle">${escapeHtml(part)}</p>`).join("");
    }

    return "";
  }

  function formatRegimenSummary(regimen) {
    if (!regimen) return "not recorded";
    const dose = [regimen.dose, regimen.unit].filter(Boolean).join(" ") || "dose not set";
    const times = (regimen.times || [])
      .map((time) => `${time.label || "Dose"} ${formatTimeInputValue(time.time || "")}`)
      .join(", ");
    return [dose, times].filter(Boolean).join(" · ");
  }

  async function exportJson() {
    if (!canSaveCloudRecord() || state.backupBusy) return;
    const restoreScroll = captureContentScroll();
    state.backupBusy = true;
    state.backupMessage = "Reading all records from Supabase...";
    render();
    restoreScroll();

    try {
      const fflate = await loadFflateLibrary();
      const client = await requireSupabaseSession();
      const householdId = state.settings.supabaseHouseholdId;
      await syncWithSupabase({ silent: true });

      const [dogs, schedules, events, documents] = await Promise.all([
        fetchAllRemoteRows(client, householdId, SUPABASE_TABLES.dogs),
        fetchAllRemoteRows(client, householdId, SUPABASE_TABLES.schedules),
        fetchAllRemoteRows(client, householdId, SUPABASE_TABLES.events),
        fetchAllVetDocumentRows(client, householdId)
      ]);

      const exportedAt = nowIso();
      const data = {
        app: "sawyer-tracker",
        version: 2,
        exportedAt,
        householdId,
        tables: { dogs, schedules, events, documents }
      };
      const archive = {};
      const manifestFiles = [];
      const dataBytes = fflate.strToU8(JSON.stringify(data, null, 2));
      archive["data.json"] = dataBytes;
      manifestFiles.push(await backupFileManifest("data.json", dataBytes, "application/json"));

      for (let index = 0; index < documents.length; index += 1) {
        const document = documents[index];
        state.backupMessage = `Downloading vet PDF ${index + 1} of ${documents.length}...`;
        render();
        restoreScroll();
        const { url } = await invokeVetDocumentAction("create-view-url", { documentId: document.id });
        if (!url) throw new Error(`A secure link could not be created for ${document.file_name}.`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not download ${document.file_name}.`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const path = `vet-documents/${document.id}/${sanitizeBackupFileName(document.file_name)}`;
        archive[path] = bytes;
        manifestFiles.push(
          await backupFileManifest(path, bytes, "application/pdf", document.id)
        );
      }

      const manifest = {
        app: "sawyer-tracker",
        formatVersion: 2,
        exportedAt,
        householdId,
        counts: {
          dogs: dogs.length,
          schedules: schedules.length,
          events: events.length,
          documents: documents.length
        },
        files: manifestFiles
      };
      archive["manifest.json"] = fflate.strToU8(JSON.stringify(manifest, null, 2));
      state.backupMessage = "Creating backup ZIP...";
      render();
      restoreScroll();

      const zip = fflate.zipSync(archive, { level: 6 });
      downloadBlob(
        zip,
        `sawyer-tracker-complete-backup-${localDateKey(new Date())}.zip`,
        "application/zip"
      );
      await updateSettings({ lastBackupAt: exportedAt });
      state.backupMessage = `Complete backup downloaded: ${events.length} records and ${documents.length} PDFs.`;
      showToast("Complete backup downloaded.");
    } catch (error) {
      state.backupMessage = error.message || "Complete backup failed.";
      showToast(state.backupMessage);
    } finally {
      state.backupBusy = false;
      render();
      restoreScroll();
    }
  }

  function importJson() {
    if (!canSaveCloudRecord() || state.backupBusy) return;
    const template = document.querySelector("#file-input-template");
    const input = template.content.firstElementChild.cloneNode();
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;

      const restoreScroll = captureContentScroll();
      state.backupBusy = true;
      state.backupMessage = "Validating backup...";
      render();
      restoreScroll();
      try {
        await restoreCompleteBackup(file, restoreScroll);
      } catch (error) {
        state.backupMessage = error.message || "That backup could not be restored.";
        showToast(state.backupMessage);
      } finally {
        state.backupBusy = false;
        render();
        restoreScroll();
      }
    });
    input.click();
  }

  async function restoreCompleteBackup(file, restoreScroll) {
    const fflate = await loadFflateLibrary();
    const archive = fflate.unzipSync(new Uint8Array(await file.arrayBuffer()));
    const manifestBytes = archive["manifest.json"];
    const dataBytes = archive["data.json"];
    if (!manifestBytes || !dataBytes) throw new Error("This is not a complete Sawyer Tracker backup.");

    const manifest = JSON.parse(fflate.strFromU8(manifestBytes));
    const data = JSON.parse(fflate.strFromU8(dataBytes));
    if (
      manifest.app !== "sawyer-tracker" ||
      manifest.formatVersion !== 2 ||
      data.app !== "sawyer-tracker" ||
      data.version !== 2
    ) {
      throw new Error("This backup version is not supported.");
    }
    if (
      manifest.householdId !== state.settings.supabaseHouseholdId ||
      data.householdId !== state.settings.supabaseHouseholdId
    ) {
      throw new Error("This backup belongs to a different household.");
    }

    for (const entry of manifest.files || []) {
      const bytes = archive[entry.path];
      if (!bytes) throw new Error(`Backup file is missing: ${entry.path}`);
      if (bytes.length !== entry.size || (await sha256HexBytes(bytes)) !== entry.sha256) {
        throw new Error(`Backup integrity check failed: ${entry.path}`);
      }
    }

    const { dogs, schedules, events, documents } = CORE.validateBackupEnvelope(
      manifest,
      data,
      archive,
      state.settings.supabaseHouseholdId
    );
    const confirmed = confirm(
      `Restore ${events.length} records, ${schedules.length} schedules and ${documents.length} vet PDF${documents.length === 1 ? "" : "s"} from this backup? Matching cloud records will be replaced; records created later and not in the backup will remain.`
    );
    if (!confirmed) {
      state.backupMessage = "Restore cancelled.";
      return;
    }

    const client = await requireSupabaseSession();
    const householdId = state.settings.supabaseHouseholdId;
    const restoreTime = nowIso();
    state.backupMessage = "Restoring cloud records...";
    render();
    restoreScroll();
    await restoreCloudTable(client, SUPABASE_TABLES.dogs, householdId, dogs, restoreTime);
    await restoreCloudTable(client, SUPABASE_TABLES.schedules, householdId, schedules, restoreTime);
    await restoreCloudTable(client, SUPABASE_TABLES.events, householdId, events, restoreTime);

    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      const entry = (manifest.files || []).find((item) => item.documentId === document.id);
      if (!entry || !archive[entry.path]) {
        throw new Error(`The PDF for ${document.file_name || document.id} is missing.`);
      }
      state.backupMessage = `Restoring vet PDF ${index + 1} of ${documents.length}...`;
      render();
      restoreScroll();
      await restoreVetDocument(client, document, archive[entry.path]);
    }

    await syncWithSupabase({ silent: true });
    await loadVetDocuments({ silent: true });
    state.backupMessage = `Restore complete: ${events.length} records and ${documents.length} PDFs verified.`;
    showToast("Backup restored to Supabase.");
  }

  async function restoreCloudTable(client, tableName, householdId, rows, restoreTime) {
    for (const sourceBatch of CORE.chunk(rows, SYNC_UPLOAD_BATCH_SIZE)) {
      const batch = sourceBatch.map((row) => ({
        household_id: householdId,
        id: row.id,
        dog_id: row.dog_id || DOG_ID,
        payload: {
          ...(row.payload || {}),
          updatedAt: restoreTime,
          syncStatus: "synced"
        },
        updated_at: restoreTime,
        deleted_at: row.deleted_at || null
      }));
      if (!batch.length) continue;
      const { error } = await client
        .from(tableName)
        .upsert(batch, { onConflict: "household_id,id" });
      if (error) throw error;
    }
  }

  async function restoreVetDocument(client, document, bytes) {
    const session = await invokeVetDocumentAction("create-restore-upload", {
      documentId: document.id,
      fileName: document.file_name,
      sizeBytes: bytes.length
    });
    const { error } = await client.storage
      .from(VET_DOCUMENT_BUCKET)
      .uploadToSignedUrl(
        session.storagePath,
        session.token,
        new Blob([bytes], { type: "application/pdf" }),
        { contentType: "application/pdf", upsert: true }
      );
    if (error) throw error;

    await invokeVetDocumentAction("finalize-restore", {
      ...session,
      fileName: document.file_name,
      sizeBytes: bytes.length,
      category: document.category,
      documentDate: document.document_date || "",
      notes: document.notes || "",
      createdAt: document.created_at || ""
    });
  }

  async function fetchAllVetDocumentRows(client, householdId) {
    const rows = [];
    for (let from = 0; ; from += SYNC_PAGE_SIZE) {
      const { data, error } = await client
        .from(SUPABASE_TABLES.documents)
        .select("*")
        .eq("household_id", householdId)
        .order("id", { ascending: true })
        .range(from, from + SYNC_PAGE_SIZE - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < SYNC_PAGE_SIZE) break;
    }
    return rows;
  }

  async function backupFileManifest(path, bytes, contentType, documentId = "") {
    return {
      path,
      contentType,
      size: bytes.length,
      sha256: await sha256HexBytes(bytes),
      ...(documentId ? { documentId } : {})
    };
  }

  async function sha256HexBytes(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function sanitizeBackupFileName(value) {
    return String(value || "Vet document.pdf")
      .replace(/[^a-z0-9._ -]+/gi, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "Vet document.pdf";
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
    return CORE.localDateKey(date);
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

  function formatHistoryDate(date) {
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric"
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

  function formatFileSize(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${round1(value / 1024)} KB`;
    return `${round1(value / (1024 * 1024))} MB`;
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
