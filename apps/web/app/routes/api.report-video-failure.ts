import { data, type ActionFunctionArgs } from "react-router";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { clearVimeoCache } from "../services/vimeo.server";
import { isRateLimited, tooManyRequests } from "../lib/rate-limit.server";

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return data({ error: "Method not allowed" }, { status: 405 });
  }

  // Anonymous by design (viewers report broken video), so throttle per IP.
  if (await isRateLimited(request, "video-failure", 5, context as any)) return tooManyRequests();

  const formData = await request.formData();
  const rawId = formData.get("meetingId");

  if (!rawId) {
    return data({ error: "Missing meetingId" }, { status: 400 });
  }
  if (typeof rawId !== "string" || !/^[1-9][0-9]{0,9}$/.test(rawId)) {
    return data({ error: "Invalid meetingId" }, { status: 400 });
  }
  const meetingId = Number(rawId);
  const supabaseAdmin = getSupabaseAdminClient();

  try {
    // One atomic UPDATE (jsonb merge) so concurrent meta writes from the pipeline aren't lost.
    const { data: rows, error: rpcError } = await supabaseAdmin.rpc("invalidate_meeting_vimeo_cache", {
      p_meeting_id: meetingId,
    });
    if (rpcError) throw rpcError;
    const meeting = (rows as { video_url: string | null }[] | null)?.[0];
    if (!meeting) {
      return data({ error: "Meeting not found" }, { status: 404 });
    }

    // Clear this isolate's in-memory cache too.
    if (meeting.video_url) {
      clearVimeoCache(meeting.video_url);
    }

    console.log(`[Video Failure] Invalidated cache for meeting ${meetingId}`);
    return data({ success: true });
  } catch (error) {
    console.error("[Video Failure] Error:", error);
    return data({ error: "Internal server error" }, { status: 500 });
  }
}
