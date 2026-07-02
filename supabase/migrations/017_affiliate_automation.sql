create table if not exists public.affiliate_settings(
  id boolean primary key default true check(id),
  enabled boolean not null default false,
  url_template text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check(url_template is null or (url_template like 'https://%' and position('{product_code}' in url_template)>0))
);
insert into public.affiliate_settings(id) values(true) on conflict do nothing;
alter table public.affiliate_settings enable row level security;
create policy "admin affiliate settings" on public.affiliate_settings for all
  using((auth.jwt()->'app_metadata'->>'role')='admin') with check((auth.jwt()->'app_metadata'->>'role')='admin');

create or replace function public.set_video_affiliate_url()
returns trigger language plpgsql security definer set search_path=public as $$
declare settings affiliate_settings;
begin
  if new.affiliate_url is null then
    select * into settings from affiliate_settings where id=true and enabled=true;
    if settings.url_template is not null then
      new.affiliate_url:=replace(settings.url_template,'{product_code}',new.product_code);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists videos_auto_affiliate on public.videos;
create trigger videos_auto_affiliate before insert or update of product_code,affiliate_url on public.videos
for each row execute function public.set_video_affiliate_url();

create or replace function public.apply_affiliate_template(batch_limit integer default 10000)
returns integer language plpgsql security definer set search_path=public as $$
declare affected integer;settings affiliate_settings;
begin
  if auth.role()<>'service_role' and coalesce(auth.jwt()->'app_metadata'->>'role','')<>'admin' then
    raise exception 'admin role required' using errcode='42501';
  end if;
  select * into settings from affiliate_settings where id=true and enabled=true;
  if settings.url_template is null then return 0; end if;
  with targets as(select id from videos where affiliate_url is null order by id limit least(greatest(batch_limit,1),50000))
  update videos v set affiliate_url=replace(settings.url_template,'{product_code}',v.product_code)
  from targets where v.id=targets.id;
  get diagnostics affected=row_count;
  return affected;
end $$;
grant execute on function public.apply_affiliate_template(integer) to authenticated,service_role;
