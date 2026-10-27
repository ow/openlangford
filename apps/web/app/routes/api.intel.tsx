import type { Route } from "./+types/api.intel";
import { requireAdmin } from "../lib/auth.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getAiClient } from "../services/ai/index.server";
import {
  AGENDA_INTELLIGENCE_SCHEMA_NAME,
  AGENDA_INTELLIGENCE_SYSTEM,
  AgendaItemIntelligenceSchema,
  buildAgendaIntelligencePrompt,
} from "../services/ai/agenda-intelligence";

export async function action({ params, request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Spends AI budget and overwrites agenda_items.meta, so admin-only (signup is open).
  // Return JSON instead of a login redirect: callers are fetchers.
  try {
    await requireAdmin(request);
  } catch (error) {
    if (error instanceof Response) {
      const forbidden = error.status === 403;
      return Response.json(
        { error: forbidden ? "Admin access required" : "Unauthorized" },
        { status: forbidden ? 403 : 401 },
      );
    }
    throw error;
  }

  const supabaseAdmin = getSupabaseAdminClient();

  const { id: idStr } = params;
  const id = parseInt(idStr!, 10);
  console.log(`[Intelligence API] Starting for item ${id}...`);
  const ai = getAiClient();
  if (!ai.isConfigured()) {
    console.error(`[Intelligence API] Error: ${ai.providerName} API is not configured.`);
    return { error: `${ai.providerName} API not configured on server` };
  }

  try {
    // 1. Fetch Agenda Item and its Meeting ID
    console.log(`[Intelligence API] Fetching item data for ID ${id}...`);
    const { data: item, error: itemError } = await supabaseAdmin
      .from("agenda_items")
      .select("id, title, meeting_id, meta")
      .eq("id", id)
      .single();

    if (itemError || !item) {
        console.error(`[Intelligence API] Item error: ${itemError?.message}`);
        throw new Error(`Agenda item ${id} not found`);
    }

    console.log(`[Intelligence API] Current meta for item ${id}:`, JSON.stringify(item.meta));

    // 2. Fetch Speaker Aliases to resolve names
    const { data: aliases } = await supabaseAdmin
      .from("meeting_speaker_aliases")
      .select("speaker_label, person:people(name)")
      .eq("meeting_id", item.meeting_id);

    const aliasMap: Record<string, string> = {};
    (aliases || []).forEach((a: any) => {
      if (a.person?.name) {
        aliasMap[a.speaker_label] = a.person.name;
        aliasMap[a.speaker_label.toUpperCase()] = a.person.name;
      }
    });

    // 3. Fetch Transcript Segments
    console.log(`[Intelligence API] Fetching transcript segments...`);
    const { data: segments, error: segError } = await supabaseAdmin
      .from("transcript_segments")
      .select("speaker_name, text_content")
      .eq("agenda_item_id", id)
      .order("start_time", { ascending: true });

    if (segError) throw segError;
    if (!segments || segments.length === 0) {
      console.log(`[Intelligence API] No segments found for item ${id}`);
      return { error: "No transcript segments linked to this item yet." };
    }

    console.log(`[Intelligence API] Found ${segments.length} segments. Preparing prompt...`);

    // 4. Construct Transcript Text
    const transcriptText = segments
      .map((s) => {
        const name = aliasMap[s.speaker_name || ""] || s.speaker_name || "Unknown";
        return `${name}: ${s.text_content}`;
      })
      .join("\n");

    // 5. Call configured AI provider
    console.log(`[Intelligence API] Calling configured AI provider...`);

    const result = await ai.json({
      stage: "extraction",
      system: AGENDA_INTELLIGENCE_SYSTEM,
      prompt: buildAgendaIntelligencePrompt(item.title, transcriptText),
      schema: AgendaItemIntelligenceSchema,
      schemaName: AGENDA_INTELLIGENCE_SCHEMA_NAME,
    });
    const intelData = result.data;
    console.log(`[Intelligence API] AI response received.`);

    // 6. Update Database
    console.log(`[Intelligence API] Updating database...`);
    const newMeta = {
      ...(item.meta || {}),
      intelligence: intelData,
    };

    const { error: updateError } = await supabaseAdmin
      .from("agenda_items")
      .update({ meta: newMeta })
      .eq("id", id);

    if (updateError) {
        console.error(`[Intelligence API] Update error: ${updateError.message}`);
        throw updateError;
    }

    console.log(`[Intelligence API] Success!`);
    return Response.json({ success: true, intelligence: intelData });

  } catch (error: any) {
    console.error("[Intelligence API] Error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
export default function Component() { return null; }
