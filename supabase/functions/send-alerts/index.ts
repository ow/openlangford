/** Server-key-only per-meeting queue/dispatch. Default mode is off. No pre-meeting/weekly sends. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.90.1";
import { createAlertHandler } from "../_shared/alerts.ts";
const client = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
Deno.serve(
  createAlertHandler(
    {
      ALERT_WORKER_KEY: Deno.env.get("ALERT_WORKER_KEY"),
      ALERT_DELIVERY_MODE: Deno.env.get("ALERT_DELIVERY_MODE"),
      ALERT_START_DATE: Deno.env.get("ALERT_START_DATE"),
      ALERT_TEST_RECIPIENT: Deno.env.get("ALERT_TEST_RECIPIENT"),
      RESEND_API_KEY: Deno.env.get("RESEND_API_KEY"),
    },
    async (name, args) => await client.rpc(name, args),
  ),
);
