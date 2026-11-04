-- One row per schema object in the public schema (plus the extensions list), for comparing the
-- local database with production. Read-only. Used by scripts/local-db/check-parity.sh.
select * from (
  select 'ext ' || extname || ' in ' || extnamespace::regnamespace from pg_extension
  union all
  select 'col ' || c.table_name || '.' || c.column_name || ' ' || c.data_type
         || case when c.data_type = 'USER-DEFINED' then '(' || c.udt_name || ')' else '' end
         || case when c.is_nullable = 'NO' then ' not null' else '' end
         || coalesce(' default ' || c.column_default, '')
         || case when c.is_generated = 'ALWAYS' then ' generated ' || coalesce(c.generation_expression, '') else '' end
    from information_schema.columns c
    join pg_class t on t.relname = c.table_name and t.relnamespace = 'public'::regnamespace and t.relkind in ('r','p','v','m')
   where c.table_schema = 'public'
  union all
  select 'rel ' || relname || ' kind=' || relkind::text || ' rls=' || relrowsecurity
    from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p','v','m','S')
  union all
  select 'con ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
    from pg_constraint where connamespace = 'public'::regnamespace and conrelid <> 0
  union all
  select 'idx ' || indexdef from pg_indexes where schemaname = 'public'
  union all
  select 'fn ' || p.oid::regprocedure || ' -> ' || pg_get_function_result(p.oid)
         || ' secdef=' || p.prosecdef || coalesce(' cfg=' || array_to_string(p.proconfig, ','), '')
    from pg_proc p left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
   where p.pronamespace = 'public'::regnamespace and d.objid is null
  union all
  select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',')
         || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '')
    from pg_policies where schemaname = 'public'
  union all
  select 'trg ' || tgrelid::regclass || ' ' || tgname || ' ' || tgfoid::regproc
    from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
  union all
  select 'typ ' || t.typname || ' ' || coalesce((select string_agg(enumlabel, ',' order by enumsortorder) from pg_enum e where e.enumtypid = t.oid), '')
    from pg_type t where t.typnamespace = 'public'::regnamespace and t.typtype in ('e','d','c')
     and not exists (select 1 from pg_class c where c.reltype = t.oid)
     and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e')
  union all
  select 'grant ' || table_name || ' ' || grantee || ' ' || string_agg(privilege_type, ',' order by privilege_type)
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon','authenticated','service_role')
   group by table_name, grantee
) x(line) order by 1;
