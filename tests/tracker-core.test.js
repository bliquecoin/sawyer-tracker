const test = require("node:test");
const assert = require("node:assert/strict");
const { strFromU8, strToU8, unzipSync, zipSync } = require("fflate");
const core = require("../lib/tracker-core.js");

test("chunk creates bounded upload groups", () => {
  const values = Array.from({ length: 405 }, (_, index) => index);
  assert.deepEqual(core.chunk(values, 200).map((items) => items.length), [200, 200, 5]);
  assert.throws(() => core.chunk(values, 0), /positive/);
});

test("single flight shares concurrent work and permits a later run", async () => {
  const flight = core.createSingleFlight();
  let calls = 0;
  const first = flight.run(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return "done";
  });
  const second = flight.run(() => {
    calls += 1;
    return "unexpected";
  });
  assert.equal(first, second);
  assert.equal(await second, "done");
  assert.equal(calls, 1);
  assert.equal(await flight.run(() => "again"), "again");
});

test("paginated reads request deterministic inclusive ranges", async () => {
  const source = Array.from({ length: 1205 }, (_, index) => ({ id: String(index).padStart(4, "0") }));
  const ranges = [];
  const client = {
    from() {
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        order() {
          return query;
        },
        range(from, to) {
          ranges.push([from, to]);
          return Promise.resolve({ data: source.slice(from, to + 1), error: null });
        }
      };
      return query;
    }
  };

  const rows = await core.fetchAllRemoteRows(client, "household", "events", 500);
  assert.equal(rows.length, 1205);
  assert.deepEqual(ranges, [[0, 499], [500, 999], [1000, 1499]]);
});

test("sync plan prefers newer rows without overwriting newer cloud data", () => {
  const local = [
    { id: "a", updatedAt: "2026-01-03T00:00:00Z" },
    { id: "b", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "c", updatedAt: "2026-01-02T00:00:00Z" }
  ];
  const remote = [
    { id: "a", payload: { id: "a", updatedAt: "2026-01-01T00:00:00Z" } },
    { id: "b", payload: { id: "b", updatedAt: "2026-01-04T00:00:00Z" } },
    { id: "d", payload: { id: "d", updatedAt: "2026-01-02T00:00:00Z" } }
  ];
  const plan = core.buildSyncPlan(local, remote, {
    toLocal: (row) => row.payload,
    isNewer: (a, b) => new Date(a.updatedAt) > new Date(b.updatedAt),
    preferRemote: () => false
  });
  assert.deepEqual(plan.downloads.map((row) => row.id), ["b", "d"]);
  assert.deepEqual(plan.uploads.map((row) => row.id), ["a", "c"]);
});

test("cluster logic handles known and unknown seizure times conservatively", () => {
  const seizures = [
    { id: "a", type: "seizure", occurredAt: "2026-01-01T01:00:00Z", dayKey: "2026-01-01", timeKnown: true },
    { id: "b", type: "seizure", occurredAt: "2026-01-01T23:00:00Z", dayKey: "2026-01-01", timeKnown: true },
    { id: "c", type: "seizure", occurredAt: "2026-01-04T12:00:00Z", dayKey: "2026-01-04", timeKnown: false },
    { id: "d", type: "seizure", occurredAt: "2026-01-04T12:00:00Z", dayKey: "2026-01-04", timeKnown: false },
    { id: "deleted", type: "seizure", occurredAt: "2026-01-01T02:00:00Z", deletedAt: "2026-01-02T00:00:00Z" }
  ];
  assert.deepEqual([...core.automaticClusterIds(seizures)].sort(), ["a", "b", "c", "d"]);
  assert.equal(
    core.seizuresShareClusterWindow(
      { occurredAt: "2026-01-01T00:00:00Z", timeKnown: true },
      { occurredAt: "2026-01-02T00:00:00Z", timeKnown: true }
    ),
    false
  );
});

test("local date keys do not shift to UTC", () => {
  assert.equal(core.localDateKey(new Date(2026, 6, 6, 23, 59)), "2026-07-06");
});

