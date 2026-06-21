import { createClient } from "npm:@supabase/supabase-js@2";

type CareEvent = {
  id?: string;
  type?: string;
  occurredAt?: string;
  dayKey?: string;
  severity?: number;
  durationSeconds?: number;
  trigger?: string;
  symptoms?: string[];
  status?: string;
  medicationName?: string;
  scheduleId?: string;
  panel?: string;
  phenobarbitalLevel?: string;
  bromideLevel?: string;
  reason?: string;
  plan?: string;
  notes?: string;
  body?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ message: "Method not allowed" }, 405);

  try {
    const authorization = req.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) {
      return json({ message: "Sign in before running AI review." }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const householdId = String(body.householdId || "").trim();
    const dogName = String(body.dogName || "Sawyer").trim() || "Sawyer";
    if (!householdId) return json({ message: "Missing household id." }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      readPublishableKey(),
      { global: { headers: { authorization } } }
    );

    const [{ data: eventRows, error: eventError }, { data: dogRows }] = await Promise.all([
      supabase
        .from("sawyer_care_events")
        .select("id,payload,updated_at,deleted_at")
        .eq("household_id", householdId)
        .is("deleted_at", null),
      supabase
        .from("sawyer_dogs")
        .select("id,payload,updated_at,deleted_at")
        .eq("household_id", householdId)
        .is("deleted_at", null)
    ]);
    if (eventError) throw eventError;

    const events = (eventRows || [])
      .map((row) => row.payload as CareEvent)
      .filter(Boolean)
      .sort((a, b) => new Date(a.occurredAt || 0).getTime() - new Date(b.occurredAt || 0).getTime());
    const profileName = String((dogRows?.[0]?.payload as { name?: string } | undefined)?.name || dogName);
    const fallback = buildRuleBasedReview(profileName, events);

    const provider = Deno.env.get("AI_PROVIDER") || (Deno.env.get("OPENAI_API_KEY") ? "openai" : Deno.env.get("ANTHROPIC_API_KEY") ? "anthropic" : "rules");
    if (provider === "openai" && Deno.env.get("OPENAI_API_KEY")) {
      const ai = await callOpenAi(profileName, events, fallback);
      return json({ ...ai, provider: "openai" });
    }
    if (provider === "anthropic" && Deno.env.get("ANTHROPIC_API_KEY")) {
      const ai = await callAnthropic(profileName, events, fallback);
      return json({ ...ai, provider: "anthropic" });
    }

    return json({ ...fallback, provider: "rules" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI review failed.";
    return json({ message }, 500);
  }
});

function readPublishableKey() {
  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (keys) return JSON.parse(keys).default;
  return Deno.env.get("SUPABASE_ANON_KEY")!;
}

function buildRuleBasedReview(dogName: string, events: CareEvent[]) {
  const seizures = events.filter((event) => event.type === "seizure");
  const missedDoses = events.filter((event) => event.type === "dose" && event.status === "missed");
  const bloodTests = events.filter((event) => event.type === "blood_test");
  const vetVisits = events.filter((event) => event.type === "vet_visit");
  const lastSeizure = seizures.at(-1);
  const lastBlood = bloodTests.at(-1);
  const gaps = seizureGaps(seizures);
  const averageGap = gaps.length ? mean(gaps) : null;
  const recentGap = gaps.at(-1) || null;

  const bullets = [
    {
      title: "Tracking baseline",
      detail: seizures.length
        ? `${seizures.length} seizure record${seizures.length === 1 ? "" : "s"} are synced for ${dogName}.`
        : `No seizure records are synced for ${dogName} yet.`
    },
    recentGap && averageGap
      ? {
          title: "Spacing trend",
          detail: `The latest logged gap was ${round1(recentGap)} days, compared with an average of ${round1(averageGap)} days across logged gaps.`
        }
      : null,
    missedDoses.length
      ? {
          title: "Dose exceptions",
          detail: `${missedDoses.length} missed dose exception${missedDoses.length === 1 ? "" : "s"} are recorded.`
        }
      : {
          title: "Dose exceptions",
          detail: "No missed dose exceptions are recorded in the synced data."
        },
    lastBlood
      ? {
          title: "Latest blood test",
          detail: [lastBlood.panel || "Blood test", lastBlood.phenobarbitalLevel ? `phenobarbital ${lastBlood.phenobarbitalLevel}` : "", lastBlood.bromideLevel ? `bromide ${lastBlood.bromideLevel}` : ""].filter(Boolean).join(" · ")
        }
      : null,
    vetVisits.length
      ? {
          title: "Vet context",
          detail: `${vetVisits.length} vet visit${vetVisits.length === 1 ? "" : "s"} are available for review.`
        }
      : null
  ].filter(Boolean);

  return {
    title: `${dogName} AI review`,
    summary: lastSeizure
      ? `Last synced seizure was ${formatDate(lastSeizure.occurredAt)}. These are tracking observations only.`
      : "No synced seizure has been logged yet. These are tracking observations only.",
    bullets,
    questions: [
      "Are Sawyer's current medication blood levels in the target range for him?",
      "Should any pattern in seizure timing change the next monitoring plan?",
      "Are there warning signs that should trigger an urgent vet call?"
    ]
  };
}

async function callOpenAi(dogName: string, events: CareEvent[], fallback: ReturnType<typeof buildRuleBasedReview>) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_MODEL") || "gpt-5.4-mini",
      input: insightPrompt(dogName, events),
      max_output_tokens: 1200
    })
  });
  if (!response.ok) return fallback;
  const data = await response.json();
  return parseAiJson(data.output_text) || fallback;
}

async function callAnthropic(dogName: string, events: CareEvent[], fallback: ReturnType<typeof buildRuleBasedReview>) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") || "",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5",
      max_tokens: 1200,
      messages: [{ role: "user", content: insightPrompt(dogName, events) }]
    })
  });
  if (!response.ok) return fallback;
  const data = await response.json();
  const text = (data.content || []).map((part: { text?: string }) => part.text || "").join("\n");
  return parseAiJson(text) || fallback;
}

function insightPrompt(dogName: string, events: CareEvent[]) {
  const recentEvents = events.slice(-160);
  return `
You review a dog seizure tracker for ${dogName}. Return strict JSON only:
{
  "title": "short title",
  "summary": "one concise paragraph",
  "bullets": [{"title": "short label", "detail": "specific observation"}],
  "questions": ["vet-facing question"]
}

Rules:
- Do not diagnose, prescribe, or claim causation.
- Use cautious words like "logged", "may be worth asking", and "in the available records".
- Focus on seizure spacing, missed-dose exceptions, medication/supplement context, vet visits, and blood-test levels.
- Keep it concise and practical for a vet conversation.

Synced events JSON:
${JSON.stringify(recentEvents)}
`;
}

function parseAiJson(text: string | undefined) {
  if (!text) return null;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      title: String(parsed.title || "AI review"),
      summary: String(parsed.summary || ""),
      bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 6) : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions.slice(0, 6) : []
    };
  } catch {
    return null;
  }
}

function seizureGaps(seizures: CareEvent[]) {
  const gaps: number[] = [];
  for (let index = 1; index < seizures.length; index += 1) {
    const previous = new Date(seizures[index - 1].occurredAt || 0).getTime();
    const current = new Date(seizures[index].occurredAt || 0).getTime();
    if (previous && current) gaps.push((current - previous) / 86400000);
  }
  return gaps;
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function formatDate(value?: string) {
  if (!value) return "an unknown date";
  return new Date(value).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
