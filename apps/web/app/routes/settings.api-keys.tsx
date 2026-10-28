import { useState } from "react";
import { Form, redirect, useActionData, Link } from "react-router";
import type { Route } from "./+types/settings.api-keys";
import { createSupabaseServerClient } from "../lib/supabase.server";
import { generateApiKey, hashApiKey } from "../api/lib/api-key";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/ui/page-header";
import { SectionHeading } from "../components/ui/section-heading";
import { Trash2 } from "lucide-react";
import { cn, formatDate } from "../lib/utils";
import { siteName } from "../lib/site-name";

const CARD = "rounded-2xl border border-zinc-200 bg-surface shadow-sm";

interface ApiKey {
  id: string;
  key_prefix: string;
  is_active: boolean;
  created_at: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw redirect("/login?redirectTo=/settings/api-keys", { headers });
  }

  const { data: keys, error } = await supabase
    .from("api_keys")
    .select("id, key_prefix, is_active, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to fetch API keys:", error);
  }

  return { keys: (keys ?? []) as ApiKey[], user };
}

export async function action({ request }: Route.ActionArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    throw redirect("/login?redirectTo=/settings/api-keys", { headers });
  }

  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "create_key") {
    // Check active key count
    const { count, error: countError } = await supabase
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_active", true);

    if (countError) {
      return { error: "Failed to check existing keys. Please try again." };
    }

    if ((count ?? 0) >= 3) {
      return {
        error:
          "Maximum 3 active API keys allowed. Revoke an existing key to create a new one.",
      };
    }

    const plainKey = generateApiKey();
    const keyHash = await hashApiKey(plainKey);
    const prefix = plainKey.substring(0, 8); // "vr_xxxxx"

    const { error: insertError } = await supabase.from("api_keys").insert({
      user_id: user.id,
      key_hash: keyHash,
      key_prefix: prefix,
      name: "Default",
      is_active: true,
    });

    if (insertError) {
      return { error: "Failed to create API key. Please try again." };
    }

    return { newKey: plainKey, prefix, success: true };
  }

  if (intent === "revoke_key") {
    const keyId = formData.get("key_id") as string;

    if (!keyId) {
      return { error: "Missing key ID." };
    }

    const { error: revokeError } = await supabase
      .from("api_keys")
      .update({ is_active: false })
      .eq("id", keyId)
      .eq("user_id", user.id);

    if (revokeError) {
      return { error: "Failed to revoke key. Please try again." };
    }

    return { success: true, revoked: true };
  }

  return { error: "Unknown action." };
}

