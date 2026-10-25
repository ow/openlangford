/** Public transport, but every event requires a fresh raw-body Resend/Svix signature. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { createEmailEventHandler } from "../_shared/email-events.ts";
const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
Deno.serve(
  createEmailEventHandler(
    Deno.env.get("RESEND_WEBHOOK_SECRET"),
    async (name, args) => await client.rpc(name, args),
  ),
);
