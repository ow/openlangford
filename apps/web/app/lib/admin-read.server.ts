import { data } from "react-router";
import { requireRole, type StaffRole } from "./auth.server";
import { PRIVATE } from "./cache-policy";

type StaffUser = Awaited<ReturnType<typeof requireRole>>;

export function privateAdminHeaders() {
  return new Headers({
    "Cache-Control": PRIVATE,
    Vary: "Cookie",
    "X-Robots-Tag": "noindex, nofollow",
  });
}

/** Every route calls this itself, including direct React Router data requests. */
export async function adminRead<T>(request: Request, read: (role: StaffRole, user: StaffUser) => Promise<T>, minimum: StaffRole = "moderator") {
  try {
    const user = await requireRole(request, minimum, { record: false });  // reads change nothing
    return data(await read(user.staffRole, user), { headers: privateAdminHeaders() });
  } catch (error) {
    if (error instanceof Response) {
      const headers = new Headers(error.headers);
      privateAdminHeaders().forEach((value, key) => headers.set(key, value));
      throw new Response(error.body, {
        status: error.status,
        statusText: error.statusText,
        headers,
      });
    }
    // Provider errors can contain account details. Do not serialize or log them.
    throw new Response("Admin data is temporarily unavailable.", {
      status: 503,
      headers: privateAdminHeaders(),
    });
  }
}

export async function adminReadOnlyAction({ request }: { request: Request }) {
  return adminRead(request, async () => {
    throw new Response("This page is read-only.", {
      status: 405,
      headers: { Allow: "GET" },
    });
  });
}

export function boundedPage(value: string | null) {
  const page = Number(value ?? "1");
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
    throw new Response("Invalid page.", { status: 400 });
  }
  return page;
}

export function requireUuid(value: string | undefined) {
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Response("Invalid identifier.", { status: 400 });
  }
  return value;
}
