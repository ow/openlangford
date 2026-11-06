import type { Route } from "./+types/api.bylaws.$id.download";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { PUBLIC_SIGNED_LINK } from "../lib/cache-policy";

export async function loader({ params }: Route.LoaderArgs) {
  const { id } = params;

  if (!id) {
    throw new Response("Bylaw ID is required", { status: 400 });
  }

  // 1. Get Bylaw Info
  const supabase = getSupabaseAdminClient();
  const { data: bylaw, error } = await supabase
    .from("bylaws")
    .select("title, file_path, source_url")
    .eq("id", id)
    .single();

  if (error || !bylaw) {
    throw new Response("Bylaw not found", { status: 404 });
  }

  // 2. The municipality's own copy is the official one: send people there.
  if (bylaw.source_url) {
    return new Response(null, {
      status: 302,
      headers: { Location: bylaw.source_url },
    });
  }

  if (!bylaw.file_path) {
    throw new Response("Bylaw file path is missing", { status: 404 });
  }

  // 3. Try to serve from Supabase Storage
  const { data: storageData } = await supabase.storage
    .from("bylaws")
    .createSignedUrl(bylaw.file_path, 3600);

  if (storageData?.signedUrl) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: storageData.signedUrl,
        "Cache-Control": PUBLIC_SIGNED_LINK,
      },
    });
  }

  // 4. Fallback: document not available for download in this environment
  throw new Response(
    "Document download is not available. The bylaw document has not been uploaded to cloud storage yet.",
    { status: 404 },
  );
}
