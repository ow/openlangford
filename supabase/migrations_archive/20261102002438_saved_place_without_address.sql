-- Residents' places for nearby alerts: keep a map point rounded to about a block and the street
-- name, never the typed address (apps/web/app/lib/saved-place.ts).
--
-- The web app no longer reads or writes user_profiles.address. A later migration drops it, once the
-- few addresses already saved have been converted to rounded points.

alter table public.user_profiles add column if not exists location_label text;

update public.user_profiles
set location_lat = round(location_lat::numeric, 3)::double precision,
    location_lng = round(location_lng::numeric, 3)::double precision
where location_lat is not null or location_lng is not null;

-- The web app now writes the point directly (own-row RLS); keep the old RPC but round what it stores.
create or replace function public.update_user_location(
  target_user_id uuid,
  lng double precision,
  lat double precision
)
returns void
language sql
security invoker
set search_path = 'public'
as $$
  update user_profiles
  set location_lng = round(lng::numeric, 3)::double precision,
      location_lat = round(lat::numeric, 3)::double precision
  where id = target_user_id;
$$;

comment on column public.user_profiles.location_lat is 'Rounded to 3 decimals (about a block). The typed address is never stored.';
comment on column public.user_profiles.location_lng is 'Rounded to 3 decimals (about a block). The typed address is never stored.';
comment on column public.user_profiles.location_label is 'Street name only, no house number.';
