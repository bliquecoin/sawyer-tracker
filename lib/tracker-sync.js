(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SawyerTrackerSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const COLUMNS = "id,dog_id,payload,updated_at,deleted_at";
  const LOCAL_FIELDS = ["serverUpdatedAt", "syncBaseUpdatedAt", "syncConflict", "syncError", "syncHouseholdId", "syncParent"];

  function fromRemote(row) {
    const record = { ...row.payload };
    LOCAL_FIELDS.forEach((key) => delete record[key]);
    return {
      ...record, id: row.id, dogId: row.dog_id,
      updatedAt: row.updated_at, serverUpdatedAt: row.updated_at,
      deletedAt: row.deleted_at || null, syncStatus: "synced"
    };
  }

  function toRemote(householdId, record) {
    const payload = { ...record, syncStatus: "synced" };
    LOCAL_FIELDS.forEach((key) => delete payload[key]);
    return {
      household_id: householdId, id: record.id, dog_id: record.dogId || "sawyer",
      payload, updated_at: record.updatedAt, deleted_at: record.deletedAt || null
    };
  }

  function pending(record) {
    return record.syncStatus === "pending" || record.syncStatus === "conflict";
  }

  function enqueue(record, previous, householdId, mutationId) {
    // Preserve the version the user actually edited, including across offline edits.
    const base = Object.hasOwn(record, "syncBaseUpdatedAt")
      ? record.syncBaseUpdatedAt
      : pending(previous || {}) ? previous.syncBaseUpdatedAt
        : previous?.serverUpdatedAt || (previous?.syncStatus === "synced" ? previous.updatedAt : null);
    return {
      ...record, syncBaseUpdatedAt: base || null, syncMutationId: mutationId,
      syncHouseholdId: householdId, syncStatus: "pending", syncConflict: null, syncError: ""
    };
  }

  function nextTimestamp(base, now = Date.now()) {
    // A new version must differ even for two writes in the same millisecond.
    return new Date(Math.max(now, (Date.parse(base) || 0) + 1)).toISOString();
  }

  async function readRemote(client, table, householdId, record) {
    let query = client.from(table).select(COLUMNS).eq("household_id", householdId);
    // Finds pre-existing dose IDs from older releases as well as the canonical ID.
    query = record.type === "dose" && record.doseKey
      ? query.eq("payload->>doseKey", record.doseKey).order("updated_at", { ascending: false })
      : query.eq("id", record.id);
    const { data, error } = await query.limit(1);
    if (error) throw error;
    return data?.[0] || null;
  }

  function conflict(record, remote) {
    return { ...record, syncStatus: "conflict", syncConflict: remote, syncError: "Another phone changed this record. Review both versions." };
  }

  async function upload(client, table, householdId, record) {
    if (record.syncHouseholdId && record.syncHouseholdId !== householdId) {
      throw new Error("This unsynced record belongs to a different household.");
    }
    const remote = await readRemote(client, table, householdId, record);
    if (remote?.payload?.syncMutationId === record.syncMutationId && record.syncMutationId) {
      return fromRemote(remote); // The server saved it but the prior response was lost.
    }
    if (remote && remote.updated_at !== record.syncBaseUpdatedAt) return conflict(record, remote);
    if (!remote && record.syncBaseUpdatedAt) return conflict(record, null);
    const row = toRemote(householdId, {
      ...record, id: remote?.id || record.id,
      updatedAt: nextTimestamp(remote?.updated_at, Date.parse(record.updatedAt) || Date.now())
    });
    const query = remote
      ? client.from(table).update(row).eq("household_id", householdId).eq("id", remote.id).eq("updated_at", record.syncBaseUpdatedAt)
      : client.from(table).insert(row);
    const { data, error } = await query.select(COLUMNS);
    if (error && error.code !== "23505") throw error;
    if (!error && data?.length === 1) return fromRemote(data[0]);
    // The conditional update or unique primary key caught a concurrent save.
    const latest = await readRemote(client, table, householdId, record);
    if (latest?.payload?.syncMutationId === record.syncMutationId) return fromRemote(latest);
    return conflict(record, latest);
  }

  function createSerialQueue() {
    let tail = Promise.resolve();
    return (work) => {
      const run = () => typeof navigator !== "undefined" && navigator.locks
        ? navigator.locks.request("sawyer-record-sync", work) : work();
      const result = tail.then(run, run);
      tail = result.catch(() => {});
      return result;
    };
  }

  return { fromRemote, toRemote, pending, enqueue, nextTimestamp, upload, createSerialQueue };
});
