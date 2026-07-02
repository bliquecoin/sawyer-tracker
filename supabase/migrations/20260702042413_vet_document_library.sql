create table if not exists public.sawyer_vet_documents (
  household_id uuid not null references public.sawyer_households(id) on delete cascade,
  id uuid not null,
  dog_id text not null default 'sawyer',
  storage_path text not null,
  file_name text not null,
  content_type text not null default 'application/pdf',
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  category text not null default 'other',
  document_date date,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (household_id, id),
  unique (storage_path)
);

create index if not exists sawyer_vet_documents_household_date_idx
  on public.sawyer_vet_documents (household_id, document_date desc, created_at desc);

alter table public.sawyer_vet_documents enable row level security;

grant select on public.sawyer_vet_documents to anon, authenticated;

drop policy if exists "sawyer household can read vet documents" on public.sawyer_vet_documents;
create policy "sawyer household can read vet documents"
  on public.sawyer_vet_documents
  for select
  to anon, authenticated
  using ((select private.sawyer_can_access_household(household_id)));

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'sawyer-vet-documents',
  'sawyer-vet-documents',
  false,
  20971520,
  array['application/pdf']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
