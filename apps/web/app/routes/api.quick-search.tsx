import type { Route } from "./+types/api.quick-search";
import { quickSearch } from "../services/quick-search.server";
import { PUBLIC_API } from "../lib/cache-policy";

/** GET /api/quick-search?q=… → { matches: QuickMatch[] } (no AI; for typeahead). */
export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get("q") || "";
  try {
    const matches = await quickSearch(q);
    return Response.json(
      { matches },
      { headers: { "Cache-Control": PUBLIC_API } },
    );
  } catch (error) {
    console.error("quick search failed:", error);
    return Response.json({ matches: [] }, { status: 200 });
  }
}
