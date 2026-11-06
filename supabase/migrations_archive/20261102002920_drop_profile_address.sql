-- Typed addresses are no longer used (apps/web/app/lib/saved-place.ts). The few saved before were
-- converted to rounded points and street names, so this removes the addresses for good.
update public.user_profiles set address = null where address is not null;
alter table public.user_profiles drop column if exists address;
