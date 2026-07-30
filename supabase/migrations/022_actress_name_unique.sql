-- Required for idempotent CSV dimension synchronization.
create unique index if not exists actresses_name_unique_idx
  on public.actresses (name);
