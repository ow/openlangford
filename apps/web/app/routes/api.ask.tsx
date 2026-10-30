// Retired: the Ask flow is AI mode on /api/search. This legacy endpoint ran the
// agent and logged every question, answer and client IP, so it now only answers
// 410 Gone and does no model work or logging.
const gone = () =>
  Response.json(
    { error: "This endpoint has been retired. Use /search?mode=ai instead." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );

export function loader() {
  return gone();
}

export function action() {
  return gone();
}
