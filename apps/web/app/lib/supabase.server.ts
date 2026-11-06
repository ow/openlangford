import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import type { TypedSupabaseClient } from './supabase';

export type { TypedSupabaseClient };
import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import { collectAuthCookie } from './auth-cookies.server';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const supabaseAnonKey = process.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("Missing Supabase Service Role credentials (SUPABASE_SECRET_KEY)");
}

// 1. Admin Client (Bypasses RLS) - LAZILY INITIALIZED
let _supabaseAdmin: TypedSupabaseClient | null = null;
export function getSupabaseAdminClient() {
  if (!_supabaseAdmin) {
    _supabaseAdmin = createClient<Database>(supabaseUrl || "", supabaseKey || "");
  }
  return _supabaseAdmin;
}

// 2. Public Server Client (anonymous key only, no request cookies or user session).
// Use this for cacheable public read models so cached results cannot include auth-scoped data.
let _supabasePublic: TypedSupabaseClient | null = null;
export function getSupabasePublicClient() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase URL or Anon Key");
  }
  if (!_supabasePublic) {
    _supabasePublic = createClient<Database>(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return _supabasePublic;
}

// 3. Server Client (Respects RLS, handles Auth cookies)
export function createSupabaseServerClient(request: Request, responseHeaders = new Headers()) {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing Supabase URL or Anon Key");
  }

  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        const cookies = parseCookieHeader(request.headers.get('Cookie') ?? '');
        return cookies.map((c) => ({ name: c.name, value: c.value ?? '' }));
      },
      setAll(cookiesToSet) {
        // A refreshed session's cookies go to the caller's headers and, since most callers drop those, to the
        // worker's per-request collector, which adds them to the response (lib/auth-cookies.server.ts).
        cookiesToSet.forEach(({ name, value, options }) => {
          const cookie = serializeCookieHeader(name, value, options);
          responseHeaders.append('Set-Cookie', cookie);
          collectAuthCookie(cookie);
        });
      },
    },
  });

  return { supabase, headers: responseHeaders };
}
