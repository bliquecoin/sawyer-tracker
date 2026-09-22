const test = require("node:test");
const assert = require("node:assert/strict");
const sync = require("../lib/tracker-sync.js");

function database(seed = []) {
  const rows = structuredClone(seed);
  let loseResponse = false;
  const client = {
    from() {
      const filters = [];
      let operation = "read", value;
      const query = {
        select() { return query; },
        eq(key, expected) { filters.push([key, expected]); return query; },
        order() { return query; },
        limit() { return query; },
        insert(row) { operation = "insert"; value = row; return query; },
        update(row) { operation = "update"; value = row; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            let result = rows.filter((row) => filters.every(([key, expected]) =>
              (key === "payload->>doseKey" ? row.payload.doseKey : row[key]) === expected));
            if (operation === "insert") {
              if (rows.some((row) => row.id === value.id && row.household_id === value.household_id)) {
                return { data: null, error: { code: "23505" } };
              }
              rows.push(structuredClone(value));
              result = [value];
            }
            if (operation === "update") {
              result.forEach((row) => Object.assign(row, structuredClone(value)));
            }
            if (operation !== "read" && loseResponse) {
              loseResponse = false;
              throw new Error("Connection lost after commit");
            }
            return { data: structuredClone(result), error: null };
          }).then(resolve, reject);
        }
      };
      return query;
    }
  };
  return { client, rows, loseNextResponse() { loseResponse = true; } };
}

const base = { id: "note-1", type: "note", body: "Original", updatedAt: "2026-09-22T00:00:00.000Z", syncStatus: "synced" };
const edit = (record, mutation) => sync.enqueue({ ...record, body: mutation }, record, "household", mutation);

test("simultaneous edits keep one shared winner and preserve the other version for review", async () => {
  const db = database([sync.toRemote("household", base)]);
  const results = await Promise.all([
    sync.upload(db.client, "events", "household", edit(base, "phone-a")),
    sync.upload(db.client, "events", "household", edit(base, "phone-b"))
  ]);
  assert.equal(results.filter((record) => record.syncStatus === "synced").length, 1);
  const conflict = results.find((record) => record.syncStatus === "conflict");
  assert.ok(conflict);
  assert.notEqual(conflict.body, db.rows[0].payload.body);
  assert.equal(conflict.syncConflict.payload.body, db.rows[0].payload.body);
});

test("simultaneous confirmations of the same dose cannot insert duplicate rows", async () => {
  const db = database();
  const dose = { id: "dose:2026-09-22:med:morning", type: "dose", doseKey: "2026-09-22:med:morning", status: "given", updatedAt: base.updatedAt };
  const results = await Promise.all(["a", "b"].map((id) => sync.upload(db.client, "events", "household", sync.enqueue(dose, null, "household", id))));
  assert.equal(db.rows.length, 1);
  assert.equal(results.filter((record) => record.syncStatus === "conflict").length, 1);
});

test("legacy dose IDs are discovered and do not produce a second confirmation", async () => {
  const db = database([sync.toRemote("household", { ...base, id: "old-random-id", type: "dose", doseKey: "today:med:am", status: "missed" })]);
  const pending = sync.enqueue({ ...base, id: "dose:today:med:am", type: "dose", doseKey: "today:med:am", status: "given" }, null, "household", "new");
  const result = await sync.upload(db.client, "events", "household", pending);
  assert.equal(result.syncStatus, "conflict");
  assert.equal(result.syncConflict.id, "old-random-id");
  assert.equal(db.rows.length, 1);
});

test("retry after a lost success response is idempotent", async () => {
  const db = database();
  const pending = sync.enqueue(base, null, "household", "once");
  db.loseNextResponse();
  await assert.rejects(sync.upload(db.client, "events", "household", pending), /Connection lost/);
  const result = await sync.upload(db.client, "events", "household", pending);
  assert.equal(result.syncStatus, "synced");
  assert.equal(db.rows.length, 1);
});

test("an offline edit retains its original version through subsequent edits", () => {
  const first = edit(base, "first");
  const second = sync.enqueue({ ...first, body: "second" }, first, "household", "second");
  assert.equal(second.syncBaseUpdatedAt, base.updatedAt);
  assert.equal(second.syncStatus, "pending");
  assert.equal(second.syncMutationId, "second");
});

test("a stale draft and stale deletion cannot overwrite newer shared data", async () => {
  const newer = { ...base, body: "Other phone", updatedAt: "2026-09-22T01:00:00.000Z" };
  const db = database([sync.toRemote("household", newer)]);
  for (const change of [{ body: "Old draft" }, { deletedAt: "2026-09-22T02:00:00.000Z" }]) {
    const pending = sync.enqueue({ ...newer, ...change, syncBaseUpdatedAt: base.updatedAt }, newer, "household", "stale");
    const result = await sync.upload(db.client, "events", "household", pending);
    assert.equal(result.syncStatus, "conflict");
    assert.equal(db.rows[0].payload.body, "Other phone");
    assert.equal(db.rows[0].deleted_at, null);
  }
});

test("queue retries do not cross household boundaries", async () => {
  const db = database();
  await assert.rejects(sync.upload(db.client, "events", "other-household", edit(base, "local")), /different household/);
  assert.equal(db.rows.length, 0);
});

test("versions advance despite a slow phone clock and local conflict metadata stays private", () => {
  assert.equal(sync.nextTimestamp(base.updatedAt, 0), "2026-09-22T00:00:00.001Z");
  const pending = { ...edit(base, "local"), syncConflict: { private: "snapshot" }, syncError: "failure" };
  const row = sync.toRemote("household", pending);
  assert.equal(row.payload.syncConflict, undefined);
  assert.equal(row.payload.syncBaseUpdatedAt, undefined);
  assert.equal(row.payload.syncError, undefined);
  assert.equal(sync.fromRemote(row).serverUpdatedAt, row.updated_at);
});
