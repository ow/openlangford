import type { SupabaseClient } from "@supabase/supabase-js";

export type AccountDeletionSummary = {
  emails_anonymized: number;
  suppressions_deleted: number;
  subscriptions_deleted: number;
  api_keys_deleted: number;
  profiles_deleted: number;
};

/**
 * Deletes an account and everything personal tied to it. Needs the service-role client.
 * `delete_account_data` removes the profile (address, location, alert settings), follows and
 * keyword alerts, API keys and unsubscribe records, and strips the address from email logs while
 * keeping delivery counts; then the sign-in itself is deleted. Safe to retry if the second step fails.
 */
export async function deleteAccount(admin: SupabaseClient, userId: string): Promise<AccountDeletionSummary> {
  const { data, error } = await admin.rpc("delete_account_data", { p_user_id: userId });
  if (error) throw new Error(`Account data deletion failed: ${error.message}`);
  const { error: authError } = await admin.auth.admin.deleteUser(userId);
  if (authError) throw new Error(`Account sign-in deletion failed: ${authError.message}`);
  return data as AccountDeletionSummary;
}