test("MCT metrics require a known effective date and compare both sides", () => {
  const gaps = [
    { from: { occurredAt: "2026-01-01" }, to: { occurredAt: "2026-01-11" }, days: 10 },
    { from: { occurredAt: "2026-01-11" }, to: { occurredAt: "2026-01-21" }, days: 10 },
    { from: { occurredAt: "2026-02-10" }, to: { occurredAt: "2026-03-02" }, days: 20 }
  ];
  const metrics = core.mctInsightMetrics(
    [],
    [{ id: "supp-mct-c8-c10", effectiveFrom: "2026-02-01" }],
    gaps
  );
  assert.equal(metrics.beforeAverage, 10);
  assert.equal(metrics.afterAverage, 20);
  assert.equal(core.mctInsightMetrics([], [{ id: "supp-mct-c8-c10" }], gaps), null);
});

test("medication insight counts only known-time seizures after missed or late doses", () => {
  const events = [
    {
      id: "missed",
      type: "dose",
      status: "missed",
      dueAt: "2026-07-01T07:00:00Z",
      occurredAt: "2026-07-01T07:00:00Z"
    },
    {
      id: "late",
      type: "dose",
      status: "given",
      dueAt: "2026-07-03T07:00:00Z",
      occurredAt: "2026-07-03T08:00:00Z"
    },
    {
      id: "on-time",
      type: "dose",
      status: "given",
      dueAt: "2026-07-05T07:00:00Z",
      occurredAt: "2026-07-05T07:10:00Z"
    }
  ];
  const seizures = [
    { id: "after-missed", occurredAt: "2026-07-01T12:00:00Z", timeKnown: true },
    { id: "after-late", occurredAt: "2026-07-03T12:00:00Z", timeKnown: true },
    { id: "unknown-time", occurredAt: "2026-07-01T12:00:00Z", timeKnown: false },
    { id: "after-on-time", occurredAt: "2026-07-05T12:00:00Z", timeKnown: true }
  ];
  assert.equal(core.countSeizuresNearDoseException(events, seizures, 45), 2);
});

test("backup validation rejects mismatched households, counts and files", () => {
  const archive = { "data.json": new Uint8Array([1]) };
  const manifest = {
    app: "sawyer-tracker",
    formatVersion: 2,
    householdId: "home",
    counts: { dogs: 1, schedules: 0, events: 1, documents: 0 },
    files: [{ path: "data.json" }]
  };
  const data = {
    app: "sawyer-tracker",
    version: 2,
    householdId: "home",
    tables: { dogs: [{ id: "sawyer" }], schedules: [], events: [{ id: "event" }], documents: [] }
  };
  assert.equal(core.validateBackupEnvelope(manifest, data, archive, "home").events.length, 1);
  assert.throws(() => core.validateBackupEnvelope(manifest, data, archive, "other"), /different household/);
  assert.throws(
    () => core.validateBackupEnvelope({ ...manifest, counts: { ...manifest.counts, events: 2 } }, data, archive, "home"),
    /counts/
  );
  assert.throws(
    () => core.validateBackupEnvelope({ ...manifest, files: [{ path: "missing.pdf" }] }, data, archive, "home"),
    /missing/
  );
});

test("backup data survives a ZIP round trip with tombstones and document bytes", () => {
  const data = {
    app: "sawyer-tracker",
    version: 2,
    householdId: "home",
    tables: {
      dogs: [{ id: "sawyer" }],
      schedules: [{ id: "epibrom" }],
      events: [{ id: "deleted-event", deleted_at: "2026-07-06T00:00:00Z" }],
      documents: [{ id: "vet-pdf", archivePath: "documents/vet-pdf.pdf" }]
    }
  };
  const files = {
    "data.json": strToU8(JSON.stringify(data)),
    "documents/vet-pdf.pdf": new Uint8Array([37, 80, 68, 70])
  };
  const manifest = {
    app: "sawyer-tracker",
    formatVersion: 2,
    householdId: "home",
    counts: { dogs: 1, schedules: 1, events: 1, documents: 1 },
    files: Object.keys(files).map((path) => ({ path }))
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest));

  const archive = unzipSync(zipSync(files));
  const unpackedManifest = JSON.parse(strFromU8(archive["manifest.json"]));
  const unpackedData = JSON.parse(strFromU8(archive["data.json"]));
  const tables = core.validateBackupEnvelope(unpackedManifest, unpackedData, archive, "home");

  assert.equal(tables.events[0].deleted_at, "2026-07-06T00:00:00Z");
  assert.deepEqual(Array.from(archive["documents/vet-pdf.pdf"]), [37, 80, 68, 70]);
});
