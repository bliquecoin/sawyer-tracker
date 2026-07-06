(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SawyerTrackerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function chunk(values, size) {
    if (!Number.isInteger(size) || size <= 0) throw new Error("Chunk size must be positive.");
    const chunks = [];
    for (let index = 0; index < values.length; index += size) {
      chunks.push(values.slice(index, index + size));
    }
    return chunks;
  }

  function createSingleFlight() {
    let current = null;
    return {
      run(factory) {
        if (current) return current;
        current = Promise.resolve()
          .then(factory)
          .finally(() => {
            current = null;
          });
        return current;
      },
      isRunning() {
        return Boolean(current);
      }
    };
  }

  async function fetchAllRemoteRows(client, householdId, tableName, pageSize = 500) {
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await client
        .from(tableName)
        .select("id,dog_id,payload,updated_at,deleted_at")
        .eq("household_id", householdId)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }

  function buildSyncPlan(localRecords, remoteRows, options) {
    const localMap = new Map(localRecords.filter(Boolean).map((record) => [record.id, record]));
    const remoteMap = new Map(remoteRows.map((row) => [row.id, row]));
    const downloads = [];
    const uploads = [];

    remoteRows.forEach((row) => {
      const local = localMap.get(row.id);
      const remote = options.toLocal(row);
      if (!local || options.isNewer(remote, local) || options.preferRemote(local, remote)) {
        downloads.push(remote);
      }
    });

    localRecords.filter(Boolean).forEach((local) => {
      const remoteRow = remoteMap.get(local.id);
      if (!remoteRow) {
        uploads.push(local);
        return;
      }
      const remote = options.toLocal(remoteRow);
      if (!options.preferRemote(local, remote) && options.isNewer(local, remote)) {
        uploads.push(local);
      }
    });

    return { downloads, uploads };
  }

  function localDateKey(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function eventDayKey(event) {
    if (event.dayKey) return event.dayKey;
    return localDateKey(new Date(event.occurredAt));
  }

  function seizuresShareClusterWindow(first, second, windowMs = 24 * 60 * 60 * 1000) {
    if (first.timeKnown === false || second.timeKnown === false) {
      return eventDayKey(first) === eventDayKey(second);
    }
    return Math.abs(new Date(second.occurredAt).getTime() - new Date(first.occurredAt).getTime()) < windowMs;
  }

  function automaticClusterIds(seizures, windowMs = 24 * 60 * 60 * 1000) {
    const ids = new Set();
    const active = seizures
      .filter((event) => event.type === "seizure" && !event.deletedAt)
      .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));

    for (let firstIndex = 0; firstIndex < active.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < active.length; secondIndex += 1) {
        const first = active[firstIndex];
        const second = active[secondIndex];
        if (seizuresShareClusterWindow(first, second, windowMs)) {
          ids.add(first.id);
          ids.add(second.id);
        }
        if (
          first.timeKnown !== false &&
          second.timeKnown !== false &&
          new Date(second.occurredAt).getTime() - new Date(first.occurredAt).getTime() >= windowMs
        ) {
          break;
        }
      }
    }
    return ids;
  }

  function mctInsightMetrics(events, schedules, gaps) {
    const schedule = schedules.find((item) => item.id === "supp-mct-c8-c10");
    const knownDates = events
      .filter(
        (event) =>
          event.type === "regimen_change" &&
          event.scheduleId === "supp-mct-c8-c10" &&
          event.effectiveDateKnown &&
          event.effectiveFrom
      )
      .map((event) => event.effectiveFrom);
    if (schedule?.effectiveFrom) knownDates.push(schedule.effectiveFrom);
    const firstDate = knownDates.sort()[0];
    if (!firstDate || gaps.length < 3) return null;

    const firstTime = new Date(`${firstDate}T00:00:00`).getTime();
    const before = gaps.filter((gap) => new Date(gap.to.occurredAt).getTime() < firstTime).map((gap) => gap.days);
    const after = gaps.filter((gap) => new Date(gap.from.occurredAt).getTime() >= firstTime).map((gap) => gap.days);
    if (!before.length || !after.length) return null;
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    return { firstDate, beforeAverage: mean(before), afterAverage: mean(after) };
  }

  function countSeizuresNearDoseException(events, seizures, overdueMinutes = 45, windowMs = 86400000) {
    const doseEvents = events.filter((event) => event.type === "dose" && !event.deletedAt);
    return seizures
      .filter((seizure) => !seizure.deletedAt && seizure.timeKnown !== false)
      .reduce((total, seizure) => {
        const seizureTime = new Date(seizure.occurredAt).getTime();
        const nearby = doseEvents.some((dose) => {
          const dueAt = new Date(dose.dueAt || dose.occurredAt).getTime();
          const occurredAt = new Date(dose.occurredAt).getTime();
          const wasLate = dose.status === "given" && occurredAt - dueAt > overdueMinutes * 60000;
          const wasMissed = dose.status === "missed";
          return (wasLate || wasMissed) && seizureTime - dueAt >= 0 && seizureTime - dueAt <= windowMs;
        });
        return total + (nearby ? 1 : 0);
      }, 0);
  }

  function validateBackupEnvelope(manifest, data, archive, householdId) {
    if (
      manifest?.app !== "sawyer-tracker" ||
      manifest?.formatVersion !== 2 ||
      data?.app !== "sawyer-tracker" ||
      data?.version !== 2
    ) {
      throw new Error("This backup version is not supported.");
    }
    if (manifest.householdId !== householdId || data.householdId !== householdId) {
      throw new Error("This backup belongs to a different household.");
    }

    const tables = data.tables || {};
    const normalized = {
      dogs: Array.isArray(tables.dogs) ? tables.dogs : [],
      schedules: Array.isArray(tables.schedules) ? tables.schedules : [],
      events: Array.isArray(tables.events) ? tables.events : [],
      documents: Array.isArray(tables.documents) ? tables.documents : []
    };
    const counts = manifest.counts || {};
    if (
      counts.dogs !== normalized.dogs.length ||
      counts.schedules !== normalized.schedules.length ||
      counts.events !== normalized.events.length ||
      counts.documents !== normalized.documents.length
    ) {
      throw new Error("Backup record counts do not match the manifest.");
    }
    (manifest.files || []).forEach((entry) => {
      if (!entry.path || !archive[entry.path]) {
        throw new Error(`Backup file is missing: ${entry.path || "unknown"}`);
      }
    });
    return normalized;
  }

  return {
    automaticClusterIds,
    buildSyncPlan,
    chunk,
    countSeizuresNearDoseException,
    createSingleFlight,
    fetchAllRemoteRows,
    localDateKey,
    mctInsightMetrics,
    seizuresShareClusterWindow,
    validateBackupEnvelope
  };
});
