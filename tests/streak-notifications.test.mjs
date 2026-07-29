import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStreakNotificationCandidates,
  seizureEpisodeGaps
} from "../supabase/functions/_shared/streak-notifications.mjs";

function seizure(id, occurredAt, extra = {}) {
  return {
    id,
    type: "seizure",
    occurredAt,
    dayKey: occurredAt.slice(0, 10),
    createdAt: occurredAt,
    ...extra
  };
}

test("a new seizure-free heart is emitted every five days", () => {
  const events = [seizure("s1", "2026-01-01T00:00:00.000Z")];
  const candidates = buildStreakNotificationCandidates(
    events,
    "2026-01-11T00:01:00.000Z",
    { dogName: "Sawyer" }
  );

  assert.deepEqual(
    candidates.map((candidate) => ({ key: candidate.eventKey, kind: candidate.kind })),
    [{ key: "heart:s1:2", kind: "heart" }]
  );
  assert.match(candidates[0].body, /10 seizure-free days/);
});

test("clustered seizures form one episode before calculating gaps", () => {
  const events = [
    seizure("s1", "2026-01-01T00:00:00.000Z"),
    seizure("s2", "2026-01-01T12:00:00.000Z"),
    seizure("s3", "2026-01-06T12:00:00.000Z"),
    seizure("s4", "2026-01-16T12:00:00.000Z")
  ];

  assert.deepEqual(
    seizureEpisodeGaps(events).map((gap) => gap.days),
    [5, 10]
  );
});

test("average-gap alert requires at least two completed episode gaps", () => {
  const events = [
    seizure("s1", "2026-01-01T00:00:00.000Z"),
    seizure("s2", "2026-01-06T00:00:00.000Z"),
    seizure("s3", "2026-01-16T00:00:00.000Z")
  ];
  const candidates = buildStreakNotificationCandidates(
    events,
    "2026-01-23T12:01:00.000Z",
    { dogName: "Sawyer" }
  );

  const average = candidates.find((candidate) => candidate.kind === "average_gap");
  assert.equal(average?.eventKey, "average-gap:s3");
  assert.match(average?.body || "", /tracking cue, not a prediction/);
});

test("longest-streak alert is emitted when the current interval crosses the record", () => {
  const events = [
    seizure("s1", "2026-01-01T00:00:00.000Z"),
    seizure("s2", "2026-01-06T00:00:00.000Z"),
    seizure("s3", "2026-01-16T00:00:00.000Z")
  ];
  const candidates = buildStreakNotificationCandidates(
    events,
    "2026-01-26T00:01:00.000Z",
    { dogName: "Sawyer" }
  );

  const longest = candidates.find((candidate) => candidate.kind === "longest_streak");
  assert.equal(longest?.eventKey, "longest-streak:s3");
  assert.match(longest?.title || "", /matched his longest streak/);
});

test("old milestones are not returned after the delivery lookback", () => {
  const events = [seizure("s1", "2026-01-01T00:00:00.000Z")];
  const candidates = buildStreakNotificationCandidates(
    events,
    "2026-01-12T12:00:00.000Z",
    { lookbackMs: 24 * 60 * 60 * 1000 }
  );

  assert.equal(candidates.length, 0);
});