export default function ApiKeysPage({
  loaderData,
}: Route.ComponentProps) {
  const { keys } = loaderData;
  const actionData = useActionData<typeof action>();
  const [showNewKey, setShowNewKey] = useState(true);
  const [copied, setCopied] = useState(false);
  const [revokeKeyId, setRevokeKeyId] = useState<string | null>(null);

  const activeKeys = keys.filter((k) => k.is_active);
  const revokedKeys = keys.filter((k) => !k.is_active);
  const activeCount = activeKeys.length;

  async function copyKey(key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select text for manual copy
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-2xl px-4 py-12">
        <Link
          to="/settings"
          className="mb-4 inline-block text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-800"
        >
          ← Settings
        </Link>

        <PageHeader
          title="API keys"
          description={`Create and manage keys for the ${siteName()} API.`}
        />

        {/* Error Message */}
        {actionData && "error" in actionData && (
          <div
            role="alert"
            className="mb-6 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700"
          >
            {actionData.error}
          </div>
        )}

        {actionData && "revoked" in actionData && actionData.revoked && (
          <div
            role="status"
            className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800"
          >
            Key revoked. It will no longer work.
          </div>
        )}

        {/* New Key Reveal */}
        {actionData &&
          "newKey" in actionData &&
          actionData.newKey &&
          showNewKey && (
            <section
              role="status"
              className="mb-8 space-y-4 rounded-2xl border border-amber-300 bg-amber-50 p-5 sm:p-6"
            >
              <div className="space-y-1">
                <h2 className="text-base font-bold text-amber-950">
                  Your new API key
                </h2>
                <p className="text-sm text-amber-800">
                  Copy it now and keep it somewhere safe. For security we only
                  show it once.
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                <code className="flex-1 select-all break-all rounded-lg border border-amber-200 bg-surface px-4 py-3 font-mono text-sm text-zinc-900">
                  {actionData.newKey}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => copyKey(actionData.newKey as string)}
                  className="h-auto min-h-10 flex-shrink-0 bg-surface"
                  aria-live="polite"
                >
                  {copied ? "Copied" : "Copy key"}
                </Button>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowNewKey(false)}
                className="-ml-3 text-amber-800 hover:bg-amber-100 hover:text-amber-950"
              >
                I've saved it, dismiss
              </Button>
            </section>
          )}

        <div className="space-y-10">
          {/* Active Keys */}
          <section>
            <SectionHeading
              title="Active keys"
              description={
                <span className="tabular-nums">
                  {activeCount} of 3 keys in use
                </span>
              }
              action={
                <Form method="post">
                  <input type="hidden" name="intent" value="create_key" />
                  <Button
                    type="submit"
                    disabled={activeCount >= 3}
                    className="bg-brand-600 text-white hover:bg-brand-700"
                  >
                    Create key
                  </Button>
                </Form>
              }
            />

            {activeCount >= 3 && (
              <p className="mb-3 text-sm text-zinc-500">
                You've reached the limit. Revoke a key to create a new one.
              </p>
            )}

            {activeKeys.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                No active keys. Create one to start using the {siteName()} API.
              </div>
            ) : (
              <ul className={cn(CARD, "divide-y divide-zinc-100")}>
                {activeKeys.map((key) => (
                  <li key={key.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <code className="font-mono text-sm text-zinc-900">
                        {key.key_prefix}…
                      </code>
                      <p className="text-xs text-zinc-500">
                        Created {formatDate(key.created_at.slice(0, 10))}
                      </p>
                    </div>
                    <Badge variant="success">Active</Badge>
                    <Dialog
                      open={revokeKeyId === key.id}
                      onOpenChange={(open) =>
                        setRevokeKeyId(open ? key.id : null)
                      }
                    >
                      <DialogTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-zinc-400 hover:bg-red-50 hover:text-red-600"
                          aria-label={`Revoke key ${key.key_prefix}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Revoke this key?</DialogTitle>
                          <DialogDescription>
                            <code className="font-mono">{key.key_prefix}…</code>{" "}
                            will stop working immediately, and any apps using
                            it will lose access. This can't be undone.
                          </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setRevokeKeyId(null)}
                          >
                            Cancel
                          </Button>
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="revoke_key"
                            />
                            <input
                              type="hidden"
                              name="key_id"
                              value={key.id}
                            />
                            <Button
                              type="submit"
                              variant="destructive"
                              onClick={() => setRevokeKeyId(null)}
                            >
                              Revoke key
                            </Button>
                          </Form>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Revoked Keys */}
          {revokedKeys.length > 0 && (
            <section>
              <SectionHeading title="Revoked keys" />
              <ul className={cn(CARD, "divide-y divide-zinc-100")}>
                {revokedKeys.map((key) => (
                  <li key={key.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <code className="font-mono text-sm text-zinc-500 line-through decoration-zinc-300">
                        {key.key_prefix}…
                      </code>
                      <p className="text-xs text-zinc-400">
                        Created {formatDate(key.created_at.slice(0, 10))}
                      </p>
                    </div>
                    <Badge variant="muted">Revoked</Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Info Section */}
          <section>
            <SectionHeading title="Using your key" />
            <div className={cn(CARD, "space-y-3 p-5 text-sm text-zinc-600 sm:p-6")}>
              <p>
                Send your key in the{" "}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs">
                  X-API-Key
                </code>{" "}
                header, or as an{" "}
                <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs">
                  ?apikey=
                </code>{" "}
                query parameter.
              </p>
              <p>
                Endpoints and examples are in the{" "}
                <Link
                  to="/api/v1/docs"
                  className="font-medium text-brand-700 hover:underline"
                >
                  API documentation
                </Link>
                .
              </p>
              <p className="text-zinc-500">
                Keys are rate-limited. Requests over the limit return a 429
                status. Get in touch if you need a higher limit.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
