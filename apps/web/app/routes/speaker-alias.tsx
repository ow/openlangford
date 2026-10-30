import { useState, useEffect, useRef } from "react";
import {
  Form,
  useSubmit,
  useNavigation,
  Link,
  useRevalidator,
} from "react-router";
import { requireAdmin } from "../lib/auth.server";
import {
  getSupabaseAdminClient,
  createSupabaseServerClient,
} from "../lib/supabase.server";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Search,
  Target,
  Scissors,
  Loader2,
  ChevronsUpDown,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { NativeSelect } from "../components/ui/native-select";
import { ScrollArea } from "../components/ui/scroll-area";
import { SearchField } from "../components/ui/search-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import { cn } from "../lib/utils";
import { getVideoSourceSetting, resolveVideoSource } from "../services/video/index.server";
import { getMunicipality } from "../services/municipality";
import { getMeetingById } from "../services/meetings";
import { mayStoreVoiceFingerprint } from "../services/voice-fingerprint-policy.server";
import { useVideoPlayer } from "../hooks/useVideoPlayer";

// Types
type Meeting = {
  id: number;
  title: string;
  meeting_date: string;
  video_url: string | null;
  direct_video_url?: string | null;
  direct_audio_url?: string | null;
};

type Segment = {
  id: number;
  start_time: number;
  end_time: number;
  speaker_name: string;
  text_content: string;
  person_id: number | null;
  person?: {
    name: string;
    image_url: string | null;
  };
};

type Person = {
  id: number;
  name: string;
  image_url: string | null;
  is_councillor: boolean;
};

type SpeakerAlias = {
  id: number;
  speaker_label: string;
  person_id: number;
};

type FingerprintMatch = {
  person_id: number;
  person_name: string;
  similarity: number;
};

export async function loader({ request }: { request: Request }) {
  await requireAdmin(request);
  const { supabase: serverClient } = createSupabaseServerClient(request);

  const url = new URL(request.url);
  const meetingId = url.searchParams.get("meetingId");

  // 1. Fetch all meetings for the dropdown
  const { data: meetings } = await serverClient
    .from("meetings")
    .select("id, slug, title, meeting_date, video_url")
    .not("video_url", "is", null)
    .neq("video_url", "")
    .order("meeting_date", { ascending: false });

  let segments: Segment[] = [];
  let people: Person[] = [];
  let aliases: SpeakerAlias[] = [];
  let currentMeeting: Meeting | null = null;

  if (meetingId) {
    // 2. Fetch Meeting Details
    currentMeeting =
      meetings?.find((m) => m.id.toString() === meetingId) || null;

    if (currentMeeting) {
      // 3. Fetch People (for assignment & mapping)
      const { data: ppl } = await serverClient
        .from("people")
        .select("id, name, image_url, is_councillor")
        .order("name");

      people = ppl || [];
      const peopleMap = new Map(people.map((p) => [p.id, p]));

      // 4. Fetch Meeting Details (Transcript & Aliases) via Service
      try {
        const adminClient = getSupabaseAdminClient();
        const meetingData = await getMeetingById(adminClient, meetingId);
        aliases = meetingData.speakerAliases;

        // Create alias map for fallback
        const aliasMap = new Map();
        aliases.forEach((a) => {
          aliasMap.set(a.speaker_label, a.person_id);
        });

        segments = meetingData.transcript.map((t: any) => {
          const resolvedPersonId =
            t.person_id || aliasMap.get(t.speaker_name) || null;
          const resolvedPerson = resolvedPersonId
            ? peopleMap.get(resolvedPersonId)
            : undefined;

          return {
            id: t.id,
            start_time: t.start_time,
            end_time: t.end_time,
            speaker_name: t.speaker_name || "Unknown",
            text_content: t.text_content,
            person_id: t.person_id,
            person: resolvedPerson,
          };
        });
      } catch (e) {
        console.error("Error fetching meeting details:", e);
      }

      if (currentMeeting.video_url) {
        try {
          const setting = await getVideoSourceSetting(serverClient);
          const municipality = await getMunicipality(serverClient).catch(() => null);
          const resolved = await resolveVideoSource(currentMeeting.video_url, {
            meetingId: currentMeeting.id,
            websiteUrl: municipality?.website_url,
            setting,
          });
          if (resolved?.source) {
            (currentMeeting as any).direct_video_url = resolved.source.url;
            (currentMeeting as any).direct_audio_url = resolved.source.audioUrl;
          }
        } catch (e) {
          console.error("Error resolving meeting video:", e);
        }
      }
    }
  }

  // Load speaker centroids and samples from meeting meta (for voice fingerprinting)
  let speakerCentroids: Record<string, number[]> = {};
  let speakerSamples: Record<string, { start: number; end: number }> = {};
  let fingerprintMatches: Record<string, FingerprintMatch> = {};
  let speakerMapping: Record<string, string> = {};
  if (meetingId) {
    const { data: meetingMeta } = await serverClient
      .from("meetings")
      .select("meta")
      .eq("id", meetingId)
      .single();

    speakerCentroids = (meetingMeta?.meta as any)?.speaker_centroids || {};
    speakerSamples = (meetingMeta?.meta as any)?.speaker_samples || {};
    fingerprintMatches = (meetingMeta?.meta as any)?.fingerprint_matches || {};
    speakerMapping = (meetingMeta?.meta as any)?.speaker_mapping || {};
  }

  // Load existing voice fingerprints for people (service role only: voice embeddings are private)
  const { data: fingerprints } = await getSupabaseAdminClient()
    .from("voice_fingerprints")
    .select("id, person_id");

  const peopleWithFingerprints = new Set(
    fingerprints?.map((f) => f.person_id) || [],
  );

  return {
    meetings,
    currentMeeting,
    segments,
    people,
    aliases,
    speakerCentroids,
    speakerSamples,
    fingerprintMatches,
    speakerMapping,
    peopleWithFingerprints: Array.from(peopleWithFingerprints),
  };
}

