import { redirect } from "react-router";
import { requireModerator } from "../lib/auth.server";

const destinations: Record<string, string> = {
  "/admin-pipeline": "/admin/pipeline",
  "/admin-matters": "/admin/matters",
};

export async function loader({ request }: { request: Request }) {
  await requireModerator(request);
  const url = new URL(request.url);
  const destination = destinations[url.pathname.replace(/\/+$/, "")];
  if (!destination) throw new Response("Not found", { status: 404 });
  return redirect(destination + url.search, { headers: { "Cache-Control": "private, no-store" } });
}

export async function action({ request }: { request: Request }) {
  await requireModerator(request);
  throw new Response("Use the canonical admin page.", { status: 405, headers: { Allow: "GET" } });
}
