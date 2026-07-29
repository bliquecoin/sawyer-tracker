import { createClient } from "npm:@supabase/supabase-js@2.110.0";
import webpush from "npm:web-push@3.6.7";
import { buildStreakNotificationCandidates } from "../_shared/streak-notifications.mjs";

type SubscriptionRow = {
  id: string;
  household_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  timezone: string;
  created_at: string;
  failure_count: number;
};

type Candidate = {
  eventKey: string;
  kind: "heart" | "longest_streak" | "average_gap";
  targetAt: string;
  title: string;
  body: string;
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ message: "Method not allowed." }, 405);
  if (req.headers.get("apikey") !== readPublishableKey()) {
    return json({ message: "Invalid application key." }, 401);
  }

  try {
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY") || "";
    if (!vapidPublicKey || !vapidPrivateKey) throw new Error("VAPID keys are not configured.");
    webpush.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT") || "mailto:sawyer-tracker@localhost.invalid",
      vapidPublicKey,
      vapidPrivateKey
    );

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, readSecretKey(), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data: subscriptions, error: subscriptionsError } = await admin
      .from("sawyer_push_subscriptions")
      .select("id,household_id,endpoint,p256dh,auth,timezone,created_at,failure_count")
      .eq("enabled", true);
    if (subscriptionsError) throw subscriptionsError;
    if (!subscriptions?.length) return json({ households: 0, candidates: 0, sent: 0 });

    const byHousehold = new Map<string, SubscriptionRow[]>();
    (subscriptions as SubscriptionRow[]).forEach((subscription) => {
      const rows = byHousehold.get(subscription.household_id) || [];
      rows.push(subscription);
      byHousehold.set(subscription.household_id, rows);
    });

    let candidateCount = 0;
    let sentCount = 0;
    let failedCount = 0;
    const now = new Date();

    for (const [householdId, householdSubscriptions] of byHousehold) {
      const [{ data: eventRows, error: eventError }, { data: dogRows }] = await Promise.all([
        admin
          .from("sawyer_care_events")
          .select("payload")
          .eq("household_id", householdId)
          .is("deleted_at", null),
        admin
          .from("sawyer_dogs")
          .select("payload")
          .eq("household_id", householdId)
          .is("deleted_at", null)
          .limit(1)
      ]);
      if (eventError) {
        console.error("Could not load notification events", { householdId, message: eventError.message });
        continue;
      }

      const events = (eventRows || []).map((row) => row.payload).filter(Boolean);
      const dogName = String((dogRows?.[0]?.payload as { name?: string } | undefined)?.name || "Sawyer");
      const timezone = householdSubscriptions[0]?.timezone || "Australia/Brisbane";
      const candidates = buildStreakNotificationCandidates(events, now, { dogName, timezone }) as Candidate[];
      candidateCount += candidates.length;

      for (const candidate of candidates) {
        for (const subscription of householdSubscriptions) {
          if (new Date(subscription.created_at).getTime() > new Date(candidate.targetAt).getTime()) continue;
          const claimed = await claimDelivery(admin, householdId, subscription, candidate);
          if (!claimed) continue;

          try {
            await webpush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth }
              },
              JSON.stringify({
                title: candidate.title,
                body: candidate.body,
                icon: "./assets/icons/icon-192.png",
                badge: "./assets/icons/favicon-64.png",
                tag: candidate.eventKey,
                eventKey: candidate.eventKey,
                kind: candidate.kind,
                url: "./?tab=today"
              }),
              { TTL: 24 * 60 * 60, urgency: "normal" }
            );
            sentCount += 1;
            await Promise.all([
              admin
                .from("sawyer_push_deliveries")
                .update({
                  status: "sent",
                  attempt_count: 1,
                  sent_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                })
                .eq("id", claimed.id),
              admin
                .from("sawyer_push_subscriptions")
                .update({
                  failure_count: 0,
                  last_success_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                })
                .eq("id", subscription.id)
            ]);
          } catch (error) {
            failedCount += 1;
            const message = error instanceof Error ? error.message : "Web Push delivery failed.";
            const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
            const expired = statusCode === 404 || statusCode === 410;
            await Promise.all([
              admin
                .from("sawyer_push_deliveries")
                .update({
                  status: "failed",
                  attempt_count: 1,
                  last_error: message.slice(0, 1000),
                  updated_at: new Date().toISOString()
                })
                .eq("id", claimed.id),
              admin
                .from("sawyer_push_subscriptions")
                .update({
                  enabled: expired ? false : true,
                  failure_count: Number(subscription.failure_count || 0) + 1,
                  last_failure_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                })
                .eq("id", subscription.id)
            ]);
            console.error("Push delivery failed", {
              subscriptionId: subscription.id,
              eventKey: candidate.eventKey,
              statusCode,
              message
            });
          }
        }
      }
    }

    return json({
      households: byHousehold.size,
      candidates: candidateCount,
      sent: sentCount,
      failed: failedCount
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Push dispatch failed.";
    console.error(message);
    return json({ message }, 500);
  }
});

async function claimDelivery(
  admin: ReturnType<typeof createClient>,
  householdId: string,
  subscription: SubscriptionRow,
  candidate: Candidate
) {
  const { data, error } = await admin
    .from("sawyer_push_deliveries")
    .insert({
      household_id: householdId,
      subscription_id: subscription.id,
      event_key: candidate.eventKey,
      kind: candidate.kind,
      target_at: candidate.targetAt,
      title: candidate.title,
      body: candidate.body,
      status: "pending"
    })
    .select("id")
    .maybeSingle();
  if (error?.code === "23505") return null;
  if (error) throw error;
  return data;
}

function readSecretKey() {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) return JSON.parse(keys).default;
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

function readPublishableKey() {
  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (keys) return JSON.parse(keys).default;
  return Deno.env.get("SUPABASE_ANON_KEY")!;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