export async function action({ request }: { request: Request }) {
  await requireAdmin(request);
  const supabaseAdmin = getSupabaseAdminClient();

  const formData = await request.formData();
  const intent = formData.get("intent");
  const meetingId = formData.get("meetingId");

  if (!meetingId) return { error: "No meeting ID" };

  if (intent === "assign_alias") {
    // Map a Speaker Label to a Person globally for this meeting
    const speakerLabel = formData.get("speakerLabel") as string;
    let personId = formData.get("personId");
    const newPersonName = formData.get("newPersonName") as string;

    if (!speakerLabel) return { error: "Missing label" };
    if (!personId && !newPersonName) return { error: "Missing person" };

    // Create person if needed
    if (newPersonName) {
      const { data: newPerson, error: createError } = await supabaseAdmin
        .from("people")
        .insert({ name: newPersonName })
        .select()
        .single();

      if (createError) throw createError;
      personId = newPerson.id;
    }

    // 1. Upsert Alias
    const { error: aliasError } = await supabaseAdmin
      .from("meeting_speaker_aliases")
      .upsert(
        {
          meeting_id: meetingId,
          speaker_label: speakerLabel,
          person_id: personId,
        },
        { onConflict: "meeting_id, speaker_label" },
      );

    if (aliasError) throw aliasError;

    // 2. Update all segments with this label
    const { error: updateError } = await supabaseAdmin
      .from("transcript_segments")
      .update({ person_id: personId })
      .eq("meeting_id", meetingId)
      .eq("speaker_name", speakerLabel);

    if (updateError) throw updateError;

    // 3. Save voice fingerprint if centroid provided, only for officials (council, staff, or on
    // this meeting's attendance roster). A resident's name mapping is kept without their voice.
    const centroidJson = formData.get("centroid") as string;
    const storeVoice = !!centroidJson && !!personId && await mayStoreVoiceFingerprint(supabaseAdmin, String(personId), String(meetingId));
    if (centroidJson && personId && !storeVoice) {
      return { success: true, fingerprint: "skipped" as const };
    }
    if (storeVoice) {
      try {
        const centroid = JSON.parse(centroidJson);
        if (Array.isArray(centroid) && centroid.length === 192) {
          // Check if person already has a fingerprint
          const { data: existingFp } = await supabaseAdmin
            .from("voice_fingerprints")
            .select("id, source")
            .eq("person_id", personId)
            .maybeSingle();

          if (existingFp?.source === "aggregate") {
            // A manual mapping is the strongest anchor: it replaces the pipeline's
            // evidence-built fingerprint (the speaker-names stage then keeps it).
            await supabaseAdmin
              .from("voice_fingerprints")
              .update({
                embedding: centroid,
                source_meeting_id: meetingId,
                confidence: 1.0,
                source: "manual",
                exemplar_count: null,
                meeting_count: null,
              })
              .eq("id", existingFp.id);
          } else if (!existingFp) {
            // Create new fingerprint
            const { data: newFp, error: fpError } = await supabaseAdmin
              .from("voice_fingerprints")
              .insert({
                person_id: personId,
                embedding: centroid,
                source_meeting_id: meetingId,
                confidence: 1.0,
              })
              .select()
              .single();

            if (!fpError && newFp) {
              // Update person with voice_fingerprint_id
              await supabaseAdmin
                .from("people")
                .update({ voice_fingerprint_id: newFp.id })
                .eq("id", personId);
            }
          }
        }
      } catch (e) {
        console.error("Error saving voice fingerprint:", e);
      }
    }
  } else if (intent === "relabel_segments") {
    // Change the speaker label for specific segments
    // e.g. "Speaker 1" -> "Speaker 2" for selected segments
    const segmentIds = (formData.get("segmentIds") as string).split(",");
    const newLabel = formData.get("newLabel") as string;

    console.log(
      `Relabeling segments ${segmentIds.length} to "${newLabel}"`,
      segmentIds,
    );

    if (!segmentIds.length || !newLabel) return { error: "Missing data" };

    // Check if the new label has a person assigned
    const { data: existingAlias } = await supabaseAdmin
      .from("meeting_speaker_aliases")
      .select("person_id")
      .eq("meeting_id", meetingId)
      .eq("speaker_label", newLabel)
      .maybeSingle();

    const updates = {
      speaker_name: newLabel,
      person_id: existingAlias?.person_id || null,
    };

    const { error } = await supabaseAdmin
      .from("transcript_segments")
      .update(updates)
      .in(
        "id",
        segmentIds.map((id) => parseInt(id, 10)),
      );

    if (error) {
      console.error("Error updating segments:", error);
      throw error;
    }
  } else if (intent === "assign_person_segments") {
    // Manually assign specific segments to a person.
    // We try to use an existing label for this person if one exists (e.g. Speaker_07).
    // If not, we fall back to using their name as the label.
    const segmentIds = (formData.get("segmentIds") as string).split(",");
    let personId = formData.get("personId");
    const newPersonName = formData.get("newPersonName") as string;

    if (!segmentIds.length) return { error: "Missing segments" };
    if (!personId && !newPersonName) return { error: "Missing person" };

    // 0. If creating a new person, insert them first
    if (newPersonName) {
      const { data: newPerson, error: createError } = await supabaseAdmin
        .from("people")
        .insert({ name: newPersonName })
        .select()
        .single();

      if (createError) throw createError;
      personId = newPerson.id;
    }

    // 1. Check if there is already an alias for this person in this meeting
    const { data: existingAliases } = await supabaseAdmin
      .from("meeting_speaker_aliases")
      .select("speaker_label")
      .eq("meeting_id", meetingId)
      .eq("person_id", personId)
      .limit(1);

    let targetLabel = existingAliases?.[0]?.speaker_label;

    // 1b. If no explicit alias, check if this person is already assigned to any segments in this meeting
    // preventing fragmentation (e.g. creating "Ivan Leung" label when "Speaker_07" is already Ivan)
    if (!targetLabel) {
      const { data: existingSegment } = await supabaseAdmin
        .from("transcript_segments")
        .select("speaker_name")
        .eq("meeting_id", meetingId)
        .eq("person_id", personId)
        .limit(1)
        .maybeSingle();

      if (existingSegment) {
        targetLabel = existingSegment.speaker_name;
      }
    }

    // 2. If no alias exists, fetch the person's name to use as a new label
    if (!targetLabel) {
      const { data: person } = await supabaseAdmin
        .from("people")
        .select("name")
        .eq("id", personId)
        .single();

      if (!person) return { error: "Person not found" };

      targetLabel = person.name;

      // Ensure an alias exists for this new label
      await supabaseAdmin.from("meeting_speaker_aliases").upsert(
        {
          meeting_id: meetingId,
          speaker_label: targetLabel,
          person_id: personId,
        },
        { onConflict: "meeting_id, speaker_label" },
      );
    }

    // 3. Update the segments
    const { error } = await supabaseAdmin
      .from("transcript_segments")
      .update({
        person_id: personId,
        speaker_name: targetLabel,
      })
      .in("id", segmentIds);

    if (error) throw error;
  } else if (intent === "split_segment") {
    const segmentId = formData.get("segmentId");
    const text1 = formData.get("text1") as string;
    const text2 = formData.get("text2") as string;
    const splitTime = parseFloat(formData.get("splitTime") as string);

    if (!segmentId || !text1 || !text2 || isNaN(splitTime))
      return { error: "Missing split data" };

    const { data: original } = await supabaseAdmin
      .from("transcript_segments")
      .select("*")
      .eq("id", segmentId)
      .single();

    if (!original) return { error: "Segment not found" };

    // Update original (first part)
    const { error: updateError } = await supabaseAdmin
      .from("transcript_segments")
      .update({
        text_content: text1,
        end_time: splitTime,
      })
      .eq("id", segmentId);

    if (updateError) throw updateError;

    // Insert new (second part)
    const { error: insertError } = await supabaseAdmin
      .from("transcript_segments")
      .insert({
        meeting_id: original.meeting_id,
        speaker_name: original.speaker_name,
        person_id: original.person_id,
        start_time: splitTime,
        end_time: original.end_time,
        text_content: text2,
      });

    if (insertError) throw insertError;
  }

  return { success: true };
}

