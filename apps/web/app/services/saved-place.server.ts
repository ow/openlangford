import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanLabel, validPoint, type SavedPlace } from "../lib/saved-place";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { geocodeAddress } from "./geocode.server";
import { addSubscription } from "./subscriptions";

const RADII = new Set([500, 1000, 2000, 3000]);

export type PlaceUpdate =
  | { kind: "none" }
  | { kind: "clear" }
  | { kind: "set"; place: SavedPlace }
  | { kind: "not_found" };

/**
 * Reads the place fields a PlacePicker posts. A typed address that wasn't looked up in the browser
 * is looked up here, and only the rounded result is returned; the address itself is dropped.
 */
export async function readPlaceUpdate(form: FormData): Promise<PlaceUpdate> {
  if (form.get("place_clear") === "1") return { kind: "clear" };
  const point = validPoint(form.get("place_lat"), form.get("place_lng"));
  if (point) return { kind: "set", place: { ...point, label: cleanLabel(form.get("place_label")) ?? DEFAULT_MUNICIPALITY.short_name } };
  const lookup = String(form.get("place_lookup") ?? "").trim().slice(0, 200);
  if (!lookup) return { kind: "none" };
  const place = await geocodeAddress(lookup);
  return place ? { kind: "set", place } : { kind: "not_found" };
}

export function readRadius(form: FormData) {
  const radius = Number(form.get("proximity_radius"));
  return RADII.has(radius) ? radius : null;
}

/** Saves (or removes) the place and keeps the "near my place" alert in step with it. */
export async function savePlace(supabase: SupabaseClient, userId: string, update: PlaceUpdate, radius: number | null) {
  if (update.kind === "clear") {
    const { error } = await supabase
      .from("user_profiles")
      .update({ location_lat: null, location_lng: null, location_label: null })
      .eq("id", userId);
    if (error) throw error;
    // Point-based alerts have nothing to measure from now; neighbourhood-name alerts stay.
    await supabase.from("subscriptions").delete().eq("user_id", userId).eq("type", "neighborhood").is("neighborhood", null);
    return;
  }

  if (update.kind === "set") {
    const { error } = await supabase
      .from("user_profiles")
      .upsert({ id: userId, location_lat: update.place.lat, location_lng: update.place.lng, location_label: update.place.label }, { onConflict: "id" });
    if (error) throw error;
    const { data: existing } = await supabase
      .from("subscriptions")
      .select("id")
      .eq("user_id", userId)
      .eq("type", "neighborhood")
      .is("neighborhood", null)
      .limit(1);
    if (!existing?.length) {
      await addSubscription(supabase, userId, "neighborhood", { proximity_radius_m: radius ?? 1000 });
      return;
    }
  }

  if (radius != null) {
    await supabase.from("subscriptions").update({ proximity_radius_m: radius }).eq("user_id", userId).eq("type", "neighborhood");
  }
}

export function savedPlace(profile: { location_lat?: number | null; location_lng?: number | null; location_label?: string | null } | null): SavedPlace | null {
  if (profile?.location_lat == null || profile?.location_lng == null) return null;
  return { lat: profile.location_lat, lng: profile.location_lng, label: profile.location_label || DEFAULT_MUNICIPALITY.short_name };
}
