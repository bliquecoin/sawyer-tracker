import { createClient } from "npm:@supabase/supabase-js@2.110.0";

const BUCKET = "sawyer-vet-documents";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const CATEGORIES = new Set(["visit_summary", "lab_results", "prescription", "imaging", "insurance", "other"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, x-sawyer-access-key, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ message: "Method not allowed." }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "").trim();
    const householdId = String(body.householdId || "").trim();
    if (!isUuid(householdId)) return json({ message: "Invalid household." }, 400);

    await requireHouseholdAccess(req, householdId);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, readSecretKey(), {
      auth: { persistSession: false }
    });

    if (action === "create-upload" || action === "create-restore-upload") {
      const fileName = cleanFileName(body.fileName);
      const sizeBytes = Number(body.sizeBytes || 0);
      if (!fileName.toLowerCase().endsWith(".pdf")) {
        return json({ message: "Choose a PDF document." }, 400);
      }
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_FILE_BYTES) {
        return json({ message: "PDFs must be 20 MB or smaller." }, 400);
      }

      const restoring = action === "create-restore-upload";
      const documentId = restoring ? String(body.documentId || "").trim() : crypto.randomUUID();
      if (restoring && !isUuid(documentId)) {
        return json({ message: "Invalid restore document." }, 400);
      }
      const storagePath = `${householdId}/${documentId}/${documentId}.pdf`;
      const { data, error } = await admin.storage
        .from(BUCKET)
        .createSignedUploadUrl(storagePath, { upsert: restoring });
      if (error) throw error;

      return json({
        documentId,
        storagePath,
        token: data.token
      });
    }

    if (action === "finalize-upload" || action === "finalize-restore") {
      const restoring = action === "finalize-restore";
      const documentId = String(body.documentId || "").trim();
      const storagePath = String(body.storagePath || "").trim();
      const expectedPath = `${householdId}/${documentId}/${documentId}.pdf`;
      if (!isUuid(documentId) || storagePath !== expectedPath) {
        return json({ message: "Invalid document upload." }, 400);
      }

      const folder = `${householdId}/${documentId}`;
      const objectName = `${documentId}.pdf`;
      const { data: objects, error: listError } = await admin.storage
        .from(BUCKET)
        .list(folder, { limit: 10, search: objectName });
      if (listError) throw listError;
      const storedObject = (objects || []).find((item) => item.name === objectName);
      if (!storedObject) return json({ message: "The uploaded PDF could not be verified." }, 400);

      const category = CATEGORIES.has(String(body.category || "")) ? String(body.category) : "other";
      const documentDate = isDate(body.documentDate) ? String(body.documentDate) : null;
      const fileName = cleanFileName(body.fileName);
      const sizeBytes = Math.min(
        Number(storedObject.metadata?.size || body.sizeBytes || 0),
        MAX_FILE_BYTES
      );
      const notes = String(body.notes || "").trim().slice(0, 2000);
      const timestamp = new Date().toISOString();
      const createdAt =
        restoring && isTimestamp(body.createdAt) ? String(body.createdAt) : timestamp;

      const { data, error } = await admin
        .from("sawyer_vet_documents")
        .upsert(
          {
            household_id: householdId,
            id: documentId,
            dog_id: "sawyer",
            storage_path: storagePath,
            file_name: fileName,
            content_type: "application/pdf",
            size_bytes: sizeBytes,
            category,
            document_date: documentDate,
            notes,
            created_at: createdAt,
            updated_at: timestamp
          },
          { onConflict: "household_id,id" }
        )
        .select("*")
        .single();
      if (error) throw error;
      return json({ document: data });
    }

    if (action === "abort-upload") {
      const documentId = String(body.documentId || "").trim();
      const storagePath = String(body.storagePath || "").trim();
      const expectedPath = `${householdId}/${documentId}/${documentId}.pdf`;
      if (isUuid(documentId) && storagePath === expectedPath) {
        await admin.storage.from(BUCKET).remove([storagePath]);
      }
      return json({ deleted: true });
    }

    if (action === "create-view-url") {
      const document = await findDocument(admin, householdId, body.documentId);
      const { data, error } = await admin.storage
        .from(BUCKET)
        .createSignedUrl(document.storage_path, 300);
      if (error) throw error;
      return json({ url: data.signedUrl });
    }

    if (action === "delete") {
      const document = await findDocument(admin, householdId, body.documentId);
      const { error: storageError } = await admin.storage
        .from(BUCKET)
        .remove([document.storage_path]);
      if (storageError) throw storageError;

      const { error: deleteError } = await admin
        .from("sawyer_vet_documents")
        .delete()
        .eq("household_id", householdId)
        .eq("id", document.id);
      if (deleteError) throw deleteError;
      return json({ deleted: true });
    }

    return json({ message: "Unknown document action." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Document request failed.";
    const status = /access|authorized|permission/i.test(message) ? 403 : 500;
    return json({ message }, status);
  }
});

async function requireHouseholdAccess(req: Request, householdId: string) {
  const authorization = req.headers.get("authorization") || "";
  const accessKey = req.headers.get("x-sawyer-access-key") || "";
  if (!authorization.startsWith("Bearer ") && !accessKey) {
    throw new Error("Household access is required.");
  }

  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    readPublishableKey(),
    {
      global: {
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(accessKey ? { "x-sawyer-access-key": accessKey } : {})
        }
      },
      auth: { persistSession: false }
    }
  );
  const { data, error } = await client
    .from("sawyer_households")
    .select("id")
    .eq("id", householdId)
    .maybeSingle();
  if (error || !data) throw new Error("Household access was not authorized.");
}

async function findDocument(
  admin: ReturnType<typeof createClient>,
  householdId: string,
  documentId: unknown
) {
  const id = String(documentId || "").trim();
  if (!isUuid(id)) throw new Error("Invalid document.");
  const { data, error } = await admin
    .from("sawyer_vet_documents")
    .select("id,storage_path,file_name")
    .eq("household_id", householdId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Document not found.");
  return data;
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

function cleanFileName(value: unknown) {
  const name = String(value || "Vet document.pdf")
    .replace(/[\\/\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return name || "Vet document.pdf";
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDate(value: unknown) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function isTimestamp(value: unknown) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
