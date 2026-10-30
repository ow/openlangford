import { data, type ActionFunctionArgs } from "react-router";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getConfiguredVideoProviderId, getVideoProvider } from "../services/video/index.server";
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
    const { data: meeting, error } = await supabaseAdmin
      .from("meetings")
      .select("video_url")
      .eq("id", meetingId)
      .maybeSingle();
    if (error) throw error;
    if (!meeting) {
      return data({ error: "Meeting not found" }, { status: 404 });
    }

    // Each provider clears its own cache (Vimeo: the URLs cached in meetings.meta, atomically).
    const configured = await getConfiguredVideoProviderId(supabaseAdmin);
    const provider = getVideoProvider(meeting.video_url, configured);
    if (provider) {
      const found = await provider.invalidate(meetingId, meeting.video_url);
      if (!found) return data({ error: "Meeting not found" }, { status: 404 });
    }

    console.log(`[Video Failure] Invalidated ${provider?.id ?? "no"} video cache for meeting ${meetingId}`);
    return data({ success: true });
  } catch (error) {
    console.error("[Video Failure] Error:", error);
    return data({ error: "Internal server error" }, { status: 500 });
  }
}
