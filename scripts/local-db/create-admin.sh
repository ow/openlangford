#!/usr/bin/env bash
# Create (or reset) the LOCAL-ONLY admin account in the local Supabase Auth and grant it the admin role.
# These credentials exist only in the local Docker stack.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
export_local_env
email="${LOCAL_ADMIN_EMAIL:-admin@langford.local}"
password="${LOCAL_ADMIN_PASSWORD:-local-admin-password}"
auth=(-H "apikey: $LOCAL_SERVICE_ROLE_KEY" -H "Authorization: Bearer $LOCAL_SERVICE_ROLE_KEY" -H "Content-Type: application/json")
body="{\"email\":\"$email\",\"password\":\"$password\",\"email_confirm\":true}"
id="$(lpsql -At -c "select id from auth.users where email = '$email'")"
if [ -z "$id" ]; then
  id="$(curl -sf "${auth[@]}" -X POST "$LOCAL_API_URL/auth/v1/admin/users" -d "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
else
  curl -sf "${auth[@]}" -X PUT "$LOCAL_API_URL/auth/v1/admin/users/$id" -d "$body" >/dev/null
fi
lpsql -q -c "insert into public.user_roles (user_id, role) values ('$id', 'admin') on conflict (user_id) do update set role = 'admin'"
echo "Local admin (this machine only): $email / $password"
