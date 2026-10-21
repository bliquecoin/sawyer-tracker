(function () {
  "use strict";

  const DB_NAME = "sawyer-care-tracker";
  const DB_VERSION = 1;
  const DOG_ID = "sawyer";
  const OVERDUE_MINUTES = 45;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const CLUSTER_WINDOW_MS = DAY_MS;
  const HISTORY_PAGE_SIZE = 30;
  const SYNC_PAGE_SIZE = 500;
  const SYNC_UPLOAD_BATCH_SIZE = 200;
  const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0";
  const FFLATE_JS_URL = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js";
  const FALLBACK_APP_URL = "https://bliquecoin.github.io/sawyer-tracker/";
  const ACCESS_KEY_STORAGE = "sawyer-household-access-key-hash";
  const PUSH_DEVICE_STORAGE = "sawyer-push-device-id";
  const TIMER_STORAGE = "sawyer-seizure-timer";
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
    pushRegistration: null,
    supabaseClient: null,
    supabaseFingerprint: "",
    supabaseSession: null,
    householdAccessHash: readHouseholdAccessHash(),
    accessVerified: false,
    syncBusy: false,
    startupSync: false,
    syncFlight: CORE.createSingleFlight(),
    syncMessage: "",
    syncTimer: null,
    storageUnavailable: false,
    aiBusy: false,
    aiInsight: null,
    aiError: "",
    statsSelectedMonthKey: "",
    statsRange: "6",
    vetRange: 30,
    vetDocuments: [],
    documentsBusy: false,
    documentsMessage: "",
    backupBusy: false,
    backupMessage: "",
    pullRefreshing: false,
    editingSeizureId: "",
    editingRecordId: "",
    saveBusy: false,
    savingFormId: "",
    pendingRecords: [],
    lastSaveStatus: "synced",
    severity: 3,
    overlay: null,
    overlayFresh: false,
    overlayCloseTimer: null,
    seizurePrefill: null,
    timer: null,
    timerConfirmDiscard: false,
    wakeLock: null,
    lastPointer: null,
    renderedTab: "",
    sceneStart: 0,
    animatedMarkup: new Set()
  };
  const startedFromAuthRedirect = isAuthRedirectUrl();
  const memoryStores = {
    profile: new Map(),
    settings: new Map(),
    schedules: new Map(),
    events: new Map()
  };
  const SYNC = window.SawyerTrackerSync;
  const recordWork = SYNC.createSerialQueue();
  const { dbGetAll, dbGet, dbPut, dbBulkPut, dbDelete, dbClear } = window.SawyerTrackerStorage.create({
    state, memoryStores, clone, DB_NAME, DB_VERSION
  });
  const drafts = window.SawyerTrackerDrafts.create({
    storage: { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key), keys: () => Object.keys(localStorage) },
    householdId: () => state.settings?.supabaseHouseholdId || "unconfigured",
    onDiscard: () => render()
  });
  try {
    const previousView = JSON.parse(sessionStorage.getItem("sawyer-view") || "null");
    if (previousView && ["today", "timeline", "insights", "vet"].includes(previousView.activeTab)) {
      state.activeTab = previousView.activeTab;
      state.editingSeizureId = previousView.editingSeizureId || "";
      state.editingRecordId = previousView.editingRecordId || "";
      state.overlay = previousView.overlay?.kind && previousView.overlay.kind !== "timer" ? previousView.overlay : null;
      state.seizurePrefill = previousView.seizurePrefill || null;
    }
  } catch { /* Start on Today if session storage is unavailable. */ }
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
    carerName: "",
    pushNotificationsEnabled: false,
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
    document.documentElement.classList.add("boot");
    setTimeout(() => document.documentElement.classList.remove("boot"), 2400);
    state.timer = readTimer();
    // A running seizure timer always reopens, even after the app was closed.
    if (state.timer) state.overlay = { kind: "timer" };
    await registerServiceWorker();
    requestPersistentStorage();
    attachGlobalListeners();
    await safeHydrate();
    // The first sync shows as under way rather than "Not connected" while it runs.
    state.startupSync = Boolean(hasSupabaseConfig() && state.settings?.syncEnabled && hasStoredAccess() && navigator.onLine);
    render();
    try {
      await initSupabase();
      if (state.settings?.syncEnabled && hasStoredAccess() && navigator.onLine) {
        await syncWithSupabase({ silent: true }).catch(() => {});
        if (isSignedIn()) await loadVetDocuments({ silent: true });
      }
    } finally {
      state.startupSync = false;
      render();
    }
    const pushWasOn = state.settings?.pushNotificationsEnabled;
    await reconcilePushSubscription({ silent: true });
    if (state.settings?.pushNotificationsEnabled !== pushWasOn) render();
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

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    try {
      const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      state.pushRegistration = registration;
      registration.update().catch(() => {});
      return registration;
    } catch {
      state.pushRegistration = null;
      return null;
    }
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
        requestWakeLock();
        refreshApp({ silent: true }).catch(() => safeHydrate().then(render));
      }
    });

    document.addEventListener("pointerdown", (event) => {
      state.lastPointer = { x: event.clientX, y: event.clientY };
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !state.overlay) return;
      if (state.overlay.kind === "timer") handleAction("minimize-timer");
      else if (state.overlay.kind === "seizure" && state.editingSeizureId) cancelSeizureEdit();
      else closeOverlay();
    });

    document.addEventListener("pointerover", (event) => {
      const hit = event.target.closest?.(".hit");
      if (hit) showChartTip(hit);
    });
    document.addEventListener("pointerout", (event) => {
      if (event.target.closest?.(".hit")) hideChartTip();
    });
    document.addEventListener("focusin", (event) => {
      if (event.target.classList?.contains("hit")) showChartTip(event.target);
    });
    document.addEventListener("focusout", (event) => {
      if (event.target.classList?.contains("hit")) hideChartTip();
    });

    let resizeTimer = null;
    let lastWidth = window.innerWidth;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (window.innerWidth === lastWidth) return;
        lastWidth = window.innerWidth;
        if (["insights", "vet"].includes(state.activeTab) && !state.overlay) renderPreservingContentScroll();
      }, 250);
    });
    setInterval(updateTimerDisplay, 250);

    window.addEventListener("online", () => { render(); queueBackgroundSync(); });
    window.addEventListener("offline", render);
    setInterval(() => {
      if (!document.hidden && !state.saveBusy) queueBackgroundSync();
    }, 30000);
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
      script.onerror = () => { script.remove(); reject(new Error("Supabase library could not be loaded.")); };
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
      script.onerror = () => { script.remove(); reject(new Error("Backup tools could not be loaded.")); };
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
      await withTimeout(loadSupabaseLibrary(), 8000, "Cloud connection timed out. Saved records remain on this device.");
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
            fetch: async (url, options = {}) => {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 10000);
              const abort = () => controller.abort();
              options.signal?.addEventListener("abort", abort, { once: true });
              if (options.signal?.aborted) abort();
              try { return await fetch(url, { ...options, signal: controller.signal }); }
              finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
            },
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
        state.supabaseClient.auth.onAuthStateChange(async (event, session) => {
          // getSession() above already applied the stored session; redrawing for it again
          // would also briefly mark a household-code device as not verified.
          if (event === "INITIAL_SESSION") return;
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
    const allEvents = await dbGetAll("events");
    state.events = allEvents.filter((event) => !event.deletedAt);
    state.pendingRecords = [
      ...allEvents.map((record) => ({ storeName: "events", record })),
      ...schedules.map((record) => ({ storeName: "schedules", record })),
      { storeName: "profile", record: profile }
    ].filter(({ record }) => SYNC.pending(record));
  }

  const VIEW_TABS = ["today", "insights", "timeline", "vet"];
  // Pieces whose entrance animation should play again when a redraw changes them.
  const REPLAY_WHEN_CHANGED = ".chart, .mb-fill, .dstatus";
  const ROUTINES = {
    morning: { label: "Morning", icon: "sun", tone: "yellow" },
    night: { label: "Night", icon: "moon", tone: "berry" }
  };
  const TYPE_ICONS = { seizure: "timer", dose: "pill", note: "note", vet_visit: "vet", blood_test: "drop", regimen_change: "edit" };
  const ICONS = {
    home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>',
    list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.75" cy="6.5" r="1"/><circle cx="4.75" cy="12" r="1"/><circle cx="4.75" cy="17.5" r="1"/>',
    chart: '<path d="M3.5 20h17M6.5 20v-7M11.5 20V5M16.5 20v-10"/>',
    vet: '<path d="M6.5 3.5H5v5a4 4 0 0 0 8 0v-5h-1.5"/><path d="M9 12.5v2a5 5 0 0 0 10 0v-2"/><circle cx="19" cy="10.5" r="2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M6 12h12"/>',
    timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 2M9.5 3h5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    chev: '<path d="M9 5l7 7-7 7"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
    note: '<path d="M6 3.5h8.5L19 8v12a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20z"/><path d="M14 3.5V8h5M9 12.5h7M9 16h5"/>',
    drop: '<path d="M12 3.5c3.2 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.3-6 5.5-10z"/>',
    pill: '<rect x="2.8" y="8.6" width="18.4" height="6.8" rx="3.4" transform="rotate(-38 12 12)"/><path d="M9.7 8.8l4.6 6.4"/>',
    doc: '<path d="M6.5 3.5h8L19 8v12.5H6.5z"/><path d="M14.5 3.5V8H19"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    heart: '<path d="M12 19.5s-7.5-4.4-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.6-7.5 10-7.5 10z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="3"/><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.2"/>',
    edit: '<path d="M4.5 19.5l1-4.5L16 4.5l3.5 3.5L9 18.5z"/><path d="M13.5 7l3.5 3.5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    upload: '<path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
    sync: '<path d="M19.5 8.5A8 8 0 0 0 5 7.5M4.5 15.5A8 8 0 0 0 19 16.5"/><path d="M19.5 4v4.5H15M4.5 20v-4.5H9"/>'
  };

  function icon(name, className = "i") {
    return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  function filledIcon(name) {
    return `<svg class="i" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  function leaf(style) {
    return `<i class="leaf" style="${style}" aria-hidden="true"></i>`;
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  }

  function render() {
    const summary = getSummary();
    const focused = document.activeElement;
    const focusId = focused?.matches("input, textarea, select") ? focused.id : "";
    const selection = focusId && ["text", "search", "textarea"].includes(focused.type)
      ? [focused.selectionStart, focused.selectionEnd] : null;
    const overlayScroll = document.querySelector("[data-overlay-scroll]")?.scrollTop || 0;
    // A toast that is still showing carries over to the redrawn screen.
    const toastText = document.querySelector("#toast.show")?.textContent || "";
    try {
      sessionStorage.setItem("sawyer-view", JSON.stringify({ activeTab: state.activeTab,
        editingSeizureId: state.editingSeizureId, editingRecordId: state.editingRecordId,
        overlay: state.overlay, seizurePrefill: state.seizurePrefill }));
    } catch { /* View recovery is optional. */ }

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
      restoreToast(toastText);
      state.renderedTab = "";
      return;
    }

    if (!VIEW_TABS.includes(state.activeTab)) state.activeTab = "today";
    const fresh = state.overlayFresh;
    const sameTab = state.renderedTab === state.activeTab;
    const contentScroll = sameTab ? document.querySelector(".content")?.scrollTop || 0 : 0;
    // Redrawing the same screen keeps every animation where it was, so a background refresh
    // (like the sync that lands after the app opens) does not replay the screen's entrance.
    const now = performance.now();
    if (!sameTab) state.sceneStart = now;
    document.documentElement.style.setProperty("--age", `${((state.sceneStart - now) / 1000).toFixed(3)}s`);
    app.innerHTML = `
      <div class="screen${state.pullRefreshing ? " refreshing" : ""}">
        ${renderPullRefresh()}
        <main class="content">
          ${renderTopBar()}
          <div class="page">
            ${renderEmergencySyncBanner()}
            ${renderPendingBanner()}
            <section class="view ${state.activeTab === "today" ? "active" : ""}" data-view="today" aria-label="Today">
              ${renderToday(summary)}
            </section>
            <section class="view ${state.activeTab === "timeline" ? "active" : ""}" data-view="timeline" aria-label="Records">
              ${renderTimeline()}
            </section>
            <section class="view ${state.activeTab === "insights" ? "active" : ""}" data-view="insights" aria-label="Patterns">
              ${renderInsights(summary)}
            </section>
            <section class="view ${state.activeTab === "vet" ? "active" : ""}" data-view="vet" aria-label="Vet">
              ${renderVet()}
            </section>
          </div>
        </main>

        <nav class="tabbar" aria-label="Main navigation">
          <div class="tabbar-in">
            ${navButton("today", "Today", "home")}
            ${navButton("insights", "Patterns", "chart")}
            <button class="record-btn" data-overlay="menu" type="button" aria-label="New record">${icon("plus")}</button>
            ${navButton("timeline", "Records", "list")}
            ${navButton("vet", "Vet", "vet")}
          </div>
        </nav>
        ${renderOverlay()}
        ${renderTimerPill()}
        <div id="chart-tip" class="chart-tip" role="tooltip"></div>
        <div id="toast" class="toast" role="status"></div>
      </div>
    `;

    // Marks that are new on this redraw, such as a dose just ticked off, still animate in.
    const animated = new Set();
    app.querySelectorAll(REPLAY_WHEN_CHANGED).forEach((element, index) => {
      // The position tells apart marks that read the same, like two doses given in the same minute.
      const markup = `${index}:${element.outerHTML}`;
      animated.add(markup);
      if (sameTab && !state.animatedMarkup.has(markup)) element.style.setProperty("--age", "0s");
    });
    state.animatedMarkup = animated;

    bindUi();
    restoreToast(toastText);
    if (contentScroll) document.querySelector(".content").scrollTop = contentScroll;
    else if (!sameTab && isIosBrowser()) window.scrollTo(0, 0);
    state.renderedTab = state.activeTab;
    const overlayBody = document.querySelector("[data-overlay-scroll]");
    if (overlayBody && !fresh) overlayBody.scrollTop = overlayScroll;
    state.overlayFresh = false;
    document.documentElement.classList.toggle("overlay-open", Boolean(state.overlay));
    const nextFocus = focusId ? document.getElementById(focusId) : null;
    if (nextFocus?.closest(".view.active, .sheet, .focus") && nextFocus.getClientRects().length) {
      nextFocus.focus({ preventScroll: true });
      if (selection) nextFocus.setSelectionRange(...selection);
    }
    if (fresh) {
      requestAnimationFrame(() => {
        document.querySelector(".sheet .sheet-head .ibtn, .focus .fhead .ibtn")?.focus({ preventScroll: true });
      });
    }
    updateTimerDisplay();
  }

  function restoreToast(text) {
    const toast = document.querySelector("#toast");
    if (!text || !toast) return;
    toast.textContent = text;
    toast.classList.add("show", "steady");
  }

  function navButton(tab, label, iconName) {
    return `
      <button aria-current="${state.activeTab === tab ? "page" : "false"}" class="nav-btn ${state.activeTab === tab ? "active" : ""}" data-tab="${tab}" type="button">
        ${icon(iconName)}<span>${label}</span>
      </button>
    `;
  }

  function renderTopBar() {
    const name = state.profile?.name || "Sawyer";
    const pending = state.pendingRecords.length;
    const conflicts = state.pendingRecords.filter(({ record }) => record.syncStatus === "conflict").length;
    const syncing = state.syncBusy || state.startupSync;
    const label = syncing ? "Syncing" : !navigator.onLine ? "Offline" : conflicts ? "Review changes"
      : pending ? `${pending} waiting` : isSignedIn() ? "Synced" : "Not connected";
    const tone = syncing ? "busy" : !navigator.onLine || pending || !isSignedIn() ? "pending" : "ok";
    const initial = (state.settings?.carerName || name || "S").trim().charAt(0).toUpperCase() || "S";
    const tabs = [["today", "Today"], ["insights", "Patterns"], ["timeline", "Records"], ["vet", "Vet"]];
    return `
      <header class="topbar">
        <div class="topbar-in">
          <button class="brand" data-tab="today" type="button" aria-label="${escapeHtml(name)}, go to Today">
            <i aria-hidden="true"></i><b>${escapeHtml(name)}</b><small>Care tracker</small>
          </button>
          <nav class="topnav" aria-label="Sections">
            ${tabs.map(([tab, tabLabel]) => `<button data-tab="${tab}" type="button" aria-current="${state.activeTab === tab ? "page" : "false"}">${tabLabel}</button>`).join("")}
          </nav>
          <div class="top-actions">
            <button class="sync-pill ${tone}" data-overlay="household" type="button">${escapeHtml(label)}</button>
            <button class="btn yellow small desk-only" data-action="start-timer" type="button">${icon("timer")}Record Seizure</button>
            <button class="avatar" data-overlay="household" type="button" aria-label="Household and settings">${escapeHtml(initial)}</button>
          </div>
        </div>
      </header>
    `;
  }

  function routineOf(date) {
    return date.getHours() < 14 ? "morning" : "night";
  }

  function routineEntries(entries, routine) {
    return entries.filter((entry) => routineOf(entry.dueAt) === routine);
  }

  function nextDoseInfo(entries) {
    const now = new Date();
    const upcoming = entries.filter((entry) => !entry.log && entry.dueAt >= now);
    const first = upcoming[0] || entries[0];
    if (!first) return null;
    const pool = upcoming.length ? upcoming : entries;
    return {
      at: first.dueAt,
      tomorrow: !upcoming.length,
      routine: routineOf(first.dueAt),
      names: [...new Set(pool.filter((entry) => +entry.dueAt === +first.dueAt).map((entry) => entry.schedule.name))]
    };
  }

  function latestHandover() {
    return state.events
      .filter((event) => event.type === "note" && event.handover)
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))[0] || null;
  }

  function formatDurationWords(seconds) {
    const safe = Math.max(0, Math.round(Number(seconds) || 0));
    if (safe < 60) return `${safe} sec`;
    const minutes = Math.floor(safe / 60);
    const remainder = safe % 60;
    return remainder ? `${minutes} min ${remainder} sec` : `${minutes} min`;
  }

  function relativeTime(date) {
    const diff = Date.now() - date;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.round(diff / 60000)} min ago`;
    if (diff < DAY_MS) return `${Math.round(diff / 3600000)} h ago`;
    const days = Math.round(diff / DAY_MS);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }

  function renderToday(summary) {
    const name = state.profile?.name || "Sawyer";
    const tone = seizureFreeTone(summary);
    const glow = { "recent-seizure": "berry", "building-streak": "yellow" }[tone] || "blue";
    const days = summary.daysSinceLast;
    const last = getSeizuresAsc().at(-1);
    const entries = getTodayDoseEntries();
    const next = nextDoseInfo(entries);
    const confirmedToday = entries.filter((entry) => entry.status === "given").length;
    const exceptionsToday = entries.filter((entry) => entry.status === "missed" || entry.status === "skipped").length;
    const chip = { "recent-seizure": "Last 24 hours", "building-streak": "Building", "calm-streak": "Steady" }[tone] || "Ready";
    const toLongest = summary.completedLongestGap !== null && summary.currentStreakDays !== null
      ? summary.completedLongestGap - summary.currentStreakDays : null;
    const lede = last
      ? `Last seizure ${formatEventDateTime(last)}${last.durationSeconds ? `, ${formatDurationWords(last.durationSeconds)}` : ""}.${
        toLongest === null ? "" : toLongest > 0
          ? ` ${Math.ceil(toLongest)} ${Math.ceil(toLongest) === 1 ? "day" : "days"} to match the longest gap.`
          : " This is the longest gap on record."}`
      : "Start the timer when a seizure begins, or log one that has already happened.";
    const title = days === null
      ? `<span class="ln">No Seizures</span><span class="ln">Logged Yet</span>`
      : `<span class="ln"><span class="hero-count">${days}</span> ${days === 1 ? "Day" : "Days"}</span><span class="ln">Seizure&#8209;Free</span>`;
    const nextLabel = next ? (next.tomorrow ? `Tomorrow ${formatTime(next.at)}` : formatTime(next.at)) : "None";

    return `
      <section class="hero glow-${glow} seizure-free-card ${tone}" id="hero" aria-label="Seizure-free streak">
        ${leaf("--s:360px;--r:-24deg;left:34%;top:-110px;--d:26s;--dx:24px;--dy:18px")}
        ${leaf("--s:260px;--r:58deg;right:-80px;bottom:-70px;--d:30s;--dx:-18px;--dy:-14px")}
        ${leaf("--s:150px;--r:12deg;left:-50px;bottom:26%;--d:22s")}
        <svg class="orbit" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g><ellipse cx="200" cy="200" rx="230" ry="80" transform="rotate(-22 200 200)"/><ellipse cx="200" cy="200" rx="250" ry="120" transform="rotate(34 200 200)"/></g></svg>
        <figure class="hero-portrait"><img src="./assets/icons/sawyer-welcome-8bit-v4.png?v=1" alt="Pixel portrait of ${escapeHtml(name)}" /></figure>
        <div class="hero-main">
          <span class="notice rise" style="--i:0"><b>${escapeHtml(chip)}</b>${escapeHtml(formatDateShort(new Date()))}</span>
          <h1 class="rise" style="--i:1">${title}</h1>
          <p class="lede rise" style="--i:2">${escapeHtml(lede)}</p>
          <div class="rise" style="--i:3">${renderStreakHearts(days)}</div>
          <div class="hero-actions rise" style="--i:4">
            <button class="btn yellow big" data-action="start-timer" type="button">${icon("timer")}Record Seizure</button>
            <button class="btn glass big" data-overlay="seizure" type="button">Log Past Seizure</button>
          </div>
          <dl class="hero-meta rise" style="--i:5">
            <div class="meta-longest"><dt>Longest streak</dt><dd>${escapeHtml(summary.homeLongestGapText)}</dd><small>${summary.homeLongestGapIsCurrent ? "current streak" : "between episodes"}</small></div>
            <div class="meta-average"><dt>Average gap</dt><dd>${escapeHtml(summary.homeAverageGapText)}</dd><small>between episodes</small></div>
            <div class="meta-month"><dt>This month</dt><dd>${summary.thisMonthSeizures}</dd><small>${summary.thisMonthSeizures === 1 ? "seizure" : "seizures"}</small></div>
          </dl>
        </div>
        <div class="hero-side" aria-hidden="true">
          ${next ? `<div class="float-card fc-one"><span class="k">${icon("clock")}Next dose</span><b>${escapeHtml(nextLabel)}</b><small>${escapeHtml(next.names.join(", "))}</small></div>` : ""}
        </div>
      </section>

      <div class="lift">
        <div class="up-next">
          <button class="mini" data-overlay="routine" data-routine="${next?.routine || "morning"}" type="button">
            <span class="k">${icon("clock")}Next dose</span><b>${escapeHtml(nextLabel)}</b><small>${escapeHtml(next ? next.names.join(", ") : "No doses scheduled")}</small>
          </button>
          <button class="mini ${exceptionsToday ? "attention" : ""}" data-overlay="routine" data-routine="${routineOf(new Date())}" type="button">
            <span class="k">${icon("pill")}Today's doses</span><b>${confirmedToday}/${entries.length}</b><small>${exceptionsToday ? `${exceptionsToday} missed or skipped` : "confirmed"}</small>
          </button>
        </div>
        <div class="today-grid">
          <div class="stack">
            <div class="section-head"><h2>Today's Care</h2><span class="tag ${exceptionsToday ? "warn" : confirmedToday === entries.length && entries.length ? "ok" : "plain"}">${confirmedToday} of ${entries.length} confirmed</span></div>
            <div class="routines">${["morning", "night"].map((routine) => renderRoutineCard(routine, entries)).join("")}</div>
            <p class="fine">${state.profile?.doseConfirmationMode === "explicit" ? "Confirm each dose after it is given." : "Doses count as given unless marked missed. You can also confirm each one."}</p>
          </div>
          <div class="stack">
            <section class="chart-card today-gaps" aria-label="Days between episodes">
              <header>
                <div><h3>Days Between Episodes</h3><p class="sub">Seizures within 24 hours count as one episode.</p></div>
                <button class="link" data-tab="insights" type="button">Patterns${icon("chev")}</button>
              </header>
              ${renderGapChart(summary, chartWidth(2))}
            </section>
            ${state.installPrompt ? `
              <section class="card install-card">
                <div class="section-head"><h3>Install</h3><button class="btn yellow small" data-action="install-app" type="button">Install</button></div>
                <p class="subtle">Add Sawyer Tracker to the home screen for faster access.</p>
              </section>` : ""}
          </div>
        </div>
      </div>
    `;
  }

  function renderStreakHearts(daysSinceLast) {
    if (!Number.isFinite(daysSinceLast)) return "";
    const name = state.profile?.name || "Sawyer";
    const heartCount = Math.floor(daysSinceLast / 5);
    const visibleHearts = Math.min(heartCount, 5);
    const remaining = 5 - (daysSinceLast % 5);
    const label = `${heartCount} seizure-free heart${heartCount === 1 ? "" : "s"} earned. ${name} receives one heart for every 5 seizure-free days.`;
    return `
      <div class="streak-hearts" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
        <span class="hearts-row" aria-hidden="true">
          ${Array.from({ length: visibleHearts }, (_, index) => `<span class="heart earned" style="--i:${index}">${filledIcon("heart")}</span>`).join("")}
          ${heartCount > visibleHearts ? `<span class="heart-more">+${heartCount - visibleHearts}</span>` : ""}
          <span class="heart next" style="--p:${round1((daysSinceLast % 5) / 5)}">${icon("heart")}${filledIcon("heart")}</span>
        </span>
        <small class="streak-progress">${heartCount ? `${heartCount} earned · ` : ""}${remaining} ${remaining === 1 ? "day" : "days"} to next heart</small>
      </div>
    `;
  }

  function renderRoutineCard(routine, entries) {
    const list = routineEntries(entries, routine);
    if (!list.length) return "";
    const meta = ROUTINES[routine];
    const confirmed = list.filter((entry) => entry.status === "given").length;
    const exceptions = list.filter((entry) => entry.status === "missed" || entry.status === "skipped").length;
    const circumference = 276.46;
    const names = [...new Set(list.map((entry) => entry.schedule.name))];
    return `
      <button class="routine-card ${routine}" data-overlay="routine" data-routine="${routine}" type="button"
        aria-label="${meta.label} routine, ${confirmed} of ${list.length} confirmed${exceptions ? `, ${exceptions} missed or skipped` : ""}">
        ${leaf("--s:170px;--r:-20deg;left:-56px;bottom:16%;--d:26s")}
        ${leaf("--s:120px;--r:70deg;right:-34px;top:20%;--d:30s;--dx:-12px")}
        <header><span><b>${meta.label}</b><small>From ${escapeHtml(formatTime(list[0].dueAt))}</small></span><span class="count-badge">${list.length}</span></header>
        <span class="ring">
          <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="trk" cx="50" cy="50" r="44"/><circle class="val" cx="50" cy="50" r="44" stroke-dasharray="${circumference}" stroke-dashoffset="${(circumference * (1 - confirmed / list.length)).toFixed(1)}"/></svg>
          <span>${confirmed}<small>/${list.length}</small></span>
        </span>
        <footer><p>${escapeHtml(names.join(", "))}</p><span class="details">${exceptions ? `${exceptions} missed` : "Open"}</span></footer>
      </button>
    `;
  }

  function renderHandoverCard() {
    const name = state.profile?.name || "Sawyer";
    const handover = latestHandover();
    return `
      <section class="card handover-card" aria-label="Handover">
        <div class="section-head"><p class="eyebrow">Handover</p>${handover ? `<span class="fine">${escapeHtml(relativeTime(new Date(handover.occurredAt)))}</span>` : ""}</div>
        ${handover
          ? `<blockquote>“${escapeHtml(handover.body)}”</blockquote>${handover.recordedBy ? `<p class="fine">From ${escapeHtml(handover.recordedBy)}</p>` : ""}`
          : `<p class="subtle">Leave a short note for whoever looks after ${escapeHtml(name)} next.</p>`}
        <form id="handover-form" class="inline-form" autocomplete="off">
          <input type="hidden" name="title" value="Handover" />
          <input type="hidden" name="handover" value="on" />
          <label class="pill-input"><span class="sr-only">Handover note</span><input id="handover-body" name="body" maxlength="300" placeholder="Leave a note for the next carer" required /></label>
          <button class="btn ink" type="submit">Post</button>
        </form>
      </section>
    `;
  }

  function shouldShowLoginScreen() {
    return hasSupabaseConfig() && !hasStoredAccess();
  }

  function renderEmergencySyncBanner() {
    if (!state.storageUnavailable) return "";

    return `
      <aside class="banner emergency-sync-banner">
        <div>
          <strong>Safari recovery mode</strong>
          <p>The phone cache is unavailable, so Sawyer Tracker is using Supabase as the live record for this session.</p>
        </div>
        <button class="btn small ghost" data-overlay="household" type="button">Cloud status</button>
      </aside>
    `;
  }

  function renderPendingBanner() {
    const count = state.pendingRecords.length;
    const conflicts = state.pendingRecords.filter(({ record }) => record.syncStatus === "conflict").length;
    if (!count && navigator.onLine) return "";
    return `<aside class="banner sync-banner" role="status">
      <span>${conflicts ? `${conflicts} shared change${conflicts === 1 ? "" : "s"} need review.`
        : count ? `${count} change${count === 1 ? "" : "s"} saved on this device. Waiting to sync.`
          : "Offline — new entries will be saved on this device."}</span>
      <button class="btn small ghost" data-overlay="household" type="button">${conflicts ? "Review changes" : "Sync status"}</button>
    </aside>`;
  }

  function renderPendingRecords() {
    if (!state.pendingRecords.length) return "";
    return `<section class="household-section pending-section"><h3>Changes on this device</h3>
      <p class="subtle">Pending entries remain saved here until the shared record confirms them.</p>
      ${state.pendingRecords.map(({ storeName, record }) => {
        const remote = record.syncConflict ? SYNC.fromRemote(record.syncConflict) : null;
        const description = (item) => !item || item.deletedAt ? "<p>Record deleted</p>"
          : item.type ? `<strong>${escapeHtml(eventTitle(item))}</strong><p>${escapeHtml(formatEventDateTime(item))}</p>${eventDetail(item)}`
            : `<strong>${escapeHtml(item.name || "Care setup")}</strong><pre>${escapeHtml(JSON.stringify({ dose: item.dose, unit: item.unit, times: item.times, doseConfirmationMode: item.doseConfirmationMode }, null, 2))}</pre>`;
        return `<article class="pending-record">
          <strong>${escapeHtml(record.title || record.medicationName || record.name || capitalize(record.type || "Record"))}</strong>
          <p>${record.syncStatus === "conflict" ? "Another phone changed this record." : "Waiting to sync"}</p>
          ${record.syncError ? `<p class="subtle">${escapeHtml(record.syncError)}</p>` : ""}
          ${record.syncStatus === "conflict" ? `<div class="conflict-versions">
            <section><h4>This device</h4>${description(record)}</section>
            <section><h4>Shared record</h4>${description(remote)}</section></div>
            <div class="btn-row">
              <button class="btn ghost" data-resolve-conflict="remote" data-store="${storeName}" data-record="${escapeHtml(record.id)}">Use shared version</button>
              <button class="btn yellow" data-resolve-conflict="local" data-store="${storeName}" data-record="${escapeHtml(record.id)}">Keep this device's version</button>
            </div>` : ""}</article>`;
      }).join("")}
      <button class="btn ghost" data-action="sync-now" ${navigator.onLine ? "" : "disabled"}>Sync now</button>
    </section>`;
  }

  async function resolveConflict(storeName, id, choice) {
    try {
      await recordWork(async () => {
        const record = await dbGet(storeName, id);
        if (record?.syncStatus !== "conflict") return;
        const remote = record.syncConflict;
        if (choice === "remote") {
          if (remote) await dbPut(storeName, SYNC.fromRemote(remote));
          if (!remote || remote.id !== id) await dbDelete(storeName, id);
        } else {
          const next = SYNC.enqueue({ ...record, id: remote?.id || id,
            syncBaseUpdatedAt: remote?.updated_at || null, updatedAt: SYNC.nextTimestamp(remote?.updated_at) },
            record, state.settings.supabaseHouseholdId, record.syncMutationId || uid());
          await dbPut(storeName, next);
          if (next.id !== id) await dbDelete(storeName, id);
        }
      });
      await hydrate();
      render();
      queueBackgroundSync();
    } catch (error) { showToast(error.message); }
  }

  function renderLoginScreen() {
    return `
      <section class="login-card">
        ${leaf("--s:300px;--r:30deg;right:-90px;top:-90px")}
        ${leaf("--s:180px;--r:-20deg;left:-60px;bottom:-40px;--d:30s")}
        <div class="login-copy">
          <p class="eyebrow">${escapeHtml(formatWelcomeDate(new Date()))}</p>
          <h1>Sawyer Tracker</h1>
          <p>Enter the household access code once on this device. After that, Sawyer's records sync directly with Supabase without email sign-in.</p>
        </div>

        ${renderTrustedDeviceLogin(true)}

        <p class="login-message">${escapeHtml(state.syncMessage || state.settings?.lastSyncMessage || "Use the same access code on both phones to keep one shared Supabase record.")}</p>
      </section>
    `;
  }

  function renderTrustedDeviceLogin(configured) {
    return `
      <form id="access-form" class="form access-form">
        <div class="field">
          <label for="household-access-code">Household access code</label>
          <input id="household-access-code" name="accessCode" type="password" autocomplete="current-password" placeholder="Enter Sawyer's code" required />
        </div>
        <button class="btn yellow big block" type="submit" ${configured ? "" : "disabled"}>Connect to Supabase</button>
      </form>
    `;
  }

  function renderDoseRow(entry, index = 0) {
    const attribution = entry.log?.recordedBy
      ? `${entry.log.recordedBy} · ${formatTime(new Date(entry.log.occurredAt))}` : "";
    const meta = [entry.doseText, formatTime(entry.dueAt)].filter(Boolean).join(" · ");
    const statusLine = `<span class="dstatus ${entry.pillClass}">${entry.log ? `<span class="dmark">${icon(entry.status === "given" ? "check" : "minus")}</span>` : ""}${escapeHtml(entry.statusText)}${attribution ? ` · ${escapeHtml(attribution)}` : ""}</span>`;
    return `<li class="medication-row ${entry.pillClass}" style="--i:${index}">
      <div class="drow-top"><span class="dname">${escapeHtml(entry.schedule.name)}</span><span class="dmeta">${escapeHtml(meta)}</span></div>
      ${entry.log
        ? `<div class="dstate">${statusLine}<button class="undo" data-clear-dose="${escapeHtml(entry.log.id)}" type="button">Undo ${escapeHtml(entry.status)}</button></div>
           ${SYNC.pending(entry.log) ? `<small class="dsync">${entry.log.syncStatus === "conflict" ? "Needs review in Household" : "Waiting to sync"}</small>` : ""}`
        : `<div class="dstate">${statusLine}</div>
           <div class="dose-buttons">
             <button class="dose-btn primary" data-dose="${escapeHtml(entry.key)}" data-status="given" type="button">${icon("check")}Given</button>
             <button class="dose-btn" data-dose="${escapeHtml(entry.key)}" data-status="missed" type="button">Missed</button>
             <button class="dose-btn" data-dose="${escapeHtml(entry.key)}" data-status="skipped" type="button">Skipped</button>
           </div>`}
    </li>`;
  }

  function renderRoutineBody(routine, entries = getTodayDoseEntries()) {
    const list = routineEntries(entries, routine);
    const confirmed = list.filter((entry) => entry.status === "given").length;
    return `
      <div>
        <h2 class="routine-title" id="sheet-title">${ROUTINES[routine].label} Routine</h2>
        <p class="routine-sub">${list.length ? `From ${escapeHtml(formatTime(list[0].dueAt))} · ${list.length} dose${list.length === 1 ? "" : "s"} · ${confirmed} confirmed` : "No doses at this time of day."}</p>
      </div>
      <div class="field carer-field"><label for="carer-name">Recording as</label>
        <input id="carer-name" maxlength="60" autocomplete="given-name" placeholder="Your name" value="${escapeHtml(state.settings.carerName || "")}" /></div>
      <ul class="dose-list medication-plan">${list.map(renderDoseRow).join("")}</ul>
      <p class="fine">${state.profile?.doseConfirmationMode === "explicit" ? "Confirm each dose after it is given." : "Doses count as given unless marked missed."} Each record keeps your name and the time.</p>
    `;
  }

  function renderVetDocuments(localDate) {
    const documents = state.vetDocuments || [];
    const message = state.documentsMessage
      ? `<p class="subtle document-message">${escapeHtml(state.documentsMessage)}</p>`
      : "";

    return `
      <section class="vet-documents">
        <div class="section-head">
          <div>
            <h3>Documents</h3>
            <p class="fine">Private PDFs shared between both phones.</p>
          </div>
          <span class="tag plain">${documents.length} stored</span>
        </div>

        <details class="disclosure document-upload-disclosure">
          <summary>${icon("upload")}<span><strong>Upload a PDF</strong><small>Visit summaries, lab results and prescriptions</small></span>${icon("chev", "i chev")}</summary>
          <form id="vet-document-form" class="form document-upload-form">
            <div class="field">
              <label for="vet-document-file">PDF document</label>
              <input id="vet-document-file" name="file" type="file" accept="application/pdf,.pdf" required />
              <small class="field-help">PDF only, up to 20 MB.</small>
            </div>
            <div class="row2">
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
            <button class="btn yellow" type="submit" ${state.documentsBusy ? "disabled" : ""}>
              ${state.documentsBusy ? "Uploading..." : "Upload PDF"}
            </button>
          </form>
        </details>

        ${message}

        <div class="row-list document-list">
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
      <article class="row document-row">
        <span class="row-icon vet_visit" aria-hidden="true">${icon("doc")}</span>
        <span class="row-text">
          <strong>${escapeHtml(document.file_name || "Vet document.pdf")}</strong>
          <small>${escapeHtml(category)} · ${escapeHtml(date)} · ${escapeHtml(formatFileSize(document.size_bytes))}</small>
          ${document.notes ? `<small>${escapeHtml(document.notes)}</small>` : ""}
        </span>
        <span class="row-actions">
          <button class="btn small ghost" data-view-vet-document="${escapeHtml(document.id)}" type="button">Open</button>
          <button class="btn small ghost" data-delete-vet-document="${escapeHtml(document.id)}" type="button">Delete</button>
        </span>
      </article>
    `;
  }

  function renderTimeline() {
    const events = filteredTimelineEvents();
    const visibleEvents = events.slice(0, state.timelineLimit);
    const groups = groupTimelineEvents(visibleEvents);
    const totalRecords = state.events.length;

    return `
      <div class="records-layout history-view">
        <div class="records-head">
          <div class="section-head">
            <h2>Records</h2>
            <span class="tag plain">${totalRecords} total</span>
          </div>

          ${renderHandoverCard()}

          <form id="history-search-form" class="search" role="search">
            ${icon("search")}
            <input
              name="query"
              type="search"
              aria-label="Search records"
              placeholder="Search notes, triggers, results"
              value="${escapeHtml(state.timelineSearch)}"
            />
            <button class="btn small ink" type="submit">Search</button>
          </form>
          ${state.timelineSearch ? `<button class="link" data-action="clear-history-search" type="button">Clear search</button>` : ""}

          <div class="chips filters" role="group" aria-label="Filter records">
            ${TIMELINE_FILTERS.map((filter) => `
              <button class="chip history-filter ${state.timelineFilter === filter.id ? "active" : ""}" data-filter="${filter.id}" type="button" aria-pressed="${state.timelineFilter === filter.id}">
                <span>${escapeHtml(filter.label)}</span>
                <small>${timelineFilterCount(filter.id)}</small>
              </button>
            `).join("")}
          </div>
          <p class="fine">Tap a record for details, edits and deletion.</p>
        </div>

        <div class="records-list">
          ${
            groups.length
              ? groups.map(renderTimelineGroup).join("")
              : `<div class="empty">${icon("search")}<strong>No records match this view</strong><span>Try another word or filter.</span></div>`
          }

          ${
            events.length > visibleEvents.length
              ? `<button class="btn ghost block history-more" data-action="history-more" type="button">Load ${Math.min(HISTORY_PAGE_SIZE, events.length - visibleEvents.length)} older records</button>`
              : events.length
                ? `<p class="fine history-end">Showing all ${events.length} matching record${events.length === 1 ? "" : "s"}.</p>`
                : ""
          }
        </div>
      </div>
    `;
  }

  function renderTimelineGroup(group) {
    return `
      <section class="history-day">
        <header class="day-head">
          <h3>${escapeHtml(formatHistoryDate(group.date))}</h3>
          <span>${group.events.length} record${group.events.length === 1 ? "" : "s"}</span>
        </header>
        <div class="row-list timeline-list">
          ${group.events.map(renderTimelineItem).join("")}
        </div>
      </section>
    `;
  }

  function renderTimelineItem(event) {
    const pending = SYNC.pending(event);
    return `
      <details class="timeline-item ${escapeHtml(event.type)}">
        <summary>
          <span class="row-icon ${escapeHtml(event.type)}" aria-hidden="true">${icon(TYPE_ICONS[event.type] || "note")}</span>
          <span class="row-text">
            <strong>${escapeHtml(eventTitle(event))}</strong>
            <span class="timeline-meta">${escapeHtml(formatEventTime(event))}</span>
          </span>
          <span class="row-side">
            ${isAutomaticCluster(event) ? `<span class="tag warn">Cluster</span>` : ""}
            ${event.type === "note" && event.handover ? `<span class="tag plain">Handover</span>` : ""}
            ${pending ? `<span class="tag warn">${event.syncStatus === "conflict" ? "Review" : "Waiting"}</span>` : ""}
            ${icon("chev", "i chev")}
          </span>
        </summary>
        <div class="timeline-item-body">
          ${eventDetail(event)}
          <div class="btn-row timeline-actions">
            ${event.type === "seizure" ? `<button class="btn small ghost" data-edit-seizure="${escapeHtml(event.id)}">${icon("edit")}Edit</button>` : ""}
            ${["note", "vet_visit", "blood_test"].includes(event.type) ? `<button class="btn small ghost" data-edit-record="${escapeHtml(event.id)}">${icon("edit")}Edit</button>` : ""}
            <button class="btn small danger" data-delete-event="${escapeHtml(event.id)}">Delete</button>
          </div>
        </div>
      </details>
    `;
  }

  function chartWidth(columns = 1) {
    const viewport = Math.min(window.innerWidth || 390, 1264);
    const content = Math.min(viewport - (viewport >= 760 ? 64 : 32), 1200);
    const twoColumns = columns === 2 && viewport >= 960;
    return Math.max(250, Math.floor((twoColumns ? (content - 16) / 2 : content) - 40));
  }

  function shortDate(event) {
    return new Date(event.occurredAt).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function renderInsights(summary) {
    const monthly = getStatsMonthlyData(state.statsRange);
    const selectedMonth = getSelectedStatsMonth(monthly);
    const max = Math.max(...monthly.map((item) => item.count), 1);
    const rangeStart = monthly.length ? localTimeToDate(`${monthly[0].key}-01`, "00:00") : new Date(0);
    const seizures = getSeizuresAsc();
    const inRange = seizures.filter((event) => new Date(event.occurredAt) >= rangeStart);
    const timed = inRange.filter((event) => event.timeKnown !== false);
    const durations = inRange.map((event) => Number(event.durationSeconds) || 0).filter(Boolean);
    const clock = renderClockChart(timed, Math.min(320, chartWidth(2)));
    const trend = renderTrendChart(seizures, rangeStart, chartWidth(1));
    const severity = renderSeverityChart(inRange, rangeStart, chartWidth(2));
    const trendChange = trend.now === null ? null : trend.now - trend.before;
    const severityChange = severity.recent === null ? null : severity.recent - severity.earlier;
    const nearMissed = countSeizuresNearMissedDose(seizures).total;
    const insights = buildInsights(summary).slice(0, 6);

    return `
      <div class="stack patterns">
        <div class="section-head">
          <h2>Patterns</h2>
          <div class="chips stats-range-control" role="group" aria-label="Choose range">
            ${[["6", "6 months"], ["12", "12 months"], ["all", "All"]].map(([value, label]) => `
              <button class="chip" data-stats-range="${value}" type="button" aria-pressed="${state.statsRange === value ? "true" : "false"}">${label}</button>
            `).join("")}
          </div>
        </div>

        <div class="summary-tiles stats-metrics">
          ${leaf("--s:220px;--r:20deg;left:-60px;top:-80px")}
          <div class="tile metric"><small>Current gap</small><strong>${summary.daysSinceLast === null ? "--" : `${summary.daysSinceLast} ${summary.daysSinceLast === 1 ? "day" : "days"}`}</strong><em>since the last seizure</em></div>
          <div class="tile metric"><small>Average gap</small><strong>${escapeHtml(summary.homeAverageGapText)}</strong><em>between episodes</em></div>
          <div class="tile metric total"><small>Longest gap</small><strong>${escapeHtml(summary.longestGapText)}</strong><em>${summary.longestGapIsCurrent ? "current streak" : "between episodes"}</em></div>
          <button class="tile cta" data-tab="vet" data-scroll="visit-summary" type="button">${icon("arrow")}Vet Summary</button>
        </div>

        <div class="charts">
          <section class="chart-card wide stats-month-panel">
            <header><div><h3>Seizures By Month</h3><p class="sub">${inRange.length} logged in this range. Tap a month for detail.</p></div></header>
            <div class="month-chart" aria-label="Monthly seizure counts">
              ${monthly.map((item, index) => `
                <button class="month-bar ${item.key === selectedMonth.key ? "active" : ""} ${index === monthly.length - 1 ? "partial" : ""}"
                  data-stats-month="${escapeHtml(item.key)}" type="button" aria-pressed="${item.key === selectedMonth.key ? "true" : "false"}"
                  aria-label="${escapeHtml(`${item.fullLabel}: ${item.count} seizure${item.count === 1 ? "" : "s"}${index === monthly.length - 1 ? ", so far" : ""}`)}">
                  <span class="mb-count">${item.count}</span>
                  <span class="mb-track" aria-hidden="true"><span class="mb-fill sev-${busyLevel(item.count)}" style="height:${(item.count / max) * 100}%;--i:${index}"></span></span>
                  <span class="mb-label">${escapeHtml(item.label)}</span>
                </button>
              `).join("")}
            </div>
            <div class="legend">${renderBusyScale("Colour")}<span><i class="striped"></i>This month so far</span></div>
            ${renderSelectedStatsMonth(selectedMonth)}
          </section>

          <section class="chart-card wide trend-card">
            <header>
              <div><h3>Seizures In The Last 30 Days</h3><p class="sub">Each point counts the 30 days before it, so lower is calmer. Tap the line for any day.</p></div>
              ${trendChange === null ? "" : `<div class="trend-now"><strong>${trend.now}<small>now</small></strong><span class="tag ${trendChange < 0 ? "ok" : trendChange > 0 ? "bad" : "plain"}">${
                trendChange === 0 ? "Same as the 30 days before" : `${Math.abs(trendChange)} ${trendChange < 0 ? "fewer" : "more"} than the 30 days before`}</span></div>`}
            </header>
            ${trend.html}
            ${trend.now === null ? "" : `<div class="legend">${renderBusyScale("Line")}<span><i class="tick"></i>Each seizure, coloured by severity</span></div>`}
          </section>

          <section class="chart-card">
            <header><div><h3>Days Between Episodes</h3><p class="sub">Seizures within 24 hours count as one episode.</p></div></header>
            ${renderGapChart(summary, chartWidth(2))}
          </section>

          <section class="chart-card severity-card">
            <header>
              <div><h3>Severity Over Time</h3><p class="sub">Each dot is one seizure, larger when it lasted longer. The line averages the last three episodes.</p></div>
              ${severityChange === null ? "" : `<div class="trend-now"><strong>${severity.recent.toFixed(1)}<small>recent average</small></strong><span class="tag ${severityChange < -0.2 ? "ok" : severityChange > 0.2 ? "bad" : "plain"}">${
                severityChange < -0.2 ? `Milder, was ${severity.earlier.toFixed(1)}` : severityChange > 0.2 ? `Stronger, was ${severity.earlier.toFixed(1)}` : "About the same"}</span></div>`}
            </header>
            ${severity.html}
            ${!severity.drawn ? "" : `<div class="legend">${renderSeverityScale("Severity")}<span><i class="ring"></i>Bigger dot, longer seizure</span></div>`}
          </section>

          <section class="chart-card">
            <header><div><h3>Time Of Day</h3><p class="sub">${timed.length ? `${clock.night} of ${timed.length} with a recorded time started between 10 pm and 6 am.` : "No seizures with a recorded time in this range."}</p></div></header>
            ${clock.html}
            <div class="legend"><span><i class="night"></i>10 pm to 6 am</span>${renderSeverityScale("Severity")}<span>Outer dots are more recent</span></div>
          </section>

          <section class="chart-card">
            <header><div><h3>Duration</h3><p class="sub">${durations.length ? `From ${formatDurationWords(Math.min(...durations))} to ${formatDurationWords(Math.max(...durations))}, average ${formatDurationWords(mean(durations))}.` : "No durations recorded in this range."}</p></div></header>
            ${renderDurationChart(inRange, rangeStart, chartWidth(2))}
          </section>

          <section class="chart-card wide">
            <header><div><h3>Observations</h3><p class="sub">From the records you have kept.</p></div></header>
            <ul class="observations">
              <li class="${nearMissed ? "flag" : ""}"><span><strong>Dose context.</strong> ${nearMissed
                ? `${nearMissed} logged seizure${nearMissed === 1 ? "" : "s"} occurred within 24 hours after a missed or late dose record.`
                : "No logged seizures are near a missed or late dose record."}</span></li>
              ${insights.map((insight) => `<li><span><strong>${escapeHtml(insight.title)}.</strong> ${escapeHtml(insight.body)}</span></li>`).join("")}
            </ul>
          </section>
        </div>

        ${renderAiInsightPanel()}
        <p class="disclaim">${icon("info")}<span>These are patterns in what has been recorded. They don't predict the next seizure or show a cause. Share them with your vet.</span></p>
      </div>
    `;
  }

  function renderSelectedStatsMonth(month) {
    return `
      <div class="month-detail" data-stats-month-detail>
        <div>
          <span class="eyebrow">${escapeHtml(month.fullLabel)}</span>
          <h4>${month.count ? `${month.count} seizure${month.count === 1 ? "" : "s"} logged` : "No seizures logged"}</h4>
          <p class="subtle">${escapeHtml(month.summary)}</p>
        </div>
        <div class="detail-grid">
          <div><span>Severity</span><strong>${month.averageSeverityText}</strong></div>
          <div><span>Duration</span><strong>${month.averageDurationText}</strong></div>
          <div><span>Clusters</span><strong>${month.clusterCount}</strong></div>
          <div><span>Usual time</span><strong>${escapeHtml(month.timeWindowText)}</strong></div>
        </div>
      </div>
    `;
  }

  function renderGapChart(summary, width) {
    const gaps = CORE.seizureEpisodeGaps(getSeizuresAsc(), CLUSTER_WINDOW_MS);
    const rows = [];
    if (summary.currentStreakDays !== null && gaps.length) {
      rows.push({ label: "Now", days: summary.currentStreakDays, open: true, tip: `Current gap · ${round1(summary.currentStreakDays)} days, still open` });
    }
    gaps.slice(-7).reverse().forEach((gap) => rows.push({
      label: `${shortDate(gap.from)} – ${shortDate(gap.to)}`,
      days: gap.days,
      tip: `${formatDateShort(new Date(gap.from.occurredAt))} to ${formatDateShort(new Date(gap.to.occurredAt))} · ${round1(gap.days)} days`
    }));
    if (!gaps.length) return `<p class="subtle">Gaps appear after the second seizure episode.</p>`;
    const average = mean(gaps.map((gap) => gap.days));
    const left = Math.min(118, width * 0.34);
    const right = 52;
    const rowHeight = 34;
    const height = 6 + rows.length * rowHeight + 30;
    const maxDays = Math.max(...rows.map((row) => row.days), average) * 1.04;
    const x = (days) => left + (days / maxDays) * (width - left - right);
    let marks = "";
    rows.forEach((row, index) => {
      const cy = 6 + index * rowHeight + rowHeight / 2;
      marks += `<text x="${left - 12}" y="${cy + 4}" text-anchor="end" class="${row.open ? "strong" : ""}">${escapeHtml(row.label)}</text>`;
      const depth = row.days < 5 ? " short" : row.days < 14 ? " g1" : row.days < 28 ? " g2" : " g3";
      marks += `<rect class="gap-bar grow-x${row.open ? " open" : ""}${depth}" style="--i:${index}" x="${left}" y="${cy - 8}" width="${Math.max(4, x(row.days) - left).toFixed(1)}" height="16" rx="8"/>`;
      marks += `<text x="${(x(row.days) + 8).toFixed(1)}" y="${cy + 4}" class="strong">${Math.round(row.days)} d</text>`;
      marks += `<rect class="hit" tabindex="0" x="0" y="${cy - rowHeight / 2}" width="${width}" height="${rowHeight}" data-tip="${escapeHtml(row.tip)}"/>`;
    });
    const ax = x(average);
    marks += `<line class="ref" x1="${ax.toFixed(1)}" x2="${ax.toFixed(1)}" y1="6" y2="${height - 22}"/><text x="${ax.toFixed(1)}" y="${height - 6}" text-anchor="middle">Average ${round1(average)} d</text>`;
    return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-label="Days between seizure episodes">${marks}</svg></div>
      <div class="legend"><span><i class="short"></i>Under 5 days</span><span class="sev-scale">5 days or more<i class="g1"></i><i class="g2"></i><i class="g3"></i>longer</span><span><i class="open"></i>Current gap, still open</span><span><i class="dash"></i>Average of completed gaps</span></div>`;
  }

  function severityLevel(value) {
    const level = Math.round(Number(value));
    return level >= 1 && level <= 5 ? level : 0;
  }

  // How busy a stretch was, on the same blue-to-berry scale: up to 2 seizures is calm, 8 or more is the busiest.
  function busyLevel(count) {
    return count <= 0 ? 0 : count <= 2 ? 2 : count <= 4 ? 3 : count <= 7 ? 4 : 5;
  }

  function renderBusyScale(label) {
    return `<span class="sev-scale">${escapeHtml(label)}: calmer${[2, 3, 4, 5].map((level) => `<i class="sev-${level}"></i>`).join("")}busier</span>`;
  }

  function renderSeverityScale(label) {
    return `<span class="sev-scale">${escapeHtml(label)}: mild${[1, 2, 3, 4, 5].map((level) => `<i class="sev-${level}"></i>`).join("")}severe</span>`;
  }

  function renderMonthLabels(start, x, y) {
    const firstMonth = new Date(start);
    const months = (new Date().getFullYear() - firstMonth.getFullYear()) * 12 + new Date().getMonth() - firstMonth.getMonth() + 1;
    const every = Math.max(1, Math.ceil(months / 7));
    let marks = "";
    for (let index = 0; index < months; index += every) {
      const date = new Date(firstMonth.getFullYear(), firstMonth.getMonth() + index, 1);
      if (+date < start) continue;
      marks += `<text x="${x(+date).toFixed(1)}" y="${y}" text-anchor="middle">${escapeHtml(date.toLocaleDateString(undefined, { month: "short" }))}</text>`;
    }
    return marks;
  }

  // A vertical gradient keyed to the y scale, so a line is blue where values are low and berry where they are high.
  function renderValueGradient(id, y, stops) {
    return `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${y(stops[0][0]).toFixed(1)}" y2="${y(stops.at(-1)[0]).toFixed(1)}">${
      stops.map(([value, level]) => `<stop offset="${((value - stops[0][0]) / (stops.at(-1)[0] - stops[0][0])).toFixed(3)}" style="stop-color:var(--sev-${level})"/>`).join("")
    }</linearGradient></defs>`;
  }

  // Catmull-Rom through the points, with control points kept between neighbours so close points never loop back.
  function smoothPath(points, yMin, yMax) {
    const fixed = (value) => value.toFixed(1);
    if (points.length < 3) return points.map(([px, py], index) => `${index ? "L" : "M"}${fixed(px)},${fixed(py)}`).join("");
    let path = `M${fixed(points[0][0])},${fixed(points[0][1])}`;
    for (let index = 0; index < points.length - 1; index += 1) {
      const [p0, p1, p2, p3] = [points[index - 1] || points[index], points[index], points[index + 1], points[index + 2] || points[index + 1]];
      const c1 = [clamp(p1[0] + (p2[0] - p0[0]) / 6, p1[0], p2[0]), clamp(p1[1] + (p2[1] - p0[1]) / 6, yMin, yMax)];
      const c2 = [clamp(p2[0] - (p3[0] - p1[0]) / 6, p1[0], p2[0]), clamp(p2[1] - (p3[1] - p1[1]) / 6, yMin, yMax)];
      path += `C${fixed(c1[0])},${fixed(c1[1])} ${fixed(c2[0])},${fixed(c2[1])} ${fixed(p2[0])},${fixed(p2[1])}`;
    }
    return path;
  }

  function renderTrendChart(seizures, rangeStart, width) {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(rangeStart);
    start.setHours(23, 59, 59, 999);
    const days = Math.round((end - start) / DAY_MS);
    if (!seizures.length || days < 30) return { html: `<p class="subtle">The trend appears once there is a month of records.</p>`, now: null, before: null };

    // Each day counts the seizures in the 30 days up to it, so a hard week stays visible for a month
    // rather than vanishing at a calendar boundary.
    const times = seizures.map((event) => +new Date(event.occurredAt));
    const windowCount = (until) => times.filter((time) => time <= until && time > until - 30 * DAY_MS).length;
    const series = [];
    let low = 0;
    let high = 0;
    for (let index = 0; index <= days; index += 1) {
      const until = +start + index * DAY_MS;
      while (high < times.length && times[high] <= until) high += 1;
      while (low < high && times[low] <= until - 30 * DAY_MS) low += 1;
      series.push({ until, count: high - low });
    }

    const height = 210;
    const left = 30;
    const right = 18;
    const top = 26;
    const bottom = 40;
    const innerWidth = width - left - right;
    const innerHeight = height - top - bottom;
    const ceiling = Math.max(4, Math.ceil(Math.max(...series.map((point) => point.count)) / 2) * 2);
    const x = (time) => left + ((time - +start) / (+end - +start)) * innerWidth;
    const y = (count) => top + innerHeight - (count / ceiling) * innerHeight;
    const base = y(0);

    const stops = [[0, 2], [2, 2], [4, 3], [7, 4]].filter(([value]) => value < ceiling);
    let marks = renderValueGradient("trend-ink", y, [...stops, [ceiling, busyLevel(ceiling)]]);
    [0, ceiling / 2, ceiling].forEach((value) => {
      marks += `<line class="grid" x1="${left}" x2="${width - right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text x="${left - 8}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end">${value}</text>`;
    });
    const line = series.map((point, index) => `${index ? "L" : "M"}${x(point.until).toFixed(1)},${y(point.count).toFixed(1)}`).join("");
    marks += `<path class="trend-area" fill="url(#trend-ink)" d="${line}L${x(+end).toFixed(1)},${base.toFixed(1)}L${left},${base.toFixed(1)}Z"/>`;
    marks += `<path class="trend-line" stroke="url(#trend-ink)" pathLength="1" d="${line}"/>`;
    seizures.filter((event) => +new Date(event.occurredAt) > +start).forEach((event) => {
      const tx = x(+new Date(event.occurredAt)).toFixed(1);
      marks += `<line class="rug sev-${severityLevel(event.severity) || 3}" x1="${tx}" x2="${tx}" y1="${(base + 7).toFixed(1)}" y2="${(base + 15).toFixed(1)}"/>`;
    });
    marks += renderMonthLabels(+start, x, height - 6);

    const latest = series.at(-1);
    const lx = x(latest.until);
    const ly = y(latest.count);
    marks += `<circle class="dot pop sev-${busyLevel(latest.count) || 2}" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="6"/>`;
    marks += `<g class="cross" aria-hidden="true"><line x1="0" x2="0" y1="${top}" y2="${base.toFixed(1)}"/><circle r="5" cx="0" cy="0"/></g>`;

    const step = Math.max(1, Math.ceil(series.length / 90));
    for (let index = 0; index < series.length; index += step) {
      const point = series[Math.min(index + Math.floor(step / 2), series.length - 1)];
      const cx = x(point.until);
      const date = new Date(point.until).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      marks += `<rect class="hit" tabindex="-1" x="${(cx - (innerWidth / series.length) * step / 2).toFixed(1)}" y="${top}" width="${((innerWidth / series.length) * step).toFixed(1)}" height="${(innerHeight + 16).toFixed(1)}" data-x="${cx.toFixed(1)}" data-y="${y(point.count).toFixed(1)}" data-tip="${escapeHtml(`${date}: ${point.count} seizure${point.count === 1 ? "" : "s"} in the 30 days before`)}"/>`;
    }
    return {
      html: `<div class="chart"><svg viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-label="${escapeHtml(`Seizures in each 30-day window. ${latest.count} in the last 30 days.`)}">${marks}</svg></div>`,
      now: latest.count,
      before: windowCount(latest.until - 30 * DAY_MS)
    };
  }

  function renderSeverityChart(seizures, rangeStart, width) {
    const points = seizures.filter((event) => severityLevel(event.severity));
    if (points.length < 2) return { html: `<p class="subtle">Severity appears once two seizures are logged.</p>`, drawn: false, recent: null, earlier: null };
    const height = 220;
    const left = 64;
    const right = 16;
    const top = 16;
    const bottom = 30;
    const innerWidth = width - left - right;
    const innerHeight = height - top - bottom;
    const end = Date.now();
    const start = Math.min(+rangeStart, +new Date(points[0].occurredAt));
    const x = (time) => left + ((time - start) / Math.max(1, end - start)) * innerWidth;
    const y = (level) => top + innerHeight - ((level - 1) / 4) * innerHeight;
    const longest = Math.max(60, ...points.map((event) => Number(event.durationSeconds) || 0));
    const radius = (seconds) => (Number(seconds) > 0 ? 4 + 5.5 * Math.sqrt(Number(seconds) / longest) : 4.5);

    let marks = renderValueGradient("severity-ink", y, [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    [[5, "5 Severe"], [4, "4"], [3, "3"], [2, "2"], [1, "1 Mild"]].forEach(([level, label]) => {
      marks += `<line class="grid" x1="${left}" x2="${width - right}" y1="${y(level).toFixed(1)}" y2="${y(level).toFixed(1)}"/><text x="${left - 10}" y="${(y(level) + 4).toFixed(1)}" text-anchor="end">${label}</text>`;
    });
    marks += renderMonthLabels(start, x, height - 6);

    // The line follows whole episodes, so a cluster of seizures hours apart counts once and
    // the line moves smoothly instead of jumping within a single day.
    const episodes = [];
    points.forEach((event) => {
      const current = episodes.at(-1);
      if (current && seizuresShareClusterWindow(current.at(-1), event)) current.push(event);
      else episodes.push([event]);
    });
    const episodeMeans = episodes.map((episode) => [
      mean(episode.map((event) => +new Date(event.occurredAt))),
      mean(episode.map((event) => severityLevel(event.severity)))
    ]);
    const running = episodeMeans.map(([time], index) => [
      x(time), y(mean(episodeMeans.slice(Math.max(0, index - 2), index + 1).map(([, level]) => level)))
    ]);
    marks += `<path class="avg-line" stroke="url(#severity-ink)" pathLength="1" d="${smoothPath(running, y(5), y(1))}"/>`;
    points.forEach((event, index) => {
      const level = severityLevel(event.severity);
      const cx = x(+new Date(event.occurredAt)).toFixed(1);
      const cy = y(level).toFixed(1);
      const symptoms = Array.isArray(event.symptoms) && event.symptoms.length ? ` · ${event.symptoms.join(", ")}` : "";
      marks += `<circle class="dot pop sev-${level}" style="--i:${index}" cx="${cx}" cy="${cy}" r="${radius(event.durationSeconds).toFixed(1)}"/>`;
      marks += `<circle class="hit" tabindex="0" cx="${cx}" cy="${cy}" r="13" data-tip="${escapeHtml(`${formatEventDateTime(event)} · severity ${level}${Number(event.durationSeconds) > 0 ? ` · ${formatDurationWords(event.durationSeconds)}` : ""}${symptoms}`)}"/>`;
    });
    // The headline compares the same thing the line shows: the last three episodes against the three before.
    const episodeLevels = episodeMeans.map(([, level]) => level);
    return {
      html: `<div class="chart"><svg viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-label="Severity of each seizure over time, with a running average">${marks}</svg></div>`,
      drawn: true,
      recent: episodeLevels.length >= 4 ? mean(episodeLevels.slice(-3)) : null,
      earlier: episodeLevels.length >= 4 ? mean(episodeLevels.slice(-6, -3)) : null
    };
  }

  function renderClockChart(seizures, size) {
    const center = size / 2;
    const radius = size / 2 - 30;
    const angle = (hours) => (hours / 24) * Math.PI * 2 - Math.PI / 2;
    const point = (hours, r) => [center + Math.cos(angle(hours)) * r, center + Math.sin(angle(hours)) * r];
    const sector = (from, to, inner, outer) => {
      const [a, b] = point(from, outer);
      const [c, d] = point(to, outer);
      const [e, f] = point(to, inner);
      const [g, h] = point(from, inner);
      return `M${a},${b}A${outer},${outer} 0 0 1 ${c},${d}L${e},${f}A${inner},${inner} 0 0 0 ${g},${h}Z`;
    };
    let marks = `<path class="night" d="${sector(22, 30, radius * 0.3, radius)}"/>`;
    [radius, radius * 0.65, radius * 0.3].forEach((r) => { marks += `<circle class="grid" cx="${center}" cy="${center}" r="${r}" fill="none"/>`; });
    for (let hour = 0; hour < 24; hour += 1) {
      const [x1, y1] = point(hour, radius);
      const [x2, y2] = point(hour, radius + (hour % 6 === 0 ? 7 : 4));
      marks += `<line class="axis" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }
    [[0, "12 am"], [6, "6 am"], [12, "12 pm"], [18, "6 pm"]].forEach(([hour, label]) => {
      const [x, y] = point(hour, radius + 18);
      marks += `<text x="${x}" y="${y + 4}" text-anchor="middle">${label}</text>`;
    });
    let night = 0;
    seizures.forEach((seizure, index) => {
      const date = new Date(seizure.occurredAt);
      const hours = date.getHours() + date.getMinutes() / 60;
      if (hours >= 22 || hours < 6) night += 1;
      const r = radius * 0.38 + (seizures.length > 1 ? (index / (seizures.length - 1)) * radius * 0.54 : radius * 0.54);
      const [x, y] = point(hours, r);
      marks += `<circle class="dot pop sev-${severityLevel(seizure.severity)}" style="--i:${index}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6.5"/>`;
      marks += `<circle class="hit" tabindex="0" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" data-tip="${escapeHtml(`${formatEventDateTime(seizure)} · ${formatDurationWords(seizure.durationSeconds)}${severityLevel(seizure.severity) ? ` · severity ${severityLevel(seizure.severity)}` : ""}`)}"/>`;
    });
    return {
      night,
      html: `<div class="chart clock-chart" style="max-width:${size}px"><svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Time of day for each seizure">${marks}</svg></div>`
    };
  }

  function renderDurationChart(seizures, rangeStart, width) {
    const points = seizures.filter((event) => Number(event.durationSeconds) > 0);
    if (!points.length) return `<p class="subtle">Durations appear once seizures are logged.</p>`;
    const height = 200;
    const left = 46;
    const right = 10;
    const top = 12;
    const bottom = 28;
    const innerWidth = width - left - right;
    const innerHeight = height - top - bottom;
    const end = Date.now();
    const start = Math.min(+rangeStart, +new Date(points[0].occurredAt));
    const maxSeconds = Math.ceil(Math.max(120, ...points.map((event) => event.durationSeconds)) / 60) * 60;
    const step = maxSeconds > 300 ? 120 : maxSeconds > 120 ? 60 : 30;
    const x = (time) => left + ((time - start) / Math.max(1, end - start)) * innerWidth;
    const y = (seconds) => top + innerHeight - (seconds / maxSeconds) * innerHeight;
    let marks = "";
    for (let value = 0; value <= maxSeconds; value += step) {
      const label = value === 0 ? "0" : value % 60 === 0 ? `${value / 60} min` : `${value}s`;
      marks += `<line class="grid" x1="${left}" x2="${width - right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text x="${left - 8}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end">${label}</text>`;
    }
    marks += renderMonthLabels(start, x, height - 8);
    const average = mean(points.map((event) => event.durationSeconds));
    marks += `<line class="ref" x1="${left}" x2="${width - right}" y1="${y(average).toFixed(1)}" y2="${y(average).toFixed(1)}"/>`;
    points.forEach((event, index) => {
      const cx = x(+new Date(event.occurredAt)).toFixed(1);
      const cy = y(event.durationSeconds).toFixed(1);
      marks += `<circle class="dot pop sev-${severityLevel(event.severity)}" style="--i:${index}" cx="${cx}" cy="${cy}" r="6"/><circle class="hit" tabindex="0" cx="${cx}" cy="${cy}" r="13" data-tip="${escapeHtml(`${formatEventDateTime(event)} · ${formatDurationWords(event.durationSeconds)} · severity ${event.severity || "--"}`)}"/>`;
    });
    return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-label="Seizure durations over time">${marks}</svg></div>
      <div class="legend">${renderSeverityScale("Severity")}<span><i class="dash"></i>Average ${escapeHtml(formatDurationWords(average))}</span></div>`;
  }

  function parseLabRange(text) {
    const match = String(text || "").match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/i);
    const low = Number(match?.[1]);
    const high = Number(match?.[2]);
    return match && high > low ? { low, high } : null;
  }

  function levelStatus(value, range) {
    if (!range) return "";
    return value < range.low ? "below" : value > range.high ? "above" : "in";
  }

  function niceStep(raw) {
    const power = 10 ** Math.floor(Math.log10(raw));
    const unit = raw / power;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
  }

  function renderBloodMeasure(name, points, width) {
    const latest = points.at(-1);
    // The newest test that gave a range sets the band, since a vet can change the target.
    const range = [...points].reverse().find((point) => point.range)?.range || null;
    const status = latest ? levelStatus(latest.value, range) : "";
    const tag = status
      ? `<span class="tag ${status === "in" ? "ok" : "bad"}">${status === "in" ? "In range" : status === "above" ? "Above range" : "Below range"}</span>`
      : "";
    return `
      <div class="blood">
        <div class="blood-head"><h4>${escapeHtml(name)}</h4>${tag}</div>
        <p class="blood-now">${latest ? escapeHtml(latest.value) : "--"}<small>${escapeHtml(latest?.unit || "")}</small></p>
        ${renderLevelChart(points, width, latest?.unit || "", range)}
      </div>
    `;
  }

  function renderLevelChart(points, width, unit, range) {
    if (!points.length) return `<p class="fine">No values recorded yet.</p>`;
    const height = 150;
    const left = 40;
    const right = 14;
    const top = 14;
    const bottom = 26;
    const innerWidth = width - left - right;
    const innerHeight = height - top - bottom;
    const t0 = +new Date(points[0].at);
    const t1 = +new Date(points.at(-1).at);
    const values = points.map((point) => point.value);
    const low = Math.min(...values, range ? range.low : Infinity);
    const high = Math.max(...values, range ? range.high : -Infinity);
    let step = niceStep((high - low || Math.max(1, high)) / 2);
    let v0 = Math.max(0, Math.floor((low - step * 0.25) / step) * step);
    let v1 = Math.ceil((high + step * 0.25) / step) * step;
    if ((v1 - v0) / step > 4) {
      step *= 2;
      v0 = Math.max(0, Math.floor(v0 / step) * step);
      v1 = Math.ceil(v1 / step) * step;
    }
    const x = (time) => left + (t1 === t0 ? innerWidth / 2 : ((time - t0) / (t1 - t0)) * innerWidth);
    const y = (value) => top + innerHeight - ((value - v0) / (v1 - v0)) * innerHeight;
    const number = (value) => String(Number(value.toFixed(2)));
    let marks = "";
    if (range) {
      const bandTop = y(range.high);
      const bandHeight = y(range.low) - bandTop;
      marks += `<rect class="band" x="${left}" y="${bandTop.toFixed(1)}" width="${innerWidth}" height="${bandHeight.toFixed(1)}" rx="6"/>`;
      [range.high, range.low].forEach((value) => {
        marks += `<line class="band-edge" x1="${left}" x2="${width - right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/>`;
      });
      marks += `<text class="band-label halo" x="${left + 8}" y="${(bandHeight >= 22 ? bandTop + 14 : bandTop - 6).toFixed(1)}">Target ${number(range.low)}–${number(range.high)}</text>`;
    }
    for (let value = v0; value <= v1 + step / 2; value += step) {
      marks += `<line class="grid" x1="${left}" x2="${width - right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}"/><text x="${left - 6}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end">${number(value)}</text>`;
    }
    const path = points.map((point, index) => `${index ? "L" : "M"}${x(+new Date(point.at)).toFixed(1)},${y(point.value).toFixed(1)}`).join("");
    if (points.length > 1) marks += `<path class="area" d="${path}L${x(t1).toFixed(1)},${top + innerHeight}L${x(t0).toFixed(1)},${top + innerHeight}Z"/><path class="line" d="${path}"/>`;
    // Dates are labelled only where they have room, always keeping the first and the latest.
    const labelled = [];
    [0, points.length - 1, ...points.keys()].forEach((index) => {
      const px = x(+new Date(points[index].at));
      if (labelled.every(([, other]) => Math.abs(other - px) >= 58)) labelled.push([index, px]);
    });
    labelled.forEach(([index, px]) => {
      const anchor = points.length === 1 ? "middle" : index === 0 ? "start" : index === points.length - 1 ? "end" : "middle";
      marks += `<text x="${px.toFixed(1)}" y="${height - 6}" text-anchor="${anchor}">${escapeHtml(new Date(points[index].at).toLocaleDateString(undefined, { day: "numeric", month: "short" }))}</text>`;
    });
    points.forEach((point, index) => {
      const cx = x(+new Date(point.at)).toFixed(1);
      const cy = y(point.value).toFixed(1);
      const status = levelStatus(point.value, range);
      const note = status === "in" ? " · in range" : status === "above" ? " · above range" : status === "below" ? " · below range" : "";
      marks += `<circle class="dot pop${status && status !== "in" ? " off-target" : ""}" style="--i:${index}" cx="${cx}" cy="${cy}" r="5"/>`;
      marks += `<circle class="hit" tabindex="0" cx="${cx}" cy="${cy}" r="12" data-tip="${escapeHtml(`${formatDateShort(new Date(point.at))} · ${point.value} ${unit}`.trim() + note)}"/>`;
    });
    return `<div class="chart"><svg viewBox="0 0 ${width} ${height}" width="${width}" role="img" aria-label="Level over time${range ? `, target ${number(range.low)} to ${number(range.high)}` : ""}">${marks}</svg></div>`;
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

  function renderAiInsightPanel() {
    const insight = state.aiInsight;
    const canRun = hasSupabaseConfig() && isSignedIn();

    return `
      <section class="card ai-panel">
        <div class="section-head">
          <div>
            <p class="eyebrow">AI review</p>
            <h3>${escapeHtml(insight?.title || "Ask AI to review Sawyer's records")}</h3>
          </div>
          <button class="btn yellow small" data-action="generate-ai" ${state.aiBusy || !canRun ? "disabled" : ""}>
            ${state.aiBusy ? "Reviewing..." : "Run AI"}
          </button>
        </div>
        <p class="subtle">${escapeHtml(insight?.summary || (canRun ? "Uses synced Supabase records to draft pattern notes and vet questions." : "Connect Supabase before using AI review."))}</p>
        ${state.aiError ? `<p class="subtle danger-text">${escapeHtml(state.aiError)}</p>` : ""}
        ${insight?.bullets?.length ? `
          <ul class="observations">
            ${insight.bullets.map((item) => `<li><span><strong>${escapeHtml(item.title || "Observation")}.</strong> ${escapeHtml(item.detail || item.body || "")}</span></li>`).join("")}
          </ul>
        ` : ""}
        ${insight?.questions?.length ? `
          <div class="ai-questions">
            <p class="eyebrow">Ask your vet</p>
            <ul>${insight.questions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ul>
          </div>
        ` : ""}
        <p class="fine">AI can notice patterns, but it cannot diagnose or replace your vet.</p>
      </section>
    `;
  }

  function visitSummaryData(days) {
    const since = Date.now() - days * DAY_MS;
    const seizures = getSeizuresAsc().filter((event) => +new Date(event.occurredAt) >= since);
    const episodes = seizures.length ? CORE.seizureEpisodeGaps(seizures, CLUSTER_WINDOW_MS).length + 1 : 0;
    const exceptions = state.events
      .filter((event) => event.type === "dose" && (event.status === "missed" || event.status === "skipped"))
      .filter((event) => +new Date(event.dueAt || event.occurredAt) >= since)
      .sort((a, b) => new Date(a.dueAt || a.occurredAt) - new Date(b.dueAt || b.occurredAt));
    const durations = seizures.map((event) => Number(event.durationSeconds) || 0).filter(Boolean);
    const blood = latestEventOfType("blood_test");
    const visit = latestEventOfType("vet_visit");
    const summary = getSummary();
    return { days, seizures, episodes, exceptions, durations, blood, visit, summary };
  }

  function bloodLevelsText(test) {
    const parts = [
      formatLabLevel(test.phenobarbital) || test.phenobarbitalLevel ? `phenobarbital ${formatLabLevel(test.phenobarbital) || test.phenobarbitalLevel}` : "",
      formatLabLevel(test.bromide) || test.bromideLevel ? `bromide ${formatLabLevel(test.bromide) || test.bromideLevel}` : ""
    ].filter(Boolean);
    return parts.join(", ") || test.panel || "results saved";
  }

  function visitSummaryText(data) {
    const name = state.profile?.name || "Sawyer";
    const lines = [`${name}: care summary for the last ${data.days} days (to ${formatDateShort(new Date())})`, ""];
    lines.push(`Seizures: ${data.seizures.length} (${data.episodes} episode${data.episodes === 1 ? "" : "s"}).${data.durations.length ? ` Average duration ${formatDurationWords(mean(data.durations))}.` : ""}`);
    data.seizures.slice().reverse().forEach((event) => {
      lines.push(`- ${formatEventDateTime(event)}: ${formatDurationWords(event.durationSeconds)}, severity ${event.severity || "--"}${event.symptoms?.length ? `, ${event.symptoms.join(", ").toLowerCase()}` : ""}${isAutomaticCluster(event) ? ", cluster" : ""}`);
    });
    lines.push(`Current gap: ${data.summary.daysSinceLast === null ? "no seizures logged" : `${data.summary.daysSinceLast} days`}. Longest gap: ${data.summary.longestGapText}.`, "");
    lines.push(`Missed or skipped doses: ${data.exceptions.length}.`);
    data.exceptions.forEach((event) => lines.push(`- ${event.medicationName || "Dose"} ${event.label ? event.label.toLowerCase() : ""}, ${formatDateShort(new Date(event.dueAt || event.occurredAt))}: ${event.status}`));
    if (data.blood) lines.push("", `Latest blood test ${formatDateShort(new Date(data.blood.occurredAt))}: ${bloodLevelsText(data.blood)}.`);
    if (data.visit) lines.push(`Last vet visit ${formatDateShort(new Date(data.visit.occurredAt))}: ${data.visit.reason || "visit"}${data.visit.weight ? `, weight ${data.visit.weight}` : ""}.`);
    return lines.join("\n");
  }

  function renderVet() {
    const visits = state.events.filter((event) => event.type === "vet_visit").sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
    const tests = state.events.filter((event) => event.type === "blood_test").sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
    const history = [...visits, ...tests].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
    const latest = visits[0];
    const data = visitSummaryData(state.vetRange);
    const columns = window.innerWidth >= 620 ? 2 : 1;
    const inner = chartWidth(2);
    const lineWidth = Math.max(220, Math.floor((inner - (columns - 1) * 12) / columns - 28));
    const series = (key) => tests.filter((test) => Number.isFinite(test[key]?.value)).map((test) => ({
      at: test.occurredAt, value: test[key].value, unit: test[key].unit || "", range: parseLabRange(test[key].referenceRange)
    }));
    const pheno = series("phenobarbital");
    const bromide = series("bromide");
    const doseRate = (() => {
      const since = Date.now() - state.vetRange * DAY_MS;
      const logged = state.events.filter((event) => event.type === "dose" && +new Date(event.dueAt || event.occurredAt) >= since);
      return logged.length;
    })();

    return `
      <div class="vet-grid">
        <section class="vet-hero on-color" aria-label="Vet visits">
          ${leaf("--s:240px;--r:30deg;right:-70px;top:-80px")}
          ${leaf("--s:140px;--r:-10deg;left:30%;bottom:-70px;--d:28s")}
          <p class="eyebrow">${latest ? "Last visit" : "Vet"}</p>
          <h2>${latest ? escapeHtml(latest.reason || "Vet Visit") : "Keep Visits Together"}</h2>
          ${latest ? `
            <dl class="vet-meta">
              <div><dt>Date</dt><dd>${escapeHtml(formatDateShort(new Date(latest.occurredAt)))}</dd></div>
              <div><dt>Clinic</dt><dd>${escapeHtml(latest.clinic || "--")}</dd></div>
              <div><dt>Weight</dt><dd>${escapeHtml(latest.weight || "--")}</dd></div>
            </dl>
            ${latest.plan ? `<p class="vet-plan">${escapeHtml(latest.plan)}</p>` : ""}
          ` : `<p class="vet-plan">Record visits, blood tests and PDFs here, then copy a summary before the next appointment.</p>`}
          <div class="btn-row">
            <button class="btn yellow" data-overlay="vet_visit" type="button">${icon("plus")}Add Visit</button>
            <button class="btn glass" data-overlay="blood_test" type="button">${icon("drop")}Add Blood Test</button>
          </div>
        </section>

        <section class="card visit-summary" id="visit-summary" aria-label="Visit summary">
          <div class="section-head">
            <div><h3>Visit Summary</h3><p class="fine">Built from your records. Copy it into an email or read it out at the visit.</p></div>
            <div class="chips" role="group" aria-label="Summary range">
              ${[30, 90].map((days) => `<button class="chip" data-vet-range="${days}" type="button" aria-pressed="${state.vetRange === days}">${days} days</button>`).join("")}
            </div>
          </div>
          <div class="summary-card">
            <div class="summary-grid">
              <div><small>Seizures</small><strong>${data.seizures.length}</strong></div>
              <div><small>Episodes</small><strong>${data.episodes}</strong></div>
              <div><small>Average length</small><strong>${data.durations.length ? formatDurationWords(mean(data.durations)) : "--"}</strong></div>
              <div><small>Dose exceptions</small><strong>${data.exceptions.length}</strong></div>
            </div>
            <div class="summary-section"><h4>Seizures</h4>${data.seizures.length
              ? `<ul>${data.seizures.slice().reverse().map((event) => `<li>${escapeHtml(formatEventDateTime(event))}: ${escapeHtml(formatDurationWords(event.durationSeconds))}, severity ${escapeHtml(event.severity || "--")}${isAutomaticCluster(event) ? " · cluster" : ""}</li>`).join("")}</ul>`
              : `<p class="fine">None in this period.</p>`}</div>
            <div class="summary-section"><h4>Missed or skipped doses</h4>${data.exceptions.length
              ? `<ul>${data.exceptions.map((event) => `<li>${escapeHtml(event.medicationName || "Dose")}${event.label ? ` ${escapeHtml(event.label.toLowerCase())}` : ""}, ${escapeHtml(formatDateShort(new Date(event.dueAt || event.occurredAt)))}: ${escapeHtml(event.status)}</li>`).join("")}</ul>`
              : `<p class="fine">${doseRate ? "None recorded." : "No dose records in this period."}</p>`}</div>
            ${data.blood || data.visit ? `<div class="summary-section"><h4>Latest results</h4><ul>
              ${data.blood ? `<li>Blood test ${escapeHtml(formatDateShort(new Date(data.blood.occurredAt)))}: ${escapeHtml(bloodLevelsText(data.blood))}</li>` : ""}
              ${data.visit?.weight ? `<li>Weight ${escapeHtml(data.visit.weight)} on ${escapeHtml(formatDateShort(new Date(data.visit.occurredAt)))}</li>` : ""}
            </ul></div>` : ""}
          </div>
          <div class="btn-row"><button class="btn yellow" data-action="copy-summary" type="button">${icon("copy")}Copy Summary</button></div>
          <div id="summary-fallback"></div>
        </section>

        <section class="card" aria-label="Blood levels">
          <div class="section-head"><h3>Blood Levels</h3><span class="fine">${tests.length} test${tests.length === 1 ? "" : "s"}</span></div>
          <div class="bloods">
            ${renderBloodMeasure("Phenobarbital", pheno, lineWidth)}
            ${renderBloodMeasure("Bromide", bromide, lineWidth)}
          </div>
          ${[...pheno, ...bromide].some((point) => point.range)
            ? `<div class="legend"><span><i class="band"></i>Target range from the latest test</span><span><i class="dot-off"></i>Outside the range</span></div>`
            : `<p class="fine">Values as entered from lab reports. Add the lab's reference range to a test to see the target band.</p>`}
        </section>

        <section class="card document-library-panel">
          ${renderVetDocuments(toDateInputValue(new Date()))}
        </section>

        <section class="card wide" aria-label="Visit and test history">
          <div class="section-head"><h3>Visits And Tests</h3><span class="fine">${history.length} saved</span></div>
          <div class="row-list timeline-list">${history.length ? history.map(renderTimelineItem).join("") : `<p class="subtle">No vet visits or blood tests saved yet.</p>`}</div>
        </section>
      </div>
    `;
  }

  function renderOverlay() {
    const overlay = state.overlay;
    if (!overlay) return "";
    const enter = state.overlayFresh ? " enter" : "";
    if (overlay.kind === "timer") return state.timer ? renderTimerOverlay(enter) : "";
    if (overlay.kind === "seizure") return renderSeizureOverlay(enter);
    const sheet = renderSheet(overlay);
    if (!sheet) return "";
    return `
      <div class="scrim${enter}" data-close-overlay></div>
      <div class="sheet ${sheet.className || ""}${enter}" role="dialog" aria-modal="true" aria-labelledby="sheet-title">${sheet.html}</div>
    `;
  }

  function sheetHead(title) {
    return `<div class="grab" aria-hidden="true"></div><div class="sheet-head"><h2 id="sheet-title">${title}</h2><button class="ibtn" data-close-overlay type="button" aria-label="Close">${icon("close")}</button></div>`;
  }

  function renderSheet(overlay) {
    if (overlay.kind === "menu") {
      const routine = routineOf(new Date());
      return {
        className: "menu-sheet",
        html: `${sheetHead("New Record")}<div class="sheet-body" data-overlay-scroll><div class="menu-grid">
          <div class="menu-tile big">${leaf("--s:200px;--r:30deg;right:-50px;top:-70px")}${icon("timer")}<b>Seizure</b><p>Start the timer now, or log one that has already happened.</p>
            <div class="btn-row"><button class="btn yellow" data-action="start-timer" type="button">${icon("timer")}Start Timer</button><button class="btn glass" data-overlay="seizure" type="button">Log Past Seizure</button></div></div>
          <button class="menu-tile dose" data-overlay="routine" data-routine="${routine}" type="button">${icon("pill")}<b>Dose</b><p>${ROUTINES[routine].label} routine</p></button>
          <button class="menu-tile note" data-overlay="note" type="button">${icon("note")}<b>Note</b><p>Observation or handover</p></button>
          <button class="menu-tile vet" data-overlay="vet_visit" type="button">${icon("vet")}<b>Vet Visit</b><p>Reason, plan and weight</p></button>
          <button class="menu-tile blood" data-overlay="blood_test" type="button">${icon("drop")}<b>Blood Test</b><p>Levels and results</p></button>
        </div></div>`
      };
    }
    if (overlay.kind === "routine") {
      const routine = ROUTINES[overlay.routine] ? overlay.routine : "morning";
      const tone = ROUTINES[routine].tone;
      return {
        className: `routine-sheet on-color tone-${tone}`,
        html: `
          <div class="layer layer-yellow" style="opacity:${tone === "yellow" ? 1 : 0}"></div>
          <div class="layer layer-berry" style="opacity:${tone === "berry" ? 1 : 0}"></div>
          ${leaf("--s:260px;--r:-30deg;right:-90px;top:-60px;--d:26s")}
          ${leaf("--s:180px;--r:60deg;left:-60px;bottom:10%;--d:30s")}
          <div class="grab" aria-hidden="true"></div>
          <div class="sheet-head">
            <div class="routine-switch" role="group" aria-label="Routine">
              ${Object.entries(ROUTINES).map(([key, meta]) => `<button data-routine-switch="${key}" type="button" aria-pressed="${key === routine}">${icon(meta.icon)}${meta.label}</button>`).join("")}
            </div>
            <button class="ibtn glass" data-close-overlay type="button" aria-label="Close">${icon("close")}</button>
          </div>
          <div class="sheet-body ${state.overlayFresh ? "unfold" : ""}" id="routine-body" data-overlay-scroll>${renderRoutineBody(routine)}</div>`
      };
    }
    if (overlay.kind === "note" || overlay.kind === "vet_visit" || overlay.kind === "blood_test") {
      return { className: "form-sheet", html: renderRecordForm(overlay.kind) };
    }
    if (overlay.kind === "household") {
      return { className: "household-sheet", html: `${sheetHead("Household")}<div class="sheet-body" data-overlay-scroll>${renderHousehold()}</div>` };
    }
    return null;
  }

  function renderRecordForm(kind) {
    const now = new Date();
    const editing = state.events.find((event) => event.id === state.editingRecordId && event.type === kind);
    const recordDate = editing ? new Date(editing.occurredAt) : now;
    const localDate = toDateInputValue(recordDate);
    const localTime = toTimeInputValue(recordDate);
    const cancel = editing ? `<button class="btn ghost" data-action="cancel-record-edit" type="button">Cancel</button>` : "";

    if (kind === "note") {
      return `${sheetHead(editing ? "Edit Note" : "New Note")}<div class="sheet-body" data-overlay-scroll>
        <form id="note-form" class="form record-form">
          <input type="hidden" name="id" value="${escapeHtml(editing?.id || "")}" />
          <div class="field">
            <label for="note-title">Title</label>
            <input id="note-title" name="title" value="${escapeHtml(editing?.title || "")}" placeholder="Appetite, behaviour, vet call" />
          </div>
          <div class="field">
            <label for="note-body">Note</label>
            <textarea id="note-body" name="body" required>${escapeHtml(editing?.body || "")}</textarea>
          </div>
          <label class="switch-row" for="note-handover">
            <span>Show as handover<small>Pinned at the top of Records for the next carer.</small></span>
            <input id="note-handover" class="switch" name="handover" type="checkbox" ${editing?.handover ? "checked" : ""} />
          </label>
          <div class="btn-row">
            <button class="btn yellow big" type="submit">${editing ? "Update Note" : "Save Note"}</button>
            ${cancel}
          </div>
        </form></div>`;
    }

    if (kind === "vet_visit") {
      return `${sheetHead(editing ? "Edit Vet Visit" : "Vet Visit")}<div class="sheet-body" data-overlay-scroll>
        <form id="vet-form" class="form record-form">
          <input type="hidden" name="id" value="${escapeHtml(editing?.id || "")}" />
          <div class="row2">
            <div class="field"><label for="vet-date">Date</label>${renderDateInput("vet-date", "date", localDate, true)}</div>
            <div class="field"><label for="vet-time">Time</label>${renderTimeInput("vet-time", "time", localTime)}</div>
          </div>
          <div class="field">
            <label for="vet-clinic">Clinic or vet</label>
            <input id="vet-clinic" name="clinic" value="${escapeHtml(editing?.clinic || "")}" placeholder="Vet name or clinic" />
          </div>
          <div class="field">
            <label for="vet-reason">Reason</label>
            <input id="vet-reason" name="reason" value="${escapeHtml(editing?.reason || "")}" placeholder="Checkup, seizure review, medication review" required />
          </div>
          <div class="field">
            <label for="vet-weight">Weight</label>
            <input id="vet-weight" name="weight" value="${escapeHtml(editing?.weight || "")}" placeholder="Example: 24.8 kg" />
          </div>
          <div class="field">
            <label for="vet-plan">Plan or medication changes</label>
            <textarea id="vet-plan" name="plan" placeholder="Next steps, dose changes, follow-up date">${escapeHtml(editing?.plan || "")}</textarea>
          </div>
          <div class="btn-row">
            <button class="btn yellow big" type="submit">${editing ? "Update Vet Visit" : "Save Vet Visit"}</button>
            ${cancel}
          </div>
        </form></div>`;
    }

    return `${sheetHead(editing ? "Edit Blood Test" : "Blood Test")}<div class="sheet-body" data-overlay-scroll>
      <form id="blood-test-form" class="form record-form">
        <input type="hidden" name="id" value="${escapeHtml(editing?.id || "")}" />
        <div class="row2">
          <div class="field"><label for="blood-date">Date</label>${renderDateInput("blood-date", "date", localDate, true)}</div>
          <div class="field"><label for="blood-time">Time</label>${renderTimeInput("blood-time", "time", localTime)}</div>
        </div>
        <div class="field">
          <label for="blood-panel">Test or panel</label>
          <input id="blood-panel" name="panel" value="${escapeHtml(editing?.panel || "")}" placeholder="Phenobarbital level, bromide level, liver panel" required />
        </div>
        ${renderLabLevelFields("Phenobarbital", "phenobarbital", editing?.phenobarbital || null)}
        ${renderLabLevelFields("Bromide", "bromide", editing?.bromide || null)}
        ${editing && !editing.phenobarbital && editing.phenobarbitalLevel ? `<p class="fine">Earlier phenobarbital entry: ${escapeHtml(editing.phenobarbitalLevel)}</p>` : ""}
        ${editing && !editing.bromide && editing.bromideLevel ? `<p class="fine">Earlier bromide entry: ${escapeHtml(editing.bromideLevel)}</p>` : ""}
        <div class="field">
          <label for="blood-results">Results</label>
          <textarea id="blood-results" name="results" placeholder="Paste key results or lab notes">${escapeHtml(editing?.results || "")}</textarea>
        </div>
        <div class="field">
          <label for="blood-notes">Notes</label>
          <textarea id="blood-notes" name="notes" placeholder="Vet interpretation, recheck timing, changes">${escapeHtml(editing?.notes || "")}</textarea>
        </div>
        <div class="btn-row">
          <button class="btn yellow big" type="submit">${editing ? "Update Blood Test" : "Save Blood Test"}</button>
          ${cancel}
        </div>
      </form></div>`;
  }

  function focusOrigin() {
    const point = state.lastPointer;
    return point ? `--ox:${Math.round(point.x)}px;--oy:${Math.round(point.y)}px` : "--ox:50%;--oy:100%";
  }

  function renderSeizureOverlay(enter) {
    const now = new Date();
    const editing = state.events.find((event) => event.id === state.editingSeizureId && event.type === "seizure");
    const prefill = editing ? null : state.seizurePrefill;
    const seizureDate = editing ? new Date(editing.occurredAt) : prefill ? new Date(prefill.occurredAt) : now;
    const durationSeconds = Math.max(0, editing ? editing.durationSeconds || 0 : prefill?.durationSeconds || 0);
    const timeKnown = editing ? editing.timeKnown !== false : Boolean(prefill);
    const selectedSeverity = editing?.severity || state.severity;
    const symptoms = editing?.symptoms || prefill?.symptoms || [];
    const trigger = editing?.trigger || "Unknown";
    const title = editing ? "Edit Seizure" : prefill ? "Seizure Timed" : "Log Seizure";

    return `
      <div class="focus seizure-focus${enter}" role="dialog" aria-modal="true" aria-labelledby="focus-title" style="${focusOrigin()}" data-overlay-scroll>
        ${leaf("--s:420px;--r:-30deg;left:-140px;top:-120px;--d:30s")}
        ${leaf("--s:300px;--r:50deg;right:-120px;bottom:-60px;--d:34s")}
        <div class="focus-in on-color">
          <div class="fhead">
            <span class="tag glass">${editing ? "Update record" : prefill ? "From the timer" : "Quick record"}</span>
            <button class="ibtn glass" data-action="${editing ? "cancel-seizure-edit" : "close-overlay"}" type="button" aria-label="Close">${icon("close")}</button>
          </div>
          <h2 class="ftitle" id="focus-title">${title}</h2>
          <form id="seizure-form" class="form seizure-form">
            <input type="hidden" name="id" value="${escapeHtml(editing?.id || "")}" />
            <div class="row2 stack-sm">
              <div class="field">
                <label for="seizure-date">Date</label>
                ${renderDateInput("seizure-date", "date", toDateInputValue(seizureDate), true)}
              </div>
              <label class="switch-row quick-time-toggle" for="seizure-time-known">
                <span>Time known<small data-time-status>${timeKnown ? "Included" : "Not needed"}</small></span>
                <input id="seizure-time-known" class="switch" name="timeKnown" type="checkbox" data-time-known ${timeKnown ? "checked" : ""} />
              </label>
            </div>
            <div class="field optional-time-field" data-optional-time ${timeKnown ? "" : "hidden"}>
              <label for="seizure-time">Approximate time</label>
              ${renderTimeInput("seizure-time", "time", toTimeInputValue(seizureDate))}
            </div>
            <div class="fsec">
              <p class="flabel"><span>Duration</span><output id="duration-output">${formatDuration(durationSeconds)}</output></p>
              <div class="duration duration-inputs">
                <div class="stepper">
                  <button data-step="duration-minutes" data-delta="-1" type="button" aria-label="One minute less">${icon("minus")}</button>
                  <label class="sr-only" for="duration-minutes">Minutes</label>
                  <input id="duration-minutes" name="durationMinutes" type="number" min="0" step="1" inputmode="numeric" value="${Math.floor(durationSeconds / 60)}" required />
                  <span class="unit">min</span>
                  <button data-step="duration-minutes" data-delta="1" type="button" aria-label="One minute more">${icon("plus")}</button>
                </div>
                <div class="stepper">
                  <button data-step="duration-seconds" data-delta="-5" type="button" aria-label="Five seconds less">${icon("minus")}</button>
                  <label class="sr-only" for="duration-seconds">Seconds</label>
                  <input id="duration-seconds" name="durationSeconds" type="number" min="0" max="59" step="1" inputmode="numeric" value="${durationSeconds % 60}" required />
                  <span class="unit">sec</span>
                  <button data-step="duration-seconds" data-delta="5" type="button" aria-label="Five seconds more">${icon("plus")}</button>
                </div>
              </div>
            </div>
            <div class="fsec">
              <p class="flabel"><span>Severity</span><span>1 mild · 5 severe</span></p>
              <input id="seizure-severity" name="severity" type="hidden" value="${escapeHtml(selectedSeverity)}" />
              <div class="round-chips" role="group" aria-label="Severity">
                ${[1, 2, 3, 4, 5].map((n) => `<button type="button" aria-pressed="${Number(selectedSeverity) === n}" class="round-chip ${Number(selectedSeverity) === n ? "active" : ""}" data-severity="${n}">${n}</button>`).join("")}
              </div>
            </div>
            <div class="fsec">
              <p class="flabel">Symptoms</p>
              <div class="text-chips">
                ${SYMPTOMS.map((symptom) => `<label class="text-chip"><input type="checkbox" name="symptoms" value="${escapeHtml(symptom)}" ${symptoms.includes(symptom) ? "checked" : ""} />${escapeHtml(symptom)}</label>`).join("")}
              </div>
            </div>
            <div class="fsec">
              <p class="flabel">Possible trigger</p>
              <div class="text-chips">
                ${TRIGGERS.map((item) => `<label class="text-chip"><input type="radio" name="trigger" value="${escapeHtml(item)}" ${trigger === item ? "checked" : ""} />${escapeHtml(item)}</label>`).join("")}
              </div>
            </div>
            <div class="field">
              <label for="rescue">Care given</label>
              <textarea id="rescue" name="rescue" placeholder="Example: stayed with him, cooled the room, called the vet">${escapeHtml(editing?.rescue || "")}</textarea>
            </div>
            <div class="field">
              <label for="recovery">Recovery</label>
              <textarea id="recovery" name="recovery" placeholder="Example: pacing for 20 minutes, ate after">${escapeHtml(editing?.recovery || "")}</textarea>
            </div>
            <div class="field">
              <label for="notes">Notes</label>
              <textarea id="notes" name="notes">${escapeHtml(editing?.notes || "")}</textarea>
            </div>
            <div class="focus-actions">
              <button class="btn yellow big block" type="submit">${editing ? "Update seizure" : "Save seizure"}</button>
              ${editing ? `<button class="btn glass block" data-delete-event="${escapeHtml(editing.id)}" type="button">Delete seizure</button>` : ""}
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderTimerOverlay(enter) {
    const plan = String(state.profile?.emergencyPlan || "").trim();
    const minutes = clamp(Number(state.profile?.emergencyPlanMinutes) || 5, 1, 30);
    return `
      <div class="focus timer-focus${enter}" role="dialog" aria-modal="true" aria-label="Seizure timer" style="${focusOrigin()}" data-overlay-scroll>
        ${leaf("--s:420px;--r:-30deg;left:-140px;top:-120px;--d:30s")}
        ${leaf("--s:300px;--r:50deg;right:-120px;bottom:-60px;--d:34s")}
        <div class="focus-in on-color">
          <div class="fhead">
            <span class="tag live">Recording</span>
            <button class="ibtn glass" data-action="minimize-timer" type="button" aria-label="Hide the timer and keep recording">${icon("down")}</button>
          </div>
          <div class="timer-wrap">
            <div class="breath"></div>
            <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="arc-trk" cx="50" cy="50" r="48"/><circle class="arc-val" id="timer-arc" cx="50" cy="50" r="48" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg>
            <div class="timer-center">
              <div class="timer" id="timer-out" role="timer">0:00</div>
              <div class="timer-sub">Started ${escapeHtml(formatTime(new Date(state.timer.start)))}</div>
            </div>
          </div>
          <div class="plan" id="timer-plan" data-limit="${minutes * 60}">
            ${icon("info")}
            <span>${plan ? `<b>Your vet's plan.</b> ${escapeHtml(plan)}` : `The ring fills at ${minutes} minute${minutes === 1 ? "" : "s"}. Add your vet's emergency plan in Household to show it here.`}</span>
          </div>
          <div>
            <p class="flabel">Tap what you see. It goes into the record.</p>
            <div class="text-chips">
              ${SYMPTOMS.map((symptom) => `<button class="text-chip" data-mark-symptom="${escapeHtml(symptom)}" type="button" aria-pressed="${state.timer.symptoms.includes(symptom)}">${escapeHtml(symptom)}</button>`).join("")}
            </div>
          </div>
          <div class="focus-actions">
            <button class="btn yellow big block" data-action="end-timer" type="button">${icon("check")}Seizure Ended</button>
            ${state.timerConfirmDiscard
              ? `<div class="focus-confirm"><span>Discard this recording? The time won't be saved.</span><div class="btn-row"><button class="btn white" data-action="discard-timer" type="button">Discard</button><button class="btn glass" data-action="keep-timer" type="button">Keep Recording</button></div></div>`
              : `<button class="btn glass block" data-action="ask-discard-timer" type="button">Discard</button>`}
          </div>
        </div>
      </div>
    `;
  }

  function renderTimerPill() {
    if (!state.timer || state.overlay?.kind === "timer") return "";
    return `<button class="timer-pill" data-action="restore-timer" type="button"><span class="dot" aria-hidden="true"></span><span id="timer-pill-text">Recording</span><span class="return">Return</span></button>`;
  }

  function updateTimerDisplay() {
    if (!state.timer) return;
    const seconds = Math.max(0, (Date.now() - state.timer.start) / 1000);
    const clock = `${Math.floor(seconds / 60)}:${pad(Math.floor(seconds % 60))}`;
    const output = document.querySelector("#timer-out");
    if (output) output.textContent = clock;
    const plan = document.querySelector("#timer-plan");
    const limit = Number(plan?.dataset.limit) || 300;
    document.querySelector("#timer-arc")?.setAttribute("stroke-dashoffset", Math.max(0, 100 - (seconds / limit) * 100).toFixed(2));
    plan?.classList.toggle("alert", seconds >= limit);
    const pill = document.querySelector("#timer-pill-text");
    if (pill) pill.textContent = `Recording ${clock}`;
  }

  function renderHousehold() {
    const notificationText = "Notification" in window ? Notification.permission : "Not supported";
    const pushSupported = isPushSupported();
    const pushEnabled = pushSupported && state.settings?.pushNotificationsEnabled && Notification.permission === "granted";
    const pushStatus = !pushSupported ? "Not supported" : Notification.permission === "denied" ? "Blocked" : pushEnabled ? "On" : "Off";
    const lastBackup = state.settings?.lastBackupAt ? formatDateTime(new Date(state.settings.lastBackupAt)) : "No backup yet";

    return `
      ${renderPendingRecords()}
      ${state.installPrompt ? `<section class="household-section"><h3>Install</h3><p class="subtle">Add Sawyer Tracker to the home screen for faster access.</p><button class="btn yellow" data-action="install-app" type="button">Install</button></section>` : ""}

      <section class="household-section">
        <h3>Care Setup</h3>
        <form id="setup-form" class="form">
          <div class="field">
            <label for="dog-name">Dog name</label>
            <input id="dog-name" name="dogName" value="${escapeHtml(state.profile?.name || "Sawyer")}" required />
          </div>
          <label class="switch-row" for="confirm-doses">
            <span>Require confirmation for each dose<small>Otherwise doses count as given unless marked missed.</small></span>
            <input id="confirm-doses" class="switch" name="confirmDoses" type="checkbox" ${state.profile?.doseConfirmationMode === "explicit" ? "checked" : ""} />
          </label>
          <div class="field">
            <label for="emergency-plan">Emergency plan from your vet</label>
            <textarea id="emergency-plan" name="emergencyPlan" maxlength="300" placeholder="What your vet told you to do, and when to call">${escapeHtml(state.profile?.emergencyPlan || "")}</textarea>
            <small class="field-help">Shown on the seizure timer on both phones.</small>
          </div>
          <div class="field">
            <label for="emergency-minutes">Highlight the plan after this many minutes</label>
            <input id="emergency-minutes" name="emergencyPlanMinutes" type="number" min="1" max="30" step="1" inputmode="numeric" value="${escapeHtml(state.profile?.emergencyPlanMinutes || 5)}" />
          </div>
          <div class="setup-list">
            ${state.schedules.map(renderSetupSchedule).join("")}
          </div>
          <button class="btn yellow big" type="submit">Save Setup</button>
        </form>
      </section>

      <section class="household-section">
        <h3>Seizure-free push alerts</h3>
        <p class="subtle">Receive an alert when ${escapeHtml(state.profile?.name || "Sawyer")} earns a new 5-day heart, matches the longest completed streak, or reaches the historical average gap, even when the app is closed.</p>
        ${isIosBrowser() ? `<p class="subtle danger-text">On iPhone, add Sawyer Tracker to the Home Screen and open it from its icon before enabling push alerts.</p>` : ""}
        <div class="stat-row">
          <div><small>Status</small><strong>${escapeHtml(pushStatus)}</strong></div>
          <div><small>Permission</small><strong>${escapeHtml(capitalize(notificationText))}</strong></div>
          <div><small>Delivery</small><strong>Background</strong></div>
        </div>
        <div class="btn-row">
          <button class="btn yellow" data-action="enable-push">Enable Push Alerts</button>
          <button class="btn ghost" data-action="test-push" ${pushEnabled ? "" : "disabled"}>Send Test</button>
          <button class="btn ghost" data-action="disable-push">Disable</button>
        </div>
        <p class="fine">Average-gap alerts describe the recorded history only. They are not a medical prediction.</p>
      </section>

      ${renderCloudSync()}

      <section class="household-section">
        <h3>Backup</h3>
        <p class="subtle">Last backup: ${escapeHtml(lastBackup)}</p>
        <p class="fine">Complete backups include every cloud record, deletion marker and private vet PDF.</p>
        ${state.backupMessage ? `<p class="subtle">${escapeHtml(state.backupMessage)}</p>` : ""}
        <div class="btn-row">
          <button class="btn yellow" data-action="export-json" ${state.backupBusy ? "disabled" : ""}>${state.backupBusy ? "Working..." : "Download Complete Backup"}</button>
          <button class="btn ghost" data-action="import-json" ${state.backupBusy ? "disabled" : ""}>Restore Backup</button>
          <button class="btn ghost" data-action="export-csv" ${state.backupBusy ? "disabled" : ""}>Export CSV</button>
        </div>
      </section>

      <section class="household-section danger-zone">
        <h3>This Device</h3>
        <p class="subtle">Clearing local data only affects this device.</p>
        <button class="btn danger" data-action="reset-data">Clear Local Data</button>
      </section>
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
      <section class="household-section">
        <h3>Supabase Sync</h3>
        <div class="stat-row">
          <div><small>Status</small><strong>${escapeHtml(syncStatus)}</strong></div>
          <div><small>Access</small><strong>${escapeHtml(signedInEmail() || "--")}</strong></div>
          <div><small>Last sync</small><strong>${escapeHtml(lastSync)}</strong></div>
        </div>
        <p class="subtle">${escapeHtml(sourceMessage)}</p>
        ${syncMessage ? `<p class="subtle">${escapeHtml(syncMessage)}</p>` : ""}

        <details class="disclosure sync-advanced">
          <summary><span><strong>Advanced connection settings</strong></span>${icon("chev", "i chev")}</summary>
          <form id="sync-config-form" class="form sync-form">
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
            <button class="btn yellow" type="submit">Save Sync Setup</button>
          </form>
        </details>

        ${
          storedAccess
            ? `
              <div class="btn-row sync-actions">
                <button class="btn yellow" data-action="sync-now" ${state.syncBusy ? "disabled" : ""}>${icon("sync")}Sync Now</button>
                <button class="btn ghost" data-action="sign-out">Forget Access</button>
              </div>
            `
            : renderTrustedDeviceLogin(configured)
        }
      </section>
    `;
  }

  function renderSetupSchedule(schedule) {
    // Schedule and time ids arrive from synced rows, so they are escaped like any other shared text.
    // renderDateInput and renderTimeInput escape their own id and name arguments.
    const scheduleId = escapeHtml(schedule.id);
    return `
      <div class="schedule-card">
        <h4>${escapeHtml(schedule.name)}</h4>
        <div class="row2 setup-dose-grid">
          <div class="field">
            <label for="${scheduleId}-dose">Dose</label>
            <input id="${scheduleId}-dose" name="${scheduleId}:dose" value="${escapeHtml(schedule.dose || "")}" placeholder="Optional" />
          </div>
          <div class="field">
            <label for="${scheduleId}-unit">Unit</label>
            <input id="${scheduleId}-unit" name="${scheduleId}:unit" value="${escapeHtml(schedule.unit || "")}" placeholder="mg, ml, capsules" />
          </div>
        </div>
        <div class="field setup-effective-date">
          <label for="${scheduleId}-effective-from">Current regimen effective from</label>
          ${renderDateInput(`${schedule.id}-effective-from`, `${schedule.id}:effectiveFrom`, schedule.effectiveFrom || "")}
          <small class="field-help">Leave blank when the start date is unknown.</small>
        </div>
        ${schedule.times.map((time) => {
          const timeId = escapeHtml(time.id);
          return `
          <div class="row2 setup-row">
            <div class="field">
              <label for="${scheduleId}-${timeId}-label">${escapeHtml(time.label)}</label>
              <input id="${scheduleId}-${timeId}-label" name="${scheduleId}:${timeId}:label" value="${escapeHtml(time.label)}" />
            </div>
            <div class="field">
              <label for="${scheduleId}-${timeId}-time">Time</label>
              ${renderTimeInput(`${schedule.id}-${time.id}-time`, `${schedule.id}:${time.id}:time`, time.time)}
            </div>
          </div>
        `;
        }).join("")}
      </div>
    `;
  }

  function bindUi() {
    drafts.bind(app, (form) => {
      if (form.getAttribute("id") === "setup-form") {
        return JSON.stringify(Object.fromEntries([state.profile, ...state.schedules].filter(Boolean)
          .map((record) => [record.id, SYNC.pending(record) ? record.syncBaseUpdatedAt : record.serverUpdatedAt || record.updatedAt])));
      }
      const record = state.events.find((item) => item.id === form.elements.namedItem("id")?.value);
      return record ? (SYNC.pending(record) ? record.syncBaseUpdatedAt : record.serverUpdatedAt || record.updatedAt) : "";
    });
    const restoredSeverity = document.querySelector("#seizure-severity")?.value;
    if (state.savingFormId) {
      const savingForm = document.getElementById(state.savingFormId);
      if (savingForm) { savingForm.inert = true; savingForm.setAttribute("aria-busy", "true"); }
    }
    document.querySelectorAll("[data-severity]").forEach((button) => {
      const active = button.dataset.severity === restoredSeverity;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    document.querySelectorAll("[data-resolve-conflict]").forEach((button) => {
      button.addEventListener("click", () => resolveConflict(button.dataset.store, button.dataset.record, button.dataset.resolveConflict));
    });
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        const changed = state.activeTab !== button.dataset.tab;
        state.activeTab = button.dataset.tab;
        state.overlay = null;
        state.seizurePrefill = null;
        state.editingSeizureId = "";
        state.editingRecordId = "";
        render();
        if (changed) document.querySelector(".view.active")?.classList.add("enter");
        if (button.dataset.scroll) {
          requestAnimationFrame(() => document.getElementById(button.dataset.scroll)?.scrollIntoView({
            block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth"
          }));
        }
      });
    });

    document.querySelectorAll("[data-overlay]").forEach((button) => {
      button.addEventListener("click", () => {
        state.editingSeizureId = "";
        state.editingRecordId = "";
        openOverlay(button.dataset.overlay, button.dataset.routine ? { routine: button.dataset.routine } : {});
      });
    });
    document.querySelectorAll("[data-close-overlay]").forEach((element) => {
      element.addEventListener("click", () => closeOverlay());
    });
    document.querySelectorAll("[data-routine-switch]").forEach((button) => {
      button.addEventListener("click", () => switchRoutine(button.dataset.routineSwitch));
    });
    document.querySelectorAll("[data-mark-symptom]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!state.timer) return;
        const symptom = button.dataset.markSymptom;
        const index = state.timer.symptoms.indexOf(symptom);
        if (index >= 0) state.timer.symptoms.splice(index, 1);
        else state.timer.symptoms.push(symptom);
        saveTimer();
        button.setAttribute("aria-pressed", String(index < 0));
      });
    });
    document.querySelectorAll("[data-step]").forEach((button) => {
      button.addEventListener("click", () => {
        const minutes = document.querySelector("#duration-minutes");
        const seconds = document.querySelector("#duration-seconds");
        if (!minutes || !seconds) return;
        const delta = Number(button.dataset.delta || 0) * (button.dataset.step === "duration-minutes" ? 60 : 1);
        const total = Math.max(0, (Number(minutes.value) || 0) * 60 + (Number(seconds.value) || 0) + delta);
        minutes.value = String(Math.floor(total / 60));
        seconds.value = String(total % 60);
        minutes.dispatchEvent(new Event("input", { bubbles: true }));
        seconds.dispatchEvent(new Event("input", { bubbles: true }));
      });
    });
    document.querySelectorAll("[data-vet-range]").forEach((button) => {
      button.addEventListener("click", () => {
        state.vetRange = Number(button.dataset.vetRange) || 30;
        render();
      });
    });

    bindDoseButtons(document);

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
        if (severityInput) {
          severityInput.value = String(state.severity);
          severityInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
        document.querySelectorAll("[data-severity]").forEach((item) => {
          item.classList.remove("active"); item.setAttribute("aria-pressed", "false");
        });
        button.setAttribute("aria-pressed", "true");
        button.classList.add("active");
      });
    });

    const updateDuration = () => {
      const minutes = Number(document.querySelector("#duration-minutes")?.value || 0);
      const seconds = Number(document.querySelector("#duration-seconds")?.value || 0);
      const output = document.querySelector("#duration-output");
      if (output) output.textContent = formatDuration(minutes * 60 + seconds);
    };
    document.querySelectorAll(".duration-inputs input").forEach((input) => input.addEventListener("input", updateDuration));
    updateDuration();

    document.querySelectorAll(".time-input-shell input[type='time']").forEach((input) => {
      const display = input.closest(".time-input-shell")?.querySelector(".time-input-value");
      const updateDisplay = () => {
        if (display) display.textContent = formatTimeInputValue(input.value);
      };
      input.addEventListener("input", updateDisplay);
      input.addEventListener("change", updateDisplay);
      updateDisplay();
    });

    document.querySelectorAll(".date-input-shell input[type='date']").forEach((input) => {
      const display = input.closest(".date-input-shell")?.querySelector(".date-input-value");
      const updateDisplay = () => {
        if (display) display.textContent = formatDateInputValue(input.value);
      };
      input.addEventListener("input", updateDisplay);
      input.addEventListener("change", updateDisplay);
      updateDisplay();
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

    bindSaveForm("#seizure-form", saveSeizure);
    bindSaveForm("#note-form", saveNote);
    bindSaveForm("#handover-form", saveNote);
    bindSaveForm("#vet-form", saveVetVisit);
    bindSaveForm("#blood-test-form", saveBloodTest);
    document.querySelector("#vet-document-form")?.addEventListener("submit", uploadVetDocument);
    document.querySelector("#history-search-form")?.addEventListener("submit", searchHistory);
    bindSaveForm("#setup-form", saveSetup);
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

    if (state.seizurePrefill && state.overlay?.kind === "seizure") {
      // Keep the timed values as a draft so closing the review does not lose them.
      document.querySelector("#seizure-form")?.dispatchEvent(new Event("change", { bubbles: true }));
    }
    bindPullRefresh();
  }

  function bindDoseButtons(root) {
    root.querySelectorAll("[data-dose]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (state.saveBusy) return;
        state.saveBusy = true;
        button.disabled = true;
        try { await logDose(button.dataset.dose, button.dataset.status); }
        catch (error) { reportCloudSaveFailure(error); }
        finally { state.saveBusy = false; button.disabled = false; }
      });
    });

    root.querySelectorAll("[data-clear-dose]").forEach((button) => {
      button.addEventListener("click", () => removeEvent(button.dataset.clearDose, "Dose cleared."));
    });

    root.querySelector("#carer-name")?.addEventListener("input", (event) => {
      updateSettings({ carerName: event.target.value.trim().slice(0, 60) }).catch(() => {});
    });
  }

  function bindSaveForm(selector, handler) {
    const form = document.querySelector(selector);
    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (state.saveBusy) return;
      state.saveBusy = true;
      state.savingFormId = form.getAttribute("id");
      const button = form.querySelector('[type="submit"]');
      if (button) button.disabled = true;
      try {
        // Keep the form reference across awaits; DOM Event.currentTarget is transient.
        const saving = handler({ preventDefault() {}, currentTarget: form });
        form.inert = true;
        form.setAttribute("aria-busy", "true");
        await saving;
      } catch (error) { reportCloudSaveFailure(error); }
      finally {
        state.saveBusy = false;
        state.savingFormId = "";
        if (button) button.disabled = false;
        form.inert = false;
        form.removeAttribute("aria-busy");
        document.querySelectorAll("form[inert]").forEach((item) => { item.inert = false; item.removeAttribute("aria-busy"); });
      }
    });
  }


  function openOverlay(kind, extra = {}) {
    // A sheet opened during another sheet's closing animation must not be closed by it.
    clearTimeout(state.overlayCloseTimer);
    state.overlay = { kind, ...extra };
    state.overlayFresh = true;
    state.timerConfirmDiscard = false;
    render();
  }

  function closeOverlay() {
    const finish = () => {
      state.overlay = null;
      state.seizurePrefill = null;
      state.editingSeizureId = "";
      state.editingRecordId = "";
      state.timerConfirmDiscard = false;
      render();
    };
    const panel = document.querySelector(".sheet, .focus");
    if (!panel || prefersReducedMotion()) {
      finish();
      return;
    }
    panel.classList.add("leaving");
    document.querySelector(".scrim")?.classList.add("leaving");
    clearTimeout(state.overlayCloseTimer);
    state.overlayCloseTimer = setTimeout(finish, 240);
  }

  function switchRoutine(routine) {
    if (!ROUTINES[routine] || state.overlay?.kind !== "routine" || state.overlay.routine === routine) return;
    state.overlay = { kind: "routine", routine };
    const sheet = document.querySelector(".routine-sheet");
    const body = sheet?.querySelector("#routine-body");
    if (!sheet || !body || prefersReducedMotion()) {
      render();
      return;
    }
    // Change the colour field in place so it dissolves from day to night instead of redrawing.
    const tone = ROUTINES[routine].tone;
    sheet.classList.remove("tone-yellow", "tone-berry");
    sheet.classList.add(`tone-${tone}`);
    sheet.querySelector(".layer-yellow").style.opacity = tone === "yellow" ? "1" : "0";
    sheet.querySelector(".layer-berry").style.opacity = tone === "berry" ? "1" : "0";
    sheet.querySelectorAll("[data-routine-switch]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.routineSwitch === routine));
    });
    body.classList.remove("unfold");
    body.innerHTML = renderRoutineBody(routine);
    void body.offsetWidth;
    body.classList.add("unfold");
    body.scrollTop = 0;
    bindDoseButtons(body);
  }

  function readTimer() {
    try {
      const saved = JSON.parse(localStorage.getItem(TIMER_STORAGE) || "null");
      if (!saved || !Number.isFinite(saved.start) || Date.now() - saved.start > 6 * 60 * 60 * 1000) return null;
      return { start: saved.start, symptoms: Array.isArray(saved.symptoms) ? saved.symptoms.filter((item) => SYMPTOMS.includes(item)) : [] };
    } catch {
      return null;
    }
  }

  function saveTimer() {
    try {
      if (state.timer) localStorage.setItem(TIMER_STORAGE, JSON.stringify(state.timer));
      else localStorage.removeItem(TIMER_STORAGE);
    } catch { /* The timer still runs for this session. */ }
  }

  async function requestWakeLock() {
    if (!state.timer || state.wakeLock || !navigator.wakeLock || document.visibilityState !== "visible") return;
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener?.("release", () => { state.wakeLock = null; });
    } catch {
      state.wakeLock = null;
    }
  }

  function releaseWakeLock() {
    try { state.wakeLock?.release(); } catch { /* Already released. */ }
    state.wakeLock = null;
  }

  function startTimer() {
    if (!state.timer) {
      state.timer = { start: Date.now(), symptoms: [] };
      saveTimer();
    }
    requestWakeLock();
    state.editingSeizureId = "";
    openOverlay("timer");
  }

  function endTimer() {
    if (!state.timer) return;
    const seconds = Math.max(1, Math.round((Date.now() - state.timer.start) / 1000));
    state.seizurePrefill = {
      occurredAt: new Date(state.timer.start).toISOString(),
      durationSeconds: seconds,
      symptoms: state.timer.symptoms.slice()
    };
    state.timer = null;
    saveTimer();
    releaseWakeLock();
    state.editingSeizureId = "";
    // The timed values replace an older unfinished new-seizure draft.
    drafts.clearFor("seizure-form");
    state.overlay = { kind: "seizure" };
    state.overlayFresh = false;
    render();
    document.querySelector(".seizure-focus .focus-in")?.classList.add("enter");
  }

  function discardTimer() {
    state.timer = null;
    saveTimer();
    releaseWakeLock();
    state.overlay = null;
    state.timerConfirmDiscard = false;
    render();
    showToast("Recording discarded.");
  }

  async function copyVisitSummary() {
    const text = visitSummaryText(visitSummaryData(state.vetRange));
    try {
      await navigator.clipboard.writeText(text);
      showToast("Summary copied.");
    } catch {
      const holder = document.querySelector("#summary-fallback");
      if (holder) {
        holder.innerHTML = `<textarea class="copy-fallback" readonly aria-label="Visit summary text">${escapeHtml(text)}</textarea>`;
        const area = holder.querySelector("textarea");
        area.focus();
        area.select();
      }
      showToast("Copying is not available here. The summary text is selected below.");
    }
  }

  function showChartTip(target) {
    const tip = document.querySelector("#chart-tip");
    if (!tip || !target.dataset.tip) return;
    const rect = target.getBoundingClientRect();
    tip.textContent = target.dataset.tip;
    tip.style.left = `${clamp(rect.left + rect.width / 2, 120, window.innerWidth - 120)}px`;
    tip.style.top = `${rect.top + Math.min(rect.height / 2, 14)}px`;
    tip.classList.add("show");
    // Charts with a guide move it to the point the label describes.
    const cross = target.ownerSVGElement?.querySelector(".cross");
    if (cross && target.dataset.x) {
      cross.querySelector("line").setAttribute("transform", `translate(${target.dataset.x} 0)`);
      cross.querySelector("circle").setAttribute("cx", target.dataset.x);
      cross.querySelector("circle").setAttribute("cy", target.dataset.y);
      cross.classList.add("on");
    }
  }

  function hideChartTip() {
    document.querySelector("#chart-tip")?.classList.remove("show");
    document.querySelectorAll(".chart .cross.on").forEach((cross) => cross.classList.remove("on"));
  }

  function renderPreservingContentScroll() {
    const restoreScroll = captureContentScroll();
    render();
    restoreScroll();
  }

  function captureContentScroll() {
    const content = document.querySelector(".content");
    const useWindowScroll = isIosBrowser();
    const scrollTop = useWindowScroll ? window.scrollY || 0 : content?.scrollTop || 0;
    const horizontalScrolls = [".month-chart", ".chips.filters"]
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

  function renderPullRefresh() {
    // An iPhone-style spinner sits behind the page: pulling down uncovers it, and it spins in a gap while refreshing.
    const petals = Array.from({ length: 8 }, (_, index) =>
      `<line x1="12" y1="2.5" x2="12" y2="7" transform="rotate(${index * 45} 12 12)" style="--i:${index}" />`
    ).join("");
    return `
      <div id="pull-refresh" class="pull-refresh${state.pullRefreshing ? " refreshing" : ""}" role="status">
        <svg viewBox="0 0 24 24" aria-hidden="true">${petals}</svg>
        <span class="sr-only">${state.pullRefreshing ? "Refreshing" : ""}</span>
      </div>
    `;
  }

  function setPullRefreshing(refreshing) {
    state.pullRefreshing = refreshing;
    document.querySelector(".screen")?.classList.toggle("refreshing", refreshing);
    const indicator = document.querySelector("#pull-refresh");
    if (!indicator) return;
    indicator.classList.toggle("refreshing", refreshing);
    indicator.querySelector(".sr-only").textContent = refreshing ? "Refreshing" : "";
  }

  function bindPullRefresh() {
    if (isIosBrowser()) return;

    const content = document.querySelector(".content");
    if (!content || content.__pullRefreshBound) return;
    content.__pullRefreshBound = true;

    let startY = 0;
    let pull = 0;
    let pulling = false;
    // render() replaces the spinner, so always use the current one.
    const indicator = () => document.querySelector("#pull-refresh");

    const resetPull = () => {
      pull = 0;
      indicator()?.style.setProperty("--pull", "0");
      indicator()?.classList.remove("visible", "ready");
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
        // Only the petals' opacity follows the finger; the page moves with iOS's own bounce.
        const spinner = indicator();
        if (!spinner) return;
        spinner.style.setProperty("--pull", Math.min(1, pull / 72).toFixed(3));
        spinner.classList.toggle("ready", pull > 72);
        spinner.classList.add("visible");
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
        setPullRefreshing(true);
        resetPull();
        try {
          // Keep the spinner up long enough to read as a refresh, even when the sync is instant.
          await Promise.all([refreshApp(), new Promise((resolve) => setTimeout(resolve, 700))]);
        } finally {
          setPullRefreshing(false);
        }
      },
      { passive: true }
    );
  }

  async function refreshApp(options = {}) {
    await safeHydrate();
    render();
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
  }

  async function handleAction(action) {
    if (action === "quick-note") openOverlay("note");
    if (action === "start-timer") startTimer();
    if (action === "end-timer") endTimer();
    if (action === "minimize-timer") {
      state.overlay = null;
      render();
    }
    if (action === "restore-timer") openOverlay("timer");
    if (action === "ask-discard-timer" || action === "keep-timer") {
      state.timerConfirmDiscard = action === "ask-discard-timer";
      render();
    }
    if (action === "discard-timer") discardTimer();
    if (action === "close-overlay") closeOverlay();
    if (action === "copy-summary") copyVisitSummary();
    if (action === "install-app") installApp();
    if (action === "enable-push") enablePushNotifications();
    if (action === "test-push") testPushNotification();
    if (action === "disable-push") disablePushNotifications();
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

  async function persistEventMutation(record, onQueued) {
    return persistCloudRecords({ storeName: "events", tableName: SUPABASE_TABLES.events, records: [record], onQueued });
  }

  function cloudSaveBlockMessage() {
    if (!hasSupabaseConfig()) return "Supabase is not configured yet.";
    if (!state.settings?.syncEnabled) return "Supabase sync is not enabled yet.";
    if (!hasStoredAccess()) return "Enter the household access code before saving Sawyer's records.";
    if (state.storageUnavailable) return "Device storage is unavailable. Your entry remains in the form; restore storage before saving.";
    return "Supabase is not ready yet.";
  }

  function canSaveCloudRecord() {
    if (hasSupabaseConfig() && state.settings?.syncEnabled && hasStoredAccess() && !state.storageUnavailable) return true;
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

    const carerName = String(document.querySelector("#carer-name")?.value || state.settings.carerName || "").trim().slice(0, 60);
    if (!carerName) {
      showToast("Enter your name in Recording as before confirming a dose.");
      document.querySelector("#carer-name")?.focus();
      return;
    }
    await updateSettings({ carerName });
    const restoreScroll = captureContentScroll();
    const existing = entry.log;
    const timestamp = nowIso();
    const event = {
      id: existing?.id || `dose:${doseKey}`,
      recordedBy: carerName,
      ...(existing ? { syncBaseUpdatedAt: SYNC.pending(existing) ? existing.syncBaseUpdatedAt : existing.serverUpdatedAt || existing.updatedAt } : {}),
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
      showSaveToast(`${entry.schedule.name} marked ${status}.`);
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
      if (state.editingSeizureId === id || state.editingRecordId === id) state.overlay = null;
      if (state.editingSeizureId === id) state.editingSeizureId = "";
      if (state.editingRecordId === id) state.editingRecordId = "";
      await hydrate();
      render();
      restoreScroll();
      showSaveToast(message);
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
    state.seizurePrefill = null;
    state.severity = existing.severity || 3;
    openOverlay("seizure");
  }

  function cancelSeizureEdit() {
    closeOverlay();
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
    openOverlay(record.type);
  }

  function cancelRecordEdit() {
    closeOverlay();
  }

  async function saveSeizure(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const existingId = String(form.get("id") || form.get("_entryId") || "").trim();
    const existing = existingId ? await dbGet("events", existingId) : null;
    const date = String(form.get("date") || localDateKey(new Date()));
    const timeKnown = form.get("timeKnown") === "on";
    const time = timeKnown ? String(form.get("time") || "12:00") : "12:00";
    const occurredAt = localTimeToDate(date, time);
    const durationSeconds = CORE.durationInSeconds(form.get("durationMinutes"), form.get("durationSeconds"));
    if (durationSeconds === null) { showToast("Enter whole minutes and seconds from 0 to 59."); return; }
    const timestamp = nowIso();

    const record = {
      id: existing?.id || existingId || uid(),
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
      record.syncBaseUpdatedAt = form.get("_baseUpdatedAt") || null;
      await persistEventMutation(record, () => drafts.clear(event.currentTarget));
      state.editingSeizureId = "";
      state.seizurePrefill = null;
      state.overlay = null;
      await hydrate();
      const savedRecord = state.events.find((item) => item.id === record.id) || record;
      const clusterDetected = isAutomaticCluster(savedRecord);
      state.activeTab = "today";
      // Show the updated streak from the top rather than where the page was left.
      state.renderedTab = "";
      render();
      showSaveToast(
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
    const existingId = String(form.get("id") || form.get("_entryId") || "").trim();
    const existing = existingId ? await dbGet("events", existingId) : null;
    const title = String(form.get("title") || "Care note").trim() || "Care note";
    const body = String(form.get("body") || "").trim();
    if (!body) return;
    const timestamp = nowIso();

    const record = {
      id: existing?.id || existingId || uid(),
      dogId: DOG_ID,
      type: "note",
      dayKey: existing?.dayKey || localDateKey(new Date()),
      occurredAt: existing?.occurredAt || timestamp,
      title,
      body,
      handover: form.get("handover") === "on",
      recordedBy: existing?.recordedBy || String(state.settings?.carerName || "").trim().slice(0, 60),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      syncStatus: "local"
    };

    try {
      record.syncBaseUpdatedAt = form.get("_baseUpdatedAt") || null;
      await persistEventMutation(record, () => drafts.clear(event.currentTarget));
      await hydrate();
      state.editingRecordId = "";
      state.overlay = null;
      render();
      showSaveToast(existing ? "Note updated." : record.handover ? "Handover posted." : "Note saved.");
    } catch (error) {
      reportCloudSaveFailure(error);
    }
  }

  async function saveVetVisit(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const existingId = String(form.get("id") || form.get("_entryId") || "").trim();
    const existing = existingId ? await dbGet("events", existingId) : null;
    const date = String(form.get("date") || toDateInputValue(new Date()));
    const time = String(form.get("time") || "12:00");
    const occurredAt = new Date(`${date}T${time}`);
    const timestamp = nowIso();

    const record = {
      id: existing?.id || existingId || uid(),
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
      record.syncBaseUpdatedAt = form.get("_baseUpdatedAt") || null;
      await persistEventMutation(record, () => drafts.clear(event.currentTarget));
      await hydrate();
      state.editingRecordId = "";
      state.overlay = null;
      render();
      showSaveToast(existing ? "Vet visit updated." : "Vet visit saved.");
    } catch (error) {
      reportCloudSaveFailure(error);
    }
  }

  async function saveBloodTest(event) {
    event.preventDefault();
    if (!canSaveCloudRecord()) return;
    const form = new FormData(event.currentTarget);
    const existingId = String(form.get("id") || form.get("_entryId") || "").trim();
    const existing = existingId ? await dbGet("events", existingId) : null;
    const date = String(form.get("date") || toDateInputValue(new Date()));
    const time = String(form.get("time") || "12:00");
    const occurredAt = new Date(`${date}T${time}`);
    const timestamp = nowIso();
    const phenobarbital = readLabLevel(form, "phenobarbital");
    const bromide = readLabLevel(form, "bromide");

    const record = {
      id: existing?.id || existingId || uid(),
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
      record.syncBaseUpdatedAt = form.get("_baseUpdatedAt") || null;
      await persistEventMutation(record, () => drafts.clear(event.currentTarget));
      await hydrate();
      state.editingRecordId = "";
      state.overlay = null;
      render();
      showSaveToast(existing ? "Blood test updated." : "Blood test saved.");
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
    let bases = {};
    try { bases = JSON.parse(form.get("_baseUpdatedAt") || "{}"); } catch { /* Old drafts have no base. */ }

    const updatedProfile = {
      ...state.profile,
      name: dogName,
      doseConfirmationMode: form.get("confirmDoses") === "on" ? "explicit" : "assumed",
      emergencyPlan: String(form.get("emergencyPlan") || "").trim().slice(0, 300),
      emergencyPlanMinutes: clamp(Math.round(Number(form.get("emergencyPlanMinutes")) || 5), 1, 30),
      syncBaseUpdatedAt: bases[state.profile.id] || null,
      updatedAt: timestamp,
      syncStatus: "local"
    };

    const updatedSchedules = state.schedules.map((schedule) => ({
      ...schedule,
      syncBaseUpdatedAt: bases[schedule.id] || null,
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
      const savedSchedules = await persistCloudRecords({
        storeName: "schedules",
        tableName: SUPABASE_TABLES.schedules,
        records: updatedSchedules
      });
      if (regimenChanges.length) {
        await persistCloudRecords({
          storeName: "events",
          tableName: SUPABASE_TABLES.events,
          records: regimenChanges.map((record) => ({ ...record,
            syncParent: { id: record.scheduleId, mutationId: savedSchedules.find((schedule) => schedule?.id === record.scheduleId)?.syncMutationId }
          }))
        });
      }
      drafts.clear(event.currentTarget);
      await hydrate();
      render();
      showSaveToast("Setup saved.");
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
    if (state.saveBusy) { showToast("Wait for the current save to finish."); return; }
    if (state.pendingRecords.length) { showToast("Sync or resolve local changes before changing households."); return; }
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
    if (state.saveBusy) { showToast("Wait for the current save to finish."); return; }
    if (state.pendingRecords.length) { showToast("Sync or resolve the saved changes before removing household access."); return; }
    const pushSubscription = await existingPushSubscription();
    const removePush = Boolean(pushSubscription || state.settings?.pushNotificationsEnabled);
    if (!confirm(`Remove household access from this device? Shared records stay in Supabase, but this device's copy and any unfinished drafts are deleted.${removePush ? " Seizure-free push alerts on this device are turned off." : ""}`)) {
      return;
    }
    if (removePush) {
      // Unsubscribe while the access hash can still authorise the request.
      let serverRemoved = true;
      try {
        await invokePushSubscriptionAction("unsubscribe");
      } catch (error) {
        serverRemoved = false;
        if (!confirm(`Supabase could not remove this device's push alerts (${error.message || "request failed"}). Remove household access anyway? This device stops receiving alerts, and Supabase disables its entry at the next delivery attempt.`)) {
          return;
        }
      }
      const browserRemoved = pushSubscription ? await pushSubscription.unsubscribe().catch(() => false) : true;
      if (!serverRemoved && !browserRemoved) {
        showToast("Push alerts could not be turned off, so household access was kept.");
        return;
      }
    }
    try {
      const client = state.supabaseClient || (await initSupabase());
      if (client) await client.auth.signOut();
      // Shared records stay in Supabase. Queued with saves and syncs so none can write this device's copy back.
      await recordWork(async () => {
        writeHouseholdAccessHash("");
        drafts.clearAll();
        await dbClear("events");
        await dbClear("schedules");
        await dbClear("profile");
      });
      state.supabaseSession = null;
      state.vetDocuments = [];
      await updateSettings({
        currentUserEmail: "",
        pendingLoginEmail: "",
        emergencyLocalMode: false,
        pushNotificationsEnabled: false,
        lastSyncAt: null,
        lastSyncMessage: "Household access removed from this device."
      });
      await hydrate();
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
      syncWithSupabase({ silent: true }).catch(() => {}).finally(() => {
        safeHydrate().then(() => renderPreservingContentScroll());
      });
    }, 1500);
  }

  async function syncWithSupabase(options = {}) {
    return state.syncFlight.run(() => recordWork(() => runSupabaseSync(options)));
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

      const uploaded = dogResult.uploaded + scheduleResult.uploaded + eventResult.uploaded;
      const downloaded = dogResult.downloaded + scheduleResult.downloaded + eventResult.downloaded;

      await hydrate();
      const conflicts = state.pendingRecords.filter(({ record }) => record.syncStatus === "conflict").length;
      const message = conflicts ? `${conflicts} shared change${conflicts === 1 ? "" : "s"} need review in More.`
        : state.pendingRecords.length ? `${state.pendingRecords.length} change${state.pendingRecords.length === 1 ? "" : "s"} waiting to sync.`
          : `Synced ${uploaded} up and ${downloaded} down.`;

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

  async function persistCloudRecords({ storeName, tableName, records, onQueued }) {
    return recordWork(async () => {
      if (state.storageUnavailable) throw new Error("Device storage is unavailable. The entry has not been saved.");
      const householdId = state.settings.supabaseHouseholdId;
      const queued = [];
      for (const record of records) {
        const previous = await dbGet(storeName, record.id);
        queued.push(SYNC.enqueue(record, previous, householdId, uid()));
      }
      await dbBulkPut(storeName, queued);
      onQueued?.();
      state.lastSaveStatus = "pending";
      if (navigator.onLine) {
        try {
          const client = await requireSupabaseSession();
          await syncStore({ client, householdId, storeName, tableName, localRecords: await dbGetAll(storeName) });
        } catch (error) {
          state.syncMessage = error.message || "Waiting for the cloud connection.";
        }
      }
      const saved = await Promise.all(queued.map((record) => dbGet(storeName, record.id)));
      state.lastSaveStatus = saved.some((record) => record?.syncStatus === "conflict") ? "conflict"
        : saved.some((record) => SYNC.pending(record || {})) ? "pending" : "synced";
      return saved;
    });
  }

  function showSaveToast(message) {
    const status = state.pendingRecords.some(({ record }) => record.syncStatus === "conflict") ? "conflict"
      : state.pendingRecords.length ? "pending" : state.lastSaveStatus;
    showToast(status === "conflict" ? "Saved on this device. Review conflicting changes in More."
      : status === "pending" ? `${message} Saved on this device. Waiting to sync.` : message);
  }

  function reportCloudSaveFailure(error) {
    const detail = error?.message || "Supabase did not confirm this change.";
    state.syncMessage = `Not saved: ${detail}`;
    showToast(state.syncMessage);
  }

  async function syncStore({ client, householdId, storeName, tableName, localRecords }) {
    const remoteRows = await fetchAllRemoteRows(client, householdId, tableName);
    const remoteMap = new Map(remoteRows.map((row) => [row.id, row]));
    let uploaded = 0;
    let downloaded = 0;
    for (const original of localRecords) {
      let record = original;
      const remote = remoteMap.get(record.id);
      if (record.syncStatus === "conflict") continue;
      if (!SYNC.pending(record) && !remote && record.syncStatus === "local") {
        record = SYNC.enqueue(record, null, householdId, uid());
        await dbPut(storeName, record);
      }
      if (record.syncStatus === "pending") {
        if (record.syncParent) {
          const parent = await dbGet("schedules", record.syncParent.id);
          if (!parent || SYNC.pending(parent)) continue;
          if (parent.syncMutationId !== record.syncParent.mutationId) {
            await dbDelete(storeName, record.id);
            continue; // The schedule change was discarded during conflict review.
          }
        }
        try {
          const result = await SYNC.upload(client, tableName, householdId, record);
          if (result.id !== record.id) await dbDelete(storeName, record.id);
          await dbPut(storeName, result);
          if (result.syncStatus === "synced") uploaded += 1;
          remoteMap.delete(record.id);
          remoteMap.delete(result.id);
        } catch (error) {
          await dbPut(storeName, { ...record, syncError: error.message || "Cloud connection failed." });
          throw error;
        }
      } else if (remote) {
        await dbPut(storeName, SYNC.fromRemote(remote));
        remoteMap.delete(record.id);
        downloaded += 1;
      }
    }
    for (const row of remoteMap.values()) {
      const local = await dbGet(storeName, row.id);
      if (local && SYNC.pending(local)) continue;
      await dbPut(storeName, SYNC.fromRemote(row));
      downloaded += 1;
    }
    return { uploaded, downloaded };
  }

  async function fetchAllRemoteRows(client, householdId, tableName) {
    return CORE.fetchAllRemoteRows(client, householdId, tableName, SYNC_PAGE_SIZE);
  }

  async function installApp() {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice.catch(() => null);
    state.installPrompt = null;
    render();
  }

  function isPushSupported() {
    return Boolean(
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  }

  async function enablePushNotifications() {
    if (!isPushSupported()) {
      showToast("Push notifications are not supported on this device.");
      return;
    }
    if (isIosBrowser()) {
      showToast("Add Sawyer Tracker to the Home Screen, then enable push alerts from the installed app.");
      return;
    }
    if (!canSaveCloudRecord()) return;

    const vapidPublicKey = String(externalConfig.vapidPublicKey || "").trim();
    if (!vapidPublicKey) {
      showToast("Push notifications are not configured yet.");
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        await updateSettings({ pushNotificationsEnabled: false });
        render();
        showToast("Notification permission was not granted.");
        return;
      }

      const registration =
        state.pushRegistration ||
        (await navigator.serviceWorker.ready);
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
        });
      }

      await invokePushSubscriptionAction("subscribe", {
        subscription: subscription.toJSON(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Brisbane"
      });
      await updateSettings({ pushNotificationsEnabled: true });
      render();
      showToast("Seizure-free push alerts enabled.");
    } catch (error) {
      await updateSettings({ pushNotificationsEnabled: false }).catch(() => {});
      render();
      showToast(error.message || "Push alerts could not be enabled.");
    }
  }

  async function disablePushNotifications() {
    if (!isPushSupported()) {
      await updateSettings({ pushNotificationsEnabled: false });
      render();
      return;
    }
    if (!canSaveCloudRecord()) return;

    try {
      await invokePushSubscriptionAction("unsubscribe");
      const registration =
        state.pushRegistration ||
        (await navigator.serviceWorker.ready);
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
      await updateSettings({ pushNotificationsEnabled: false });
      render();
      showToast("Seizure-free push alerts disabled.");
    } catch (error) {
      showToast(error.message || "Push alerts could not be disabled.");
    }
  }

  async function existingPushSubscription() {
    if (!isPushSupported()) return null;
    try {
      // getRegistration resolves immediately; serviceWorker.ready never settles without a worker.
      const registration = state.pushRegistration || (await navigator.serviceWorker.getRegistration());
      return (await registration?.pushManager.getSubscription()) || null;
    } catch {
      return null;
    }
  }

  async function testPushNotification() {
    if (!canSaveCloudRecord()) return;
    try {
      await invokePushSubscriptionAction("test");
      showToast("Test push sent.");
    } catch (error) {
      showToast(error.message || "The test push could not be sent.");
    }
  }

  async function reconcilePushSubscription(options = {}) {
    if (
      !isPushSupported() ||
      Notification.permission !== "granted" ||
      !state.settings?.pushNotificationsEnabled ||
      !hasSupabaseConfig() ||
      !hasStoredAccess() ||
      !navigator.onLine
    ) {
      return;
    }

    try {
      const registration =
        state.pushRegistration ||
        (await navigator.serviceWorker.ready);
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        await updateSettings({ pushNotificationsEnabled: false });
        return;
      }
      await invokePushSubscriptionAction("subscribe", {
        subscription: subscription.toJSON(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Brisbane"
      });
    } catch (error) {
      if (!options.silent) showToast(error.message || "Push subscription could not be refreshed.");
    }
  }

  async function invokePushSubscriptionAction(action, payload = {}) {
    const client = state.supabaseClient || (await initSupabase());
    if (!client) throw new Error("Supabase is not available.");
    const { data, error } = await client.functions.invoke("sawyer-push-subscriptions", {
      headers: state.householdAccessHash ? { [ACCESS_HEADER]: state.householdAccessHash } : {},
      body: {
        action,
        householdId: state.settings.supabaseHouseholdId,
        deviceId: pushDeviceId(),
        ...payload
      }
    });
    if (error) {
      let message = error.message || "Push notification request failed.";
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

  function pushDeviceId() {
    try {
      let deviceId = localStorage.getItem(PUSH_DEVICE_STORAGE) || "";
      if (!deviceId) {
        deviceId = crypto.randomUUID?.() || uid();
        localStorage.setItem(PUSH_DEVICE_STORAGE, deviceId);
      }
      return deviceId;
    } catch {
      return uid();
    }
  }

  function urlBase64ToUint8Array(value) {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  }

  function getTodayDoseEntries(date = new Date()) {
    const dayKey = localDateKey(date);
    return state.schedules
      .filter((schedule) => schedule.active)
      .flatMap((schedule) =>
        schedule.times.map((time) => {
          const dueAt = localTimeToDate(dayKey, time.time);
          const key = `${dayKey}:${schedule.id}:${time.id}`;
          const matches = state.events.filter((event) => event.type === "dose" && event.doseKey === key);
          const log = matches.find(SYNC.pending) || matches.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
          const status = log?.status || (state.profile?.doseConfirmationMode === "explicit" ? "unconfirmed" : "assumed");
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
                  : status === "unconfirmed" ? "Unconfirmed" : "Assumed";
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
    const averageGap = gaps.length ? mean(gaps.map((gap) => gap.days)) : null;
    const completedLongestGap = episodeGaps.length ? Math.max(...episodeGaps.map((gap) => gap.days)) : null;
    const currentStreakDays = elapsedSinceLastMs === null ? null : elapsedSinceLastMs / DAY_MS;
    const longestGap = currentStreakDays === null
      ? completedLongestGap
      : Math.max(completedLongestGap ?? 0, currentStreakDays);
    const longestGapIsCurrent = currentStreakDays !== null && (
      completedLongestGap === null || currentStreakDays >= completedLongestGap
    );
    const homeAverageGap = episodeGaps.length ? mean(episodeGaps.map((gap) => gap.days)) : null;
    const averageDuration = durations.length ? mean(durations) : null;
    const longestGapText = longestGap !== null ? `${round1(longestGap)} days` : "--";

    return {
      totalSeizures: seizures.length,
      daysSinceLast,
      elapsedSinceLastMs,
      lastSeizureText: last ? `Last seizure: ${formatEventDateTime(last)}` : "No seizure logged yet",
      averageGapText: averageGap ? `${round1(averageGap)} days` : "--",
      longestGapText,
      longestGapIsCurrent,
      homeAverageGapText: homeAverageGap ? `${round1(homeAverageGap)} days` : "--",
      homeLongestGapText: longestGapText,
      homeLongestGapIsCurrent: longestGapIsCurrent,
      completedLongestGap,
      currentStreakDays,
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
    const episodeGaps = CORE.seizureEpisodeGaps(seizures, CLUSTER_WINDOW_MS);
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

    if (episodeGaps.length && summary.currentStreakDays !== null) {
      const completedAverage = mean(episodeGaps.map((gap) => gap.days));
      const completedLongest = summary.completedLongestGap;
      const currentInterval = summary.currentStreakDays;
      if (currentInterval > completedLongest) {
        insights.push({
          title: "Longest current interval",
          body: `${round1(currentInterval)} days have passed since the last logged seizure episode. That is ${round1(currentInterval - completedLongest)} days beyond Sawyer's longest completed gap in this record.`
        });
      } else if (Math.abs(currentInterval - completedAverage) >= 1) {
        const difference = Math.abs(currentInterval - completedAverage);
        insights.push({
          title: "Current interval",
          body: `${round1(currentInterval)} days have passed since the last logged seizure episode, ${round1(difference)} days ${currentInterval >= completedAverage ? "longer" : "shorter"} than the historical average gap of ${round1(completedAverage)} days.`
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
        averageSeverity: severityValues.length ? mean(severityValues) : null,
        averageSeverityText: severityValues.length ? round1(mean(severityValues)).toString() : "--",
        averageDurationText: durationValues.length ? formatDuration(Math.round(mean(durationValues))) : "--",
        clusterCount: monthSeizures.filter((event) => isAutomaticCluster(event)).length,
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
      return `<p class="subtle">${escapeHtml([event.label, dose, due, event.recordedBy ? `Recorded by ${event.recordedBy}` : ""].filter(Boolean).join(" · "))}</p>`;
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
      if (state.pendingRecords.length) throw new Error("Sync or resolve local changes before downloading a complete cloud backup.");

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
    if (state.pendingRecords.length) throw new Error("Sync or resolve local changes before restoring a backup.");
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
      "recorded_by",
      "sync_status",
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
        event.recordedBy || "",
        event.syncStatus || "",
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
    if (state.saveBusy) { showToast("Wait for the current save to finish."); return; }
    if (state.pendingRecords.length) { showToast("Sync or resolve the saved changes before clearing this device."); return; }
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
    let text = String(value ?? "");
    // Spreadsheet apps evaluate cells starting with these characters as formulas; plain numbers are left alone.
    if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
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
    toast.classList.remove("steady");
    state.toastTimer = setTimeout(() => document.querySelector("#toast")?.classList.remove("show", "steady"), 2600);
  }
})();
