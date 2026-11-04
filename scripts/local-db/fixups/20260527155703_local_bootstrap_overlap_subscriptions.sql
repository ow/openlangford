-- LOCAL ONLY. bootstrap.sql already adds subscriptions_unique_target; 20260527155704_43_01 adds it again
-- (its duplicate_object handler doesn't catch the duplicate index name). Drop it so the migration re-adds it.
ALTER TABLE IF EXISTS public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_unique_target;
