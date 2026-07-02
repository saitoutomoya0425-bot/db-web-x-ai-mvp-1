drop policy if exists "authenticated_manage_videos" on public.videos;

create policy "admin_manage_videos"
on public.videos for all to authenticated
using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
