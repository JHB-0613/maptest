-- schema.sql + 002를 이미 실행한 프로젝트에 추가로 한 번 실행하는 SQL (2026-11-22, 보안 검토 반영)
-- SQL Editor → New query → 전체 붙여넣고 Run

-- 1) 소유자가 바꾸면 안 되는 칸(created_at, station, 좌표, id 등)은 쓰지 못하게 칸 단위로만 권한을 준다
--    예) created_at을 미래로 바꿔 커뮤니티 맨 위에 고정하는 것 방지
revoke insert, update on public.pins from authenticated;
grant insert (station, floor, title, category, description, real_x, real_z, x2d, y2d, photo_url) on public.pins to authenticated;
grant update (title, category, description, photo_url) on public.pins to authenticated;

revoke insert, update on public.memos from authenticated;
grant insert (title, body, photo_url, pin_id) on public.memos to authenticated;
grant update (title, body, photo_url, pin_id) on public.memos to authenticated;

-- 2) 좌표 범위 검사 (1e308·Infinity·NaN 같은 값으로 지도가 깨지는 것 방지). 강남역 모델은 약 X -60~70, Z -120~120
alter table public.pins add constraint pins_real_x_range check (real_x between -200 and 200);
alter table public.pins add constraint pins_real_z_range check (real_z between -200 and 200);
alter table public.pins add constraint pins_xy2d_range check (
  (x2d is null or x2d between -1000 and 2000) and (y2d is null or y2d between -1000 and 2000));

-- 3) 닉네임이 공백만으로 이뤄지지 않게
alter table public.profiles add constraint profiles_nickname_not_blank check (btrim(nickname) <> '');

-- 4) 계정당 개수 제한 (가입 계정 하나로 핀·메모를 무한히 만드는 것 방지)
create or replace function public.enforce_owner_row_limit()
returns trigger language plpgsql set search_path = public as $$
declare
  lim integer := tg_argv[0]::integer;
  n integer;
begin
  execute format('select count(*) from %I.%I where owner_id = $1', tg_table_schema, tg_table_name)
    into n using new.owner_id;
  if n >= lim then
    raise exception '한 계정이 만들 수 있는 개수(%개)를 넘었어요.', lim using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists pins_owner_limit on public.pins;
create trigger pins_owner_limit before insert on public.pins
  for each row execute function public.enforce_owner_row_limit('200');
drop trigger if exists memos_owner_limit on public.memos;
create trigger memos_owner_limit before insert on public.memos
  for each row execute function public.enforce_owner_row_limit('500');

-- 5) 사진 업로드 경로를 '<내 user id>/<uuid>.jpg' 한 단계로만 허용 (깊은 폴더·임의 파일명 방지)
drop policy if exists "photos: 본인 폴더에만 올리기" on storage.objects;
create policy "photos: 본인 폴더에만 올리기" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'photos'
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$')
  );