function formatClock(seconds: number) {
  return new Date(Math.max(0, seconds || 0) * 1000).toISOString().substr(11, 8);
}

// --- PersonTypeahead component ---
function PersonTypeahead({
  people,
  activePersonIds,
  assignedPerson,
  onSelect,
  onCreateNew,
  compact = false,
  label,
}: {
  people: Person[];
  activePersonIds: Set<number>;
  assignedPerson: Person | null;
  onSelect: (personId: string) => void;
  onCreateNew: (name: string) => void;
  compact?: boolean;
  /** Accessible name, e.g. the speaker label being assigned. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Build grouped, filtered list
  const lowerQuery = query.toLowerCase();
  const filtered = people.filter((p) =>
    p.name.toLowerCase().includes(lowerQuery),
  );

  const activeCouncil = filtered.filter(
    (p) => activePersonIds.has(p.id) && p.is_councillor,
  );
  const activeOther = filtered.filter(
    (p) => activePersonIds.has(p.id) && !p.is_councillor,
  );
  const council = filtered.filter(
    (p) => !activePersonIds.has(p.id) && p.is_councillor,
  );
  const others = filtered.filter(
    (p) => !activePersonIds.has(p.id) && !p.is_councillor,
  );

  type GroupedItem =
    | { type: "header"; label: string }
    | { type: "person"; person: Person }
    | { type: "create"; name: string };

  const items: GroupedItem[] = [];
  if (activeCouncil.length + activeOther.length > 0) {
    items.push({ type: "header", label: "In this meeting" });
    for (const p of activeCouncil) items.push({ type: "person", person: p });
    for (const p of activeOther) items.push({ type: "person", person: p });
  }
  if (council.length > 0) {
    items.push({ type: "header", label: "Council" });
    for (const p of council) items.push({ type: "person", person: p });
  }
  if (others.length > 0) {
    items.push({ type: "header", label: "Others" });
    for (const p of others) items.push({ type: "person", person: p });
  }
  if (query.trim().length > 0) {
    items.push({ type: "create", name: query.trim() });
  }

  const selectableItems = items.filter((i) => i.type !== "header");

  // Clamp highlight
  const clampedIdx = Math.min(highlightIdx, selectableItems.length - 1);

  // Keep the highlighted option visible while arrowing through a long list
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[data-highlighted="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open, clampedIdx]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) setTimeout(() => triggerRef.current?.focus(), 0);
  };

  const openMenu = (initialQuery = "") => {
    setOpen(true);
    setQuery(initialQuery);
    setHighlightIdx(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const selectItem = (item: GroupedItem) => {
    if (item.type === "person") {
      onSelect(item.person.id.toString());
    } else if (item.type === "create") {
      onCreateNew(item.name);
    }
    close(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, selectableItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selectableItems[clampedIdx]) {
        selectItem(selectableItems[clampedIdx]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  // Trigger: arrow keys open; typing a letter opens with that letter as the query
  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu();
    } else if (
      e.key.length === 1 &&
      /\S/.test(e.key) &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      openMenu(e.key);
    }
  };

  const listboxId = useRef(
    `people-${Math.random().toString(36).slice(2, 9)}`,
  ).current;

  // Track selectableIndex for highlighting
  let selectableIndex = -1;

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      {!open ? (
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-label={
            label
              ? `${label}: ${assignedPerson ? assignedPerson.name : "unassigned"}. Change person`
              : undefined
          }
          className={cn(
            "flex w-full items-center justify-between gap-1 rounded-md border text-left transition-colors focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20",
            compact ? "h-8 px-2 text-xs" : "h-9 px-2.5 text-sm",
            assignedPerson
              ? "border-brand-200 bg-brand-50 font-medium text-brand-800 hover:border-brand-300"
              : "border-zinc-200 bg-surface text-zinc-500 hover:border-zinc-300",
          )}
          onClick={() => openMenu()}
          onKeyDown={handleTriggerKeyDown}
        >
          <span className="truncate">
            {assignedPerson ? assignedPerson.name : "Assign person…"}
          </span>
          <ChevronsUpDown
            className="h-3 w-3 shrink-0 opacity-50"
            aria-hidden="true"
          />
        </button>
      ) : (
        <div>
          <div className="relative">
            <Search
              className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-400"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-label={label ? `Search people for ${label}` : "Search people"}
              className={cn(
                "w-full rounded-md border border-brand-400 pl-6 pr-2 outline-none ring-3 ring-brand-500/20",
                compact ? "h-8 text-xs" : "h-9 text-sm",
              )}
              placeholder="Search people…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlightIdx(0);
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-xl border border-zinc-200 bg-surface py-1 shadow-lg"
          >
            {items.length === 0 && query.trim().length === 0 && (
              <div className="px-3 py-2 text-xs text-zinc-500">
                No people found.
              </div>
            )}
            {items.map((item) => {
              if (item.type === "header") {
                return (
                  <div
                    key={`h-${item.label}`}
                    role="presentation"
                    className="sticky top-0 bg-surface/95 px-3 pb-1 pt-2 text-xs font-medium text-zinc-500"
                  >
                    {item.label}
                  </div>
                );
              }

              selectableIndex++;
              const currentSelIdx = selectableIndex;
              const isHighlighted = currentSelIdx === clampedIdx;

              if (item.type === "create") {
                return (
                  <button
                    key="create-new"
                    type="button"
                    role="option"
                    aria-selected={isHighlighted}
                    data-highlighted={isHighlighted}
                    tabIndex={-1}
                    className={cn(
                      "mt-1 flex w-full items-center border-t border-zinc-100 px-3 py-1.5 text-left text-xs",
                      isHighlighted
                        ? "bg-brand-50 text-brand-800"
                        : "text-brand-700 hover:bg-brand-50",
                    )}
                    onMouseEnter={() => setHighlightIdx(currentSelIdx)}
                    onClick={() => selectItem(item)}
                  >
                    Create &ldquo;{item.name}&rdquo;
                  </button>
                );
              }

              const p = item.person;
              const isCurrent = assignedPerson?.id === p.id;

              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={isHighlighted}
                  data-highlighted={isHighlighted}
                  tabIndex={-1}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                    isHighlighted
                      ? "bg-brand-50 text-brand-900"
                      : "text-zinc-700 hover:bg-zinc-50",
                  )}
                  onMouseEnter={() => setHighlightIdx(currentSelIdx)}
                  onClick={() => selectItem(item)}
                >
                  <span className={cn("flex-1 truncate", isCurrent && "font-semibold")}>
                    {p.name}
                  </span>
                  {isCurrent && (
                    <span className="shrink-0 text-zinc-400">Current</span>
                  )}
                  {p.is_councillor && (
                    <Badge variant="brand" className="px-1.5 py-0">
                      Council
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// --- One row in the Voice ID / Aliases lists ---
function SpeakerRow({
  label,
  mappedLabel,
  assignedPerson,
  personHasFingerprint,
  hasCentroid,
  hasSample,
  onPlaySample,
  segmentCount,
  isFiltered,
  onFilter,
  autoMatch,
  onAcceptAutoMatch,
  people,
  activePersonIds,
  onSelectPerson,
  onCreatePerson,
}: {
  label: string;
  mappedLabel?: string | null;
  assignedPerson: Person | null;
  personHasFingerprint: boolean;
  hasCentroid?: boolean;
  hasSample: boolean;
  onPlaySample: () => void;
  segmentCount: number;
  isFiltered: boolean;
  onFilter: () => void;
  autoMatch?: FingerprintMatch | null;
  onAcceptAutoMatch?: () => void;
  people: Person[];
  activePersonIds: Set<number>;
  onSelectPerson: (personId: string) => void;
  onCreatePerson: (name: string) => void;
}) {
  const status = assignedPerson
    ? personHasFingerprint
      ? { dot: "bg-emerald-500", text: "Assigned, voice fingerprint saved" }
      : { dot: "bg-brand-500", text: "Assigned, no voice fingerprint (kept for officials only)" }
    : { dot: "bg-zinc-300", text: "Unassigned" };

  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="ghost"
          className={cn(
            "h-7 w-7 shrink-0",
            hasSample
              ? "text-brand-700 hover:bg-brand-50 hover:text-brand-800"
              : "text-zinc-300",
          )}
          onClick={onPlaySample}
          disabled={!hasSample}
          aria-label={hasSample ? `Play sample of ${label}` : `No sample for ${label}`}
          title={hasSample ? "Play sample" : "No sample available"}
        >
          <Play className="h-3.5 w-3.5" />
        </Button>

        <div className="flex w-36 min-w-0 shrink-0 items-center gap-1.5">
          <span
            className={cn("h-2 w-2 shrink-0 rounded-full", status.dot)}
            title={status.text}
          />
          <span className="sr-only">{status.text}.</span>
          <div className="min-w-0">
            <div className="truncate font-mono text-xs font-medium text-zinc-900" title={label}>
              {label}
            </div>
            {(mappedLabel || hasCentroid) && (
              <div className="truncate text-xs text-zinc-500">
                {mappedLabel ? (
                  <span className="font-mono" title={`Transcript label: ${mappedLabel}`}>
                    → {mappedLabel}
                  </span>
                ) : (
                  "Voice embedding"
                )}
              </div>
            )}
          </div>
        </div>

        <PersonTypeahead
          people={people}
          activePersonIds={activePersonIds}
          assignedPerson={assignedPerson}
          onSelect={onSelectPerson}
          onCreateNew={onCreatePerson}
          label={label}
          compact
        />

        <button
          type="button"
          onClick={onFilter}
          aria-pressed={isFiltered}
          aria-label={`Show ${segmentCount} segments for ${label}`}
          title="Filter transcript to this speaker"
          className={cn(
            "h-7 min-w-9 shrink-0 rounded-md px-1.5 text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20",
            isFiltered
              ? "bg-brand-600 text-white"
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200",
          )}
        >
          {segmentCount}
        </button>
      </div>

      {autoMatch && !assignedPerson && onAcceptAutoMatch && (
        <div className="mt-1.5 flex items-center gap-2 pl-9 text-xs text-zinc-500">
          <span>Suggested</span>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-500/30"
            onClick={onAcceptAutoMatch}
            aria-label={`Accept suggested match ${autoMatch.person_name}, ${Math.round(autoMatch.similarity * 100)}% similar`}
          >
            {autoMatch.person_name}
            <span
              className={cn(
                "tabular-nums",
                autoMatch.similarity >= 0.9
                  ? "text-emerald-700"
                  : autoMatch.similarity >= 0.8
                    ? "text-amber-700"
                    : "text-zinc-500",
              )}
            >
              {Math.round(autoMatch.similarity * 100)}%
            </span>
          </button>
        </div>
      )}
    </li>
  );
}

export default function SpeakerAliasTool({ loaderData }: any) {
  const {
    meetings,
    currentMeeting,
    segments,
    people,
    aliases,
    speakerCentroids,
    speakerSamples,
    fingerprintMatches,
    speakerMapping,
    peopleWithFingerprints,
  } = loaderData;

  // Helper to find centroid for a speaker label (handles format variations)
  const findCentroid = (speakerLabel: string): number[] | null => {
    if (!speakerCentroids) return null;

    // Direct match
    if (speakerCentroids[speakerLabel]) return speakerCentroids[speakerLabel];

    // Extract number and try variations
    const numMatch = speakerLabel.match(/(\d+)/);
    if (!numMatch) return null;
    const num = parseInt(numMatch[1], 10);

    const formats = [
      `SPEAKER_${num.toString().padStart(2, "0")}`,
      `SPEAKER_${num}`,
      `Speaker_${num}`,
      `speaker_${num}`,
    ];

    for (const fmt of formats) {
      if (speakerCentroids[fmt]) return speakerCentroids[fmt];
    }

    return null;
  };

  // Sort people: Active speakers (aliased) first
  const activePersonIds = new Set<number>(aliases?.map((a: any) => a.person_id) || []);
  const sortedPeople = [...(people || [])].sort((a: any, b: any) => {
    const aActive = activePersonIds.has(a.id);
    const bActive = activePersonIds.has(b.id);
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return a.name.localeCompare(b.name);
  });

  const [selectedSegments, setSelectedSegments] = useState<Set<number>>(
    new Set(),
  );
  const [lastSelectedId, setLastSelectedId] = useState<number | null>(null);
  const [bulkMode, setBulkMode] = useState<"label" | "person" | null>(null);
  const [isCreatingPerson, setIsCreatingPerson] = useState(false);
  const showCorrected = true; // Legacy: corrected text is now always in text_content
  const [activeTab, setActiveTab] = useState<"voiceid" | "aliases">(
    Object.keys(speakerCentroids || {}).length > 0 ? "voiceid" : "aliases",
  );
  const [splitSegment, setSplitSegment] = useState<Segment | null>(null);
  const [splitText1, setSplitText1] = useState("");
  const [splitText2, setSplitText2] = useState("");

  // Filtering
  const [filterText, setFilterText] = useState("");
  const [filterSpeaker, setFilterSpeaker] = useState<string>("all");
  const [isFilterEnabled, setIsFilterEnabled] = useState(true);

  const submit = useSubmit();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isSaving = navigation.state !== "idle";

  const handleVideoError = () => {
    console.error("Video failed to load. Reporting failure...");
    fetch("/api/report-video-failure", {
      method: "POST",
      body: new URLSearchParams({
        meetingId: currentMeeting.id.toString(),
      }),
    })
      .then(() => {
        console.log("Reported failure. Revalidating...");
        revalidator.revalidate();
      })
      .catch((e) => console.error("Failed to report error", e));
  };

  // Use the shared video player hook
  const videoPlayer = useVideoPlayer({
    directVideoUrl: currentMeeting?.direct_video_url,
    directAudioUrl: currentMeeting?.direct_audio_url,
    initialVolume: 1,
    onError: handleVideoError,
  });

  // Reset video when meeting changes
  useEffect(() => {
    videoPlayer.setVideoEnabled(false);
  }, [currentMeeting?.id]);

  // Esc clears the segment selection (unless typing or a dialog is open)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || splitSegment) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [role='dialog']")) return;
      setSelectedSegments((prev) => (prev.size ? new Set() : prev));
      setBulkMode(null);
      setIsCreatingPerson(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [splitSegment]);

  // Handle segment selection (Shift+Click support)
  const toggleSelection = (id: number, shiftKey: boolean) => {
    const newSet = new Set(selectedSegments);

    if (shiftKey && lastSelectedId !== null) {
      // Find range
      const ids = segments.map((s: any) => s.id);
      const idx1 = ids.indexOf(lastSelectedId);
      const idx2 = ids.indexOf(id);
      if (idx1 !== -1 && idx2 !== -1) {
        const start = Math.min(idx1, idx2);
        const end = Math.max(idx1, idx2);
        for (let i = start; i <= end; i++) {
          newSet.add(ids[i]);
        }
      }
    } else {
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
    }

    setSelectedSegments(newSet);
    setLastSelectedId(id);
  };

  const seekTo = (time: number) => {
    videoPlayer.seekTo(time);
  };

  // Filtered Segments
  const filteredSegments = segments.filter((s: any) => {
    if (
      isFilterEnabled &&
      filterSpeaker !== "all" &&
      s.speaker_name !== filterSpeaker
    )
      return false;

    const text = s.text_content;
    if (filterText && !text.toLowerCase().includes(filterText.toLowerCase()))
      return false;
    return true;
  });

  // Unique speakers for filter
  const uniqueSpeakers = Array.from(
    new Set(segments.map((s: any) => s.speaker_name)),
  ).sort() as string[];

  const centroidCount = Object.keys(speakerCentroids || {}).length;

  // Action Handlers

  const handleBulkPerson = (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    formData.append("meetingId", currentMeeting.id.toString());
    formData.append("segmentIds", Array.from(selectedSegments).join(","));

    const selection = formData.get("personId") as string;
    if (selection && selection.startsWith("LABEL:")) {
      formData.append("intent", "relabel_segments");
      formData.append("newLabel", selection.replace("LABEL:", ""));
      formData.delete("personId");
    } else {
      formData.append("intent", "assign_person_segments");
    }

    submit(formData, { method: "post" });
    setSelectedSegments(new Set());
    setBulkMode(null);
    setIsCreatingPerson(false);
  };

  const handleAliasAssign = (
    label: string,
    personId: string | null,
    newName?: string,
  ) => {
    const formData = new FormData();
    formData.append("meetingId", currentMeeting.id.toString());
    formData.append("speakerLabel", label);
    if (personId) formData.append("personId", personId);
    if (newName) formData.append("newPersonName", newName);
    formData.append("intent", "assign_alias");

    // Include centroid for voice fingerprinting if available
    const centroid = findCentroid(label);
    if (centroid) {
      formData.append("centroid", JSON.stringify(centroid));
    }

    submit(formData, { method: "post" });
  };

  const handleScrollToCurrent = () => {
    let activeSegment = null;
    for (let i = filteredSegments.length - 1; i >= 0; i--) {
      if (filteredSegments[i].start_time <= videoPlayer.currentTime) {
        activeSegment = filteredSegments[i];
        break;
      }
    }

    if (activeSegment) {
      const el = document.getElementById(`segment-${activeSegment.id}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  };

  const handleSplitSubmit = () => {
    if (!splitSegment) return;
    const duration = splitSegment.end_time - splitSegment.start_time;
    const totalLen = splitText1.length + splitText2.length;
    // Estimate split time based on text length ratio
    const ratio = totalLen > 0 ? splitText1.length / totalLen : 0.5;
    const splitTime = splitSegment.start_time + duration * ratio;

    const formData = new FormData();
    formData.append("meetingId", currentMeeting.id.toString());
    formData.append("segmentId", splitSegment.id.toString());
    formData.append("text1", splitText1);
    formData.append("text2", splitText2);
    formData.append("splitTime", splitTime.toString());
    formData.append("intent", "split_segment");
    submit(formData, { method: "post" });
    setSplitSegment(null);
  };

  const playSampleAt = (start: number) => {
    if (videoPlayer.videoRef.current) {
      (videoPlayer.videoRef.current as HTMLElement).scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
    videoPlayer.seekTo(start);
  };

  const filterToSpeaker = (label: string) => {
    if (filterSpeaker === label && isFilterEnabled) {
      setFilterSpeaker("all");
    } else {
      setFilterSpeaker(label);
      setIsFilterEnabled(true);
    }
  };

  const tabClass = (active: boolean) =>
    cn(
      "flex flex-1 items-center justify-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-brand-500/20",
      active
        ? "border-brand-600 bg-surface text-brand-800"
        : "border-transparent text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800",
    );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-50">
      {/* Header */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-zinc-200 bg-surface px-4">
        <h1 className="shrink-0 text-base font-semibold text-zinc-900">
          Speaker aliases
        </h1>

        <form
          method="get"
          className="min-w-0 max-w-md flex-1"
          onChange={(e) => (e.currentTarget as any).submit()}
        >
          <label htmlFor="meeting-picker" className="sr-only">
            Meeting
          </label>
          <NativeSelect
            id="meeting-picker"
            name="meetingId"
            defaultValue={currentMeeting?.id || ""}
          >
            <option value="" disabled>
              Select a meeting…
            </option>
            {meetings?.map((m: any) => (
              <option key={m.id} value={m.id}>
                {new Date(m.meeting_date).toLocaleDateString()} · {m.title}
              </option>
            ))}
          </NativeSelect>
        </form>

        <div className="flex-1" />

        {isSaving && (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-xs text-zinc-500"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Saving
          </span>
        )}

        <Button variant="ghost" size="sm" asChild>
          <Link to="/">Exit</Link>
        </Button>
      </header>

      {currentMeeting ? (
        <div className="flex flex-1 overflow-hidden">
          {/* Left Panel: Video & Aliases */}
          <div className="z-10 flex w-[560px] shrink-0 flex-col overflow-y-auto border-r border-zinc-200 bg-surface">
            <div className="group relative sticky top-0 aspect-video bg-black">
              {!currentMeeting.direct_video_url ? (
                <div className="flex h-full items-center justify-center text-sm text-zinc-400">
                  No video available for this meeting.
                </div>
              ) : !videoPlayer.videoEnabled ? (
                <button
                  type="button"
                  className="flex h-full w-full flex-col items-center justify-center gap-2 text-white transition-colors hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-brand-500/50"
                  onClick={() => videoPlayer.setVideoEnabled(true)}
                >
                  <Play className="h-12 w-12 opacity-80" aria-hidden="true" />
                  <span className="text-sm font-medium">Load video</span>
                </button>
              ) : (
                <>
                  <video
                    ref={videoPlayer.videoRef}
                    src={currentMeeting.direct_video_url}
                    className="h-full w-full"
                    onClick={videoPlayer.togglePlay}
                    preload="metadata"
                    muted={
                      !!currentMeeting.direct_audio_url ||
                      videoPlayer.volume === 0
                    }
                    onError={handleVideoError}
                  />
                  {currentMeeting.direct_audio_url && (
                    <audio
                      ref={videoPlayer.audioRef}
                      src={currentMeeting.direct_audio_url}
                      className="hidden"
                      preload="metadata"
                      muted={videoPlayer.volume === 0}
                    />
                  )}
                  {/* Loading indicator */}
                  {videoPlayer.isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <Loader2 className="h-8 w-8 animate-spin text-white" aria-label="Loading video" />
                    </div>
                  )}
                  {/* Custom Controls */}
                  <div className="absolute bottom-0 left-0 right-0 flex flex-col gap-2 bg-gradient-to-t from-black/80 to-transparent p-4 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <input
                      type="range"
                      aria-label="Seek"
                      min={0}
                      max={videoPlayer.duration || 100}
                      value={videoPlayer.currentTime}
                      onChange={(e) =>
                        videoPlayer.seekTo(parseFloat(e.target.value))
                      }
                      className="h-1 w-full cursor-pointer appearance-none rounded-full bg-surface/30 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500"
                    />
                    <div className="flex items-center justify-between text-white">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={videoPlayer.togglePlay}
                          className="hover:text-brand-300"
                          aria-label={videoPlayer.isPlaying ? "Pause" : "Play"}
                        >
                          {videoPlayer.isPlaying ? (
                            <Pause className="h-5 w-5 fill-current" />
                          ) : (
                            <Play className="h-5 w-5 fill-current" />
                          )}
                        </button>
                        <div className="group/vol relative flex items-center gap-2">
                          <button
                            type="button"
                            onClick={videoPlayer.toggleMute}
                            className="hover:text-brand-300"
                            aria-label={videoPlayer.volume === 0 ? "Unmute" : "Mute"}
                          >
                            {videoPlayer.volume === 0 ? (
                              <VolumeX className="h-4 w-4" />
                            ) : (
                              <Volume2 className="h-4 w-4" />
                            )}
                          </button>
                          <input
                            type="range"
                            aria-label="Volume"
                            min={0}
                            max={1}
                            step={0.1}
                            value={videoPlayer.volume}
                            onChange={(e) =>
                              videoPlayer.setVolume(parseFloat(e.target.value))
                            }
                            className="h-1 w-20 cursor-pointer rounded-full bg-surface/30"
                          />
                        </div>
                        <span className="font-mono text-xs tabular-nums">
                          {formatClock(videoPlayer.currentTime)} /{" "}
                          {formatClock(videoPlayer.duration || 0)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const rates = [1, 1.5, 2];
                          const nextIdx =
                            (rates.indexOf(videoPlayer.playbackRate) + 1) %
                            rates.length;
                          videoPlayer.setPlaybackRate(rates[nextIdx]);
                        }}
                        className="rounded px-1.5 text-xs font-semibold tabular-nums hover:text-brand-300"
                        aria-label={`Playback speed ${videoPlayer.playbackRate}x. Change speed`}
                      >
                        {videoPlayer.playbackRate}x
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="flex flex-col border-b border-zinc-200 bg-zinc-50">
              {/* Tab switcher */}
              <div role="tablist" aria-label="Speaker lists" className="flex border-b border-zinc-200">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "voiceid"}
                  className={tabClass(activeTab === "voiceid")}
                  onClick={() => setActiveTab("voiceid")}
                >
                  Voice ID
                  {centroidCount > 0 && (
                    <Badge variant="muted" className="tabular-nums">
                      {centroidCount}
                    </Badge>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "aliases"}
                  className={tabClass(activeTab === "aliases")}
                  onClick={() => setActiveTab("aliases")}
                >
                  Transcript labels
                  <Badge variant="muted" className="tabular-nums">
                    {uniqueSpeakers.length}
                  </Badge>
                </button>
              </div>

              <ScrollArea className="h-[300px] bg-surface">
                {/* Voice ID Tab */}
                {activeTab === "voiceid" &&
                  (centroidCount === 0 ? (
                    <div className="m-3 rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                      No voice centroids for this meeting. Use transcript labels instead, or rerun audio processing to generate them.
                    </div>
                  ) : (
                    <ul className="divide-y divide-zinc-100">
                      {Object.keys(speakerCentroids)
                        .sort()
                        .map((centroidKey) => {
                          // Resolve the transcript speaker_name that maps to this centroid
                          const numMatch = centroidKey.match(/(\d+)/);
                          const num = numMatch ? parseInt(numMatch[1], 10) : null;

                          // Use speaker_mapping from meta if available, otherwise try format variations
                          const mappedLabel = speakerMapping?.[centroidKey] || null;
                          const labelFormats =
                            num !== null
                              ? [
                                  ...(mappedLabel ? [mappedLabel] : []),
                                  centroidKey,
                                  `SPEAKER_${num.toString().padStart(2, "0")}`,
                                  `SPEAKER_${num}`,
                                  `Speaker_${num}`,
                                  `speaker_${num}`,
                                ]
                              : [...(mappedLabel ? [mappedLabel] : []), centroidKey];

                          // Find the first format that actually has segments
                          const matchedSegmentLabel =
                            labelFormats.find((fmt) =>
                              segments.some((s: any) => s.speaker_name === fmt),
                            ) || centroidKey;

                          // Find sample (same key-format matching)
                          const sampleKeys =
                            num !== null
                              ? [
                                  centroidKey,
                                  `SPEAKER_${num.toString().padStart(2, "0")}`,
                                  `SPEAKER_${num}`,
                                  `Speaker_${num}`,
                                ]
                              : [centroidKey];
                          const sample = sampleKeys.reduce(
                            (found, key) => found || speakerSamples?.[key],
                            null as any,
                          );
                          const hasSample = sample?.start !== undefined;

                          // Find auto-match suggestion
                          const autoMatch =
                            (fingerprintMatches as Record<string, FingerprintMatch>)?.[
                              centroidKey
                            ] || null;

                          // Find existing alias (try matched label and format variations)
                          const alias = labelFormats.reduce(
                            (found, fmt) =>
                              found ||
                              aliases.find((a: any) => a.speaker_label === fmt),
                            null as SpeakerAlias | null,
                          );
                          const assignedPerson = alias
                            ? people.find((p: any) => p.id === alias.person_id)
                            : null;

                          // Count segments using the matched label
                          const segmentCount = segments.filter(
                            (s: any) => s.speaker_name === matchedSegmentLabel,
                          ).length;

                          // Check fingerprint status
                          const personHasFingerprint = !!(
                            assignedPerson &&
                            peopleWithFingerprints?.includes(assignedPerson.id)
                          );

                          return (
                            <SpeakerRow
                              key={centroidKey}
                              label={centroidKey}
                              mappedLabel={
                                matchedSegmentLabel !== centroidKey &&
                                segmentCount > 0
                                  ? matchedSegmentLabel
                                  : null
                              }
                              assignedPerson={assignedPerson || null}
                              personHasFingerprint={personHasFingerprint}
                              hasSample={hasSample}
                              onPlaySample={() =>
                                hasSample && playSampleAt(sample.start)
                              }
                              segmentCount={segmentCount}
                              isFiltered={
                                isFilterEnabled &&
                                filterSpeaker === matchedSegmentLabel
                              }
                              onFilter={() => filterToSpeaker(matchedSegmentLabel)}
                              autoMatch={autoMatch}
                              onAcceptAutoMatch={() =>
                                autoMatch &&
                                handleAliasAssign(
                                  matchedSegmentLabel,
                                  autoMatch.person_id.toString(),
                                )
                              }
                              people={people}
                              activePersonIds={activePersonIds}
                              onSelectPerson={(personId) =>
                                handleAliasAssign(matchedSegmentLabel, personId)
                              }
                              onCreatePerson={(name) =>
                                handleAliasAssign(matchedSegmentLabel, null, name)
                              }
                            />
                          );
                        })}
                    </ul>
                  ))}

                {/* Transcript labels tab (existing alias behaviour) */}
                {activeTab === "aliases" &&
                  (uniqueSpeakers.length === 0 ? (
                    <div className="m-3 rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                      This meeting has no transcript segments yet.
                    </div>
                  ) : (
                    <ul className="divide-y divide-zinc-100">
                      {uniqueSpeakers.map((speaker) => {
                        const alias = aliases.find(
                          (a: any) => a.speaker_label === speaker,
                        );
                        const assignedPerson = alias
                          ? people.find((p: any) => p.id === alias.person_id)
                          : null;
                        const centroid = findCentroid(speaker);
                        const hasCentroid = !!centroid;
                        const personHasFingerprint = !!(
                          assignedPerson &&
                          peopleWithFingerprints?.includes(assignedPerson.id)
                        );

                        // Find sample for this speaker (try multiple key formats)
                        const numMatch = speaker.match(/(\d+)/);
                        const num = numMatch ? parseInt(numMatch[1], 10) : null;
                        const sampleKeys =
                          num !== null
                            ? [
                                speaker,
                                `SPEAKER_${num.toString().padStart(2, "0")}`,
                                `SPEAKER_${num}`,
                                `Speaker_${num}`,
                              ]
                            : [speaker];
                        const sample = sampleKeys.reduce(
                          (found, key) => found || speakerSamples?.[key],
                          null as any,
                        );
                        const hasSample = sample?.start !== undefined;

                        return (
                          <SpeakerRow
                            key={speaker}
                            label={speaker}
                            hasCentroid={hasCentroid}
                            assignedPerson={assignedPerson || null}
                            personHasFingerprint={personHasFingerprint}
                            hasSample={hasSample}
                            onPlaySample={() =>
                              hasSample && playSampleAt(sample.start)
                            }
                            segmentCount={
                              segments.filter(
                                (s: any) => s.speaker_name === speaker,
                              ).length
                            }
                            isFiltered={
                              isFilterEnabled && filterSpeaker === speaker
                            }
                            onFilter={() => filterToSpeaker(speaker)}
                            people={people}
                            activePersonIds={activePersonIds}
                            onSelectPerson={(personId) =>
                              handleAliasAssign(speaker, personId)
                            }
                            onCreatePerson={(name) =>
                              handleAliasAssign(speaker, null, name)
                            }
                          />
                        );
                      })}
                    </ul>
                  ))}
              </ScrollArea>
            </div>

            {/* Bulk Actions Panel */}
            <section
              aria-labelledby="selection-heading"
              className="flex-1 p-4"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2
                  id="selection-heading"
                  className="text-sm font-semibold text-zinc-900"
                >
                  Selected segments{" "}
                  <span className="font-normal tabular-nums text-zinc-500">
                    {selectedSegments.size}
                  </span>
                </h2>
                {selectedSegments.size > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-zinc-600"
                    onClick={() => {
                      setSelectedSegments(new Set());
                      setBulkMode(null);
                      setIsCreatingPerson(false);
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>

              {bulkMode === "person" && selectedSegments.size > 0 ? (
                <Form
                  onSubmit={handleBulkPerson}
                  className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3"
                >
                  {isCreatingPerson ? (
                    <div>
                      <label
                        htmlFor="bulk-new-person"
                        className="mb-1.5 block text-sm text-zinc-600"
                      >
                        New person name
                      </label>
                      <Input
                        id="bulk-new-person"
                        name="newPersonName"
                        className="h-9 bg-surface text-sm"
                        autoFocus
                        required
                      />
                      <button
                        type="button"
                        className="mt-1.5 text-xs font-medium text-brand-700 hover:underline"
                        onClick={() => setIsCreatingPerson(false)}
                      >
                        Pick an existing person instead
                      </button>
                    </div>
                  ) : (
                    <div>
                      <label
                        htmlFor="bulk-person"
                        className="mb-1.5 block text-sm text-zinc-600"
                      >
                        Assign {selectedSegments.size} segment
                        {selectedSegments.size === 1 ? "" : "s"} to
                      </label>
                      <NativeSelect
                        id="bulk-person"
                        name="personId"
                        required
                        defaultValue=""
                        autoFocus
                      >
                        <option value="" disabled>
                          Select a person or label…
                        </option>
                        <optgroup label="Speaker labels">
                          {uniqueSpeakers.sort().map((s) => (
                            <option key={s} value={`LABEL:${s}`}>
                              {s}
                            </option>
                          ))}
                        </optgroup>
                        {activePersonIds.size > 0 && (
                          <optgroup label="In this meeting">
                            {sortedPeople
                              .filter((p) => activePersonIds.has(p.id))
                              .map((p: any) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                          </optgroup>
                        )}
                        <optgroup label="All people">
                          {sortedPeople
                            .filter((p) => !activePersonIds.has(p.id))
                            .map((p: any) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </optgroup>
                      </NativeSelect>
                      <button
                        type="button"
                        className="mt-1.5 text-xs font-medium text-brand-700 hover:underline"
                        onClick={() => setIsCreatingPerson(true)}
                      >
                        Create a new person
                      </button>
                    </div>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      onClick={() => {
                        setBulkMode(null);
                        setIsCreatingPerson(false);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" type="submit">
                      Apply
                    </Button>
                  </div>
                </Form>
              ) : (
                <Button
                  size="sm"
                  variant={selectedSegments.size > 0 ? "default" : "outline"}
                  className="w-full"
                  disabled={selectedSegments.size === 0}
                  onClick={() => setBulkMode("person")}
                >
                  Assign selected segments
                </Button>
              )}

              <p className="mt-3 text-xs text-zinc-500">
                Tick segments in the transcript to reassign them.{" "}
                <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-sans text-[11px]">
                  Shift
                </kbd>{" "}
                + click selects a range;{" "}
                <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1 font-sans text-[11px]">
                  Esc
                </kbd>{" "}
                clears.
              </p>
            </section>
          </div>

          {/* Right Panel: Transcript */}
          <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 bg-surface px-4 py-2">
              <SearchField
                value={filterText}
                onValueChange={setFilterText}
                placeholder="Search transcript"
                aria-label="Search transcript"
                className="w-56"
              />
              <NativeSelect
                aria-label="Filter by speaker"
                className={cn(
                  "w-56 transition-opacity",
                  !isFilterEnabled && filterSpeaker !== "all" && "opacity-50",
                )}
                value={filterSpeaker}
                onChange={(e) => {
                  setFilterSpeaker(e.target.value);
                  setIsFilterEnabled(true);
                }}
              >
                <option value="all">All speakers</option>
                {uniqueSpeakers.map((s) => {
                  const alias = aliases.find(
                    (a: any) => a.speaker_label === s,
                  );
                  const person = alias
                    ? people.find((p: any) => p.id === alias.person_id)
                    : null;
                  return (
                    <option key={s} value={s}>
                      {s} {person ? `(${person.name})` : ""}
                    </option>
                  );
                })}
              </NativeSelect>
              {filterSpeaker !== "all" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-10 whitespace-nowrap"
                  aria-pressed={!isFilterEnabled}
                  onClick={() => setIsFilterEnabled(!isFilterEnabled)}
                >
                  {isFilterEnabled ? "Show context" : "Filter view"}
                </Button>
              )}
              <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-zinc-500 hover:text-brand-700"
                  onClick={handleScrollToCurrent}
                  aria-label="Jump to current segment"
                  title="Jump to current segment"
                >
                  <Target className="h-4 w-4" />
                </Button>
                <span className="tabular-nums">
                  {filteredSegments.length.toLocaleString()} segments
                </span>
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto bg-surface">
              {filteredSegments.length === 0 ? (
                <div className="m-4 rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                  {segments.length === 0
                    ? "This meeting has no transcript segments."
                    : "No segments match the current search or speaker filter."}
                </div>
              ) : (
                <ul className="divide-y divide-zinc-100 pb-20">
                  {filteredSegments.map((segment: any) => {
                    const isSelected = selectedSegments.has(segment.id);
                    const isCurrentSegment =
                      videoPlayer.currentTime >= segment.start_time &&
                      videoPlayer.currentTime < segment.start_time + 10;
                    const clock = formatClock(segment.start_time);

                    return (
                      <li
                        key={segment.id}
                        id={`segment-${segment.id}`}
                        className={cn(
                          "group flex gap-3 px-4 py-2.5 transition-colors",
                          isSelected ? "bg-brand-50" : "hover:bg-zinc-50",
                          isCurrentSegment &&
                            "shadow-[inset_3px_0_0_var(--color-brand-500)]",
                        )}
                      >
                        <div className="pt-0.5">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSelection(
                                segment.id,
                                (e as any).nativeEvent.shiftKey,
                              );
                            }}
                            aria-label={`Select segment at ${clock}`}
                            className="h-4 w-4 rounded border-zinc-300 accent-brand-600"
                          />
                        </div>

                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => seekTo(segment.start_time)}
                              className="rounded font-mono text-xs tabular-nums text-zinc-500 hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20"
                              aria-label={`Play from ${clock}`}
                            >
                              {clock}
                            </button>

                            <Badge variant="muted" className="font-mono">
                              {segment.speaker_name}
                            </Badge>
                            {segment.person &&
                              segment.person.name !== segment.speaker_name && (
                                <>
                                  <span className="text-xs text-zinc-300" aria-hidden="true">
                                    →
                                  </span>
                                  <Badge variant="brand">
                                    {segment.person.name}
                                  </Badge>
                                </>
                              )}
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="ml-auto h-6 w-6 text-zinc-400 opacity-0 transition-opacity hover:text-brand-700 focus-visible:opacity-100 group-hover:opacity-100"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSplitSegment(segment);
                                setSplitText1(segment.text_content);
                                setSplitText2("");
                              }}
                              aria-label={`Split segment at ${clock}`}
                              title="Split segment"
                            >
                              <Scissors className="h-3.5 w-3.5" />
                            </Button>
                          </div>

                          <p className="text-sm leading-relaxed text-zinc-800">
                            {segment.text_content}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-start justify-center p-12">
          <div className="w-full max-w-md rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
            Select a meeting above to map its diarized speaker labels to
            people. Only meetings with video are listed.
          </div>
        </div>
      )}

      <Dialog
        open={!!splitSegment}
        onOpenChange={(open) => !open && setSplitSegment(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Split segment</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div>
              <label
                htmlFor="split-first"
                className="mb-1.5 block text-sm text-zinc-600"
              >
                First part
              </label>
              <textarea
                id="split-first"
                className="min-h-[100px] w-full rounded-lg border border-zinc-200 p-2 text-sm focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20"
                value={splitText1}
                onChange={(e) => setSplitText1(e.target.value)}
              />
            </div>
            <div>
              <label
                htmlFor="split-second"
                className="mb-1.5 block text-sm text-zinc-600"
              >
                Second part
              </label>
              <textarea
                id="split-second"
                className="min-h-[100px] w-full rounded-lg border border-zinc-200 p-2 text-sm focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20"
                value={splitText2}
                onChange={(e) => setSplitText2(e.target.value)}
                placeholder="Cut and paste the second half here"
              />
            </div>
            <p className="text-xs text-zinc-500">
              The split time is estimated from the length of each part.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSplitSegment(null)}>
              Cancel
            </Button>
            <Button
              onClick={handleSplitSubmit}
              disabled={!splitText1 || !splitText2}
            >
              Split segment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
