import { createClient } from "npm:@supabase/supabase-js@2.110.0";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, x-sawyer-access-key, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ message: "Method not allowed." }, 405);
  if (req.headers.get("apikey") !== readPublishableKey()) {
    return json({ message: "Invalid application key." }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    const householdId = String(body.householdId || "").trim();
    const deviceId = String(body.deviceId || "").trim();
    if (!isUuid(householdId) || deviceId.length < 8 || deviceId.length > 128) {
      return json({ message: "Invalid household or device." }, 400);
    }

    const authorized = await verifyHouseholdAccess(req, householdId);
    if (!authorized) return json({ message: "Household access was not authorized." }, 403);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, readSecretKey(), {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    if (action === "subscribe") {
      const subscription = normalizeSubscription(body.subscription);
      if (!subscription) return json({ message: "Invalid push subscription." }, 400);
      const timezone = validTimezone(String(body.timezone || "")) || "Australia/Brisbane";

      const { error: staleError } = await admin
        .from("sawyer_push_subscriptions")
        .delete()
        .eq("household_id", householdId)
        .eq("endpoint", subscription.endpoint)
        .neq("device_id", deviceId);
      if (staleError) throw staleError;

      const { error } = await admin
        .from("sawyer_push_subscriptions")
        .upsert(
          {
            household_id: householdId,
            device_id: deviceId,
            endpoint: subscription.endpoint,
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
            timezone,
            user_agent: String(req.headers.get("user-agent") || "").slice(0, 500),
            enabled: true,
            failure_count: 0,
            updated_at: new Date().toISOString()
          },
          { onConflict: "household_id,device_id" }
        );
      if (error) throw error;
      return json({ enabled: true });
    }

    if (action === "unsubscribe") {
      const { error } = await admin
        .from("sawyer_push_subscriptions")
        .delete()
        .eq("household_id", householdId)
        .eq("device_id", deviceId);
      if (error) throw error;
      return json({ enabled: false });
    }

    if (action === "status") {
      const { data, error } = await admin
        .from("sawyer_push_subscriptions")
        .select("enabled")
        .eq("household_id", householdId)
        .eq("device_id", deviceId)
        .maybeSingle();
      if (error) throw error;
      return json({ enabled: Boolean(data?.enabled) });
    }

    if (action === "test") {
      const { data: subscription, error } = await admin
        .from("sawyer_push_subscriptions")
        .select("id,endpoint,p256dh,auth")
        .eq("household_id", householdId)
        .eq("device_id", deviceId)
        .eq("enabled", true)
        .maybeSingle();
      if (error) throw error;
      if (!subscription) return json({ message: "Enable push alerts on this device first." }, 404);

      webpush.setVapidDetails(
        Deno.env.get("VAPID_SUBJECT") || "mailto:sawyer-tracker@localhost.invalid",
        Deno.env.get("VAPID_PUBLIC_KEY") || "",
        Deno.env.get("VAPID_PRIVATE_KEY") || ""
      );
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth }
          },
          JSON.stringify({
            title: "Sawyer push alerts are working",
            body: "This device will receive seizure-free heart and streak alerts.",
            icon: "./assets/icons/icon-192.png",
            badge: "./assets/icons/favicon-64.png",
            tag: "sawyer-push-test",
            eventKey: "sawyer-push-test",
            kind: "test",
            url: "./?tab=today"
          }),
          { TTL: 60, urgency: "normal" }
        );
      } catch (pushError) {
        const statusCode = Number((pushError as { statusCode?: number })?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          await admin
            .from("sawyer_push_subscriptions")
            .update({ enabled: false, updated_at: new Date().toISOString() })
            .eq("id", subscription.id);
        }
        throw pushError;
      }
      return json({ delivered: true });
    }

    return json({ message: "Unknown push action." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Push subscription request failed.";
    return json({ message }, 500);
  }
});

async function verifyHouseholdAccess(req: Request, householdId: string) {
  const authorization = req.headers.get("authorization") || "";
  const accessKey = req.headers.get("x-sawyer-access-key") || "";
  if (!authorization && !accessKey) return false;

  const client = createClient(Deno.env.get("SUPABASE_URL")!, readPublishableKey(), {
    global: {
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(accessKey ? { "x-sawyer-access-key": accessKey } : {})
      }
    },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data, error } = await client
    .from("sawyer_households")
    .select("id")
    .eq("id", householdId)
    .maybeSingle();
  return !error && Boolean(data);
}

function normalizeSubscription(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = String(source.endpoint || "");
  const p256dh = String(source.keys?.p256dh || "");
  const auth = String(source.keys?.auth || "");
  if (!endpoint.startsWith("https://") || endpoint.length > 2048) return null;
  if (!p256dh || p256dh.length > 512 || !auth || auth.length > 512) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function validTimezone(value: string) {
  if (!value || value.length > 80) return "";
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: value }).format();
    return value;
  } catch {
    return "";
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readPublishableKey() {
  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (keys) return JSON.parse(keys).default;
  return Deno.env.get("SUPABASE_ANON_KEY")!;
}

function readSecretKey() {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) return JSON.parse(keys).default;
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
