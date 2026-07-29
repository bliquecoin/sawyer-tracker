const DAY_MS = 24 * 60 * 60 * 1000;
const HEART_DAYS = 5;
const CLUSTER_WINDOW_MS = DAY_MS;
const DEFAULT_LOOKBACK_MS = 36 * 60 * 60 * 1000;

export function buildStreakNotificationCandidates(events, now = new Date(), options = {}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return [];

  const lookbackMs = Number.isFinite(options.lookbackMs)
    ? Math.max(0, options.lookbackMs)
    : DEFAULT_LOOKBACK_MS;
  const timezone = options.timezone || "Australia/Brisbane";
  const dogName = String(options.dogName || "Sawyer").trim() || "Sawyer";
  const seizures = activeSeizures(events);
  const last = seizures.at(-1);
  if (!last) return [];

  const referenceMs = seizureCounterReferenceMs(last, timezone);
  if (!Number.isFinite(referenceMs) || nowMs < referenceMs) return [];

  const candidates = [];
  const elapsedDays = (nowMs - referenceMs) / DAY_MS;
  const heartCount = Math.floor(elapsedDays / HEART_DAYS);
  if (heartCount > 0) {
    const targetMs = referenceMs + heartCount * HEART_DAYS * DAY_MS;
    addIfCurrent(candidates, {
      eventKey: `heart:${last.id}:${heartCount}`,
      kind: "heart",
      targetAt: new Date(targetMs).toISOString(),
      title: `${dogName} earned a new heart`,
      body: `${heartCount * HEART_DAYS} seizure-free days — ${heartCount} heart${heartCount === 1 ? "" : "s"} earned.`
    }, nowMs, lookbackMs);
  }

  const gaps = seizureEpisodeGaps(seizures);
  if (gaps.length) {
    const longestDays = Math.max(...gaps.map((gap) => gap.days));
    const longestTargetMs = referenceMs + longestDays * DAY_MS;
    addIfCurrent(candidates, {
      eventKey: `longest-streak:${last.id}`,
      kind: "longest_streak",
      targetAt: new Date(longestTargetMs).toISOString(),
      title: `${dogName} matched his longest streak`,
      body: `${dogName} has reached ${formatDays(longestDays)} days since his last seizure episode.`
    }, nowMs, lookbackMs);
  }

  if (gaps.length >= 2) {
    const averageDays = mean(gaps.map((gap) => gap.days));
    const averageTargetMs = referenceMs + averageDays * DAY_MS;
    addIfCurrent(candidates, {
      eventKey: `average-gap:${last.id}`,
      kind: "average_gap",
      targetAt: new Date(averageTargetMs).toISOString(),
      title: `${dogName} reached his average gap`,
      body: `${dogName} has reached his historical average of ${formatDays(averageDays)} days. This is a tracking cue, not a prediction; consider watching him a little more closely.`
    }, nowMs, lookbackMs);
  }

  return candidates.sort((a, b) => new Date(a.targetAt) - new Date(b.targetAt));
}

export function seizureEpisodeGaps(events) {
  const seizures = activeSeizures(events);
  const episodes = [];

  seizures.forEach((seizure) => {
    const currentEpisode = episodes.at(-1);
    const previous = currentEpisode?.at(-1);
    if (previous && seizuresShareClusterWindow(previous, seizure)) {
      currentEpisode.push(seizure);
    } else {
      episodes.push([seizure]);
    }
  });

  const gaps = [];
  for (let index = 1; index < episodes.length; index += 1) {
    const from = episodes[index - 1].at(-1);
    const to = episodes[index][0];
    gaps.push({
      from,
      to,
      days: (new Date(to.occurredAt).getTime() - new Date(from.occurredAt).getTime()) / DAY_MS
    });
  }
  return gaps.filter((gap) => Number.isFinite(gap.days) && gap.days >= 0);
}

function activeSeizures(events) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => event?.type === "seizure" && !event.deletedAt)
    .filter((event) => event.id && Number.isFinite(new Date(event.occurredAt).getTime()))
    .sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
}

function seizuresShareClusterWindow(first, second) {
  if (first.timeKnown === false || second.timeKnown === false) {
    return eventDayKey(first) === eventDayKey(second);
  }
  return Math.abs(new Date(second.occurredAt) - new Date(first.occurredAt)) < CLUSTER_WINDOW_MS;
}

function seizureCounterReferenceMs(event, timezone) {
  const occurredAt = new Date(event.occurredAt).getTime();
  if (event.timeKnown !== false) return occurredAt;

  const createdAt = new Date(event.createdAt).getTime();
  if (
    Number.isFinite(createdAt) &&
    eventDayKey(event) === dateKeyInTimezone(new Date(createdAt), timezone)
  ) {
    return createdAt;
  }
  return occurredAt;
}

function eventDayKey(event) {
  return String(event.dayKey || event.occurredAt || "").slice(0, 10);
}

function dateKeyInTimezone(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function addIfCurrent(candidates, candidate, nowMs, lookbackMs) {
  const targetMs = new Date(candidate.targetAt).getTime();
  if (targetMs <= nowMs && targetMs >= nowMs - lookbackMs) candidates.push(candidate);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatDays(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}`;
}
