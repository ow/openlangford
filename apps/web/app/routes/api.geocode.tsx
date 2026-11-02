import type { Route } from "./+types/api.geocode";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { validPoint } from "../lib/saved-place";
import { geocodeAddress, placeNear } from "../services/geocode.server";

/**
 * POST /api/geocode
 * Body: { address: string } or { lat: number, lng: number } (the browser's location)
 * Returns: { lat, lng, label } — the point rounded to about a block, and the street name.
 *
 * Signed-in only. The address goes to Nominatim for the lookup and is not stored or logged.
 */
export async function action({ request }: Route.ActionArgs) {
  const { supabase } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Sign in to look up a place." }, { status: 401 });

  let body: { address?: unknown; lat?: unknown; lng?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Enter an address." }, { status: 400 });
  }

  try {
    if (body.lat != null || body.lng != null) {
      const point = validPoint(body.lat, body.lng);
      if (!point) return Response.json({ error: "That location isn't valid." }, { status: 400 });
      return Response.json(await placeNear(point.lat, point.lng));
    }
    const address = typeof body.address === "string" ? body.address.trim().slice(0, 200) : "";
    if (!address) return Response.json({ error: "Enter an address." }, { status: 400 });
    const place = await geocodeAddress(address);
    if (!place) return Response.json({ error: "We couldn't find that address. Try adding more detail, or a nearby intersection." }, { status: 404 });
    return Response.json(place);
  } catch {
    // Never log the request: it holds the resident's address.
    return Response.json({ error: "The map lookup isn't answering. Please try again." }, { status: 502 });
  }
}
