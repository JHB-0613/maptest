-- sub note: 로그인·핀·즐겨찾기·메모 저장용 Supabase 스키마
-- 사용법: Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣고 Run (한 번만 실행)
--
-- 권한은 RLS(Row Level Security)로 서버에서 강제한다. 앱 코드가 조작돼도 아래 규칙을 넘을 수 없다.
--   pins      : 누구나(로그인 안 해도) 읽기 / 로그인한 사람만 등록 / 수정·삭제는 등록한 계정만
--   favorites : 자기 즐겨찾기만 읽기·추가·삭제
--   memos     : 자기 메모만 읽기·쓰기 (다른 사람에게 보이지 않음)
--   profiles  : 닉네임은 누구나 읽기(커뮤니티에 작성자 표시) / 자기 것만 수정
--   photos    : 사진 파일은 누구나 보기 / 올리기·지우기는 자기 폴더(<user id>/...)만

-- 1) 프로필 (닉네임) -------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  nickname   text not null check (char_length(nickname) between 1 and 20 and btrim(nickname) <> ''),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "profiles: 누구나 읽기" on public.profiles
  for select using (true);
create policy "profiles: 본인만 수정" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- 가입할 때 입력한 닉네임(raw_user_meta_data.nickname)으로 프로필을 자동으로 만든다
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nickname)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'nickname'), ''), split_part(new.email, '@', 1)), 20)
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) 핀 -------------------------------------------------------------------
create table if not exists public.pins (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references auth.users (id) on delete cascade default auth.uid(),
  -- owner_id가 비어 있는 핀 = 운영자가 SQL로 넣은 공식 핀 (앱에서는 아무도 수정 못 함)
  station     text not null default '강남역',
  floor       text not null check (floor in ('B1', 'B2', 'B3', 'B4')),
  title       text not null check (char_length(title) between 1 and 60),
  category    text not null default '기타' check (char_length(category) <= 30),
  description text not null default '' check (char_length(description) <= 1000),
  -- 좌표 범위 검사 (1e308·Infinity·NaN으로 지도가 깨지는 것 방지). 강남역 모델은 약 X -60~70, Z -120~120
  real_x      double precision not null check (real_x between -200 and 200),
  real_z      double precision not null check (real_z between -200 and 200),
  x2d         integer check (x2d is null or x2d between -1000 and 2000),
  y2d         integer check (y2d is null or y2d between -1000 and 2000),
  photo_url   text check (photo_url is null or char_length(photo_url) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pins_station_idx on public.pins (station);
alter table public.pins enable row level security;

create policy "pins: 누구나 읽기" on public.pins
  for select using (true);
create policy "pins: 로그인한 사람이 자기 이름으로 등록" on public.pins
  for insert to authenticated with check (auth.uid() = owner_id);
create policy "pins: 등록한 계정만 수정" on public.pins
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "pins: 등록한 계정만 삭제" on public.pins
  for delete to authenticated using (auth.uid() = owner_id);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists pins_touch on public.pins;
create trigger pins_touch before update on public.pins
  for each row execute function public.touch_updated_at();

-- 3) 즐겨찾기 --------------------------------------------------------------
create table if not exists public.favorites (
  user_id    uuid not null references auth.users (id) on delete cascade default auth.uid(),
  pin_id     uuid not null references public.pins (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, pin_id)
);
alter table public.favorites enable row level security;

create policy "favorites: 본인 것만 읽기" on public.favorites
  for select to authenticated using (auth.uid() = user_id);
create policy "favorites: 본인 것만 추가" on public.favorites
  for insert to authenticated with check (auth.uid() = user_id);
create policy "favorites: 본인 것만 삭제" on public.favorites
  for delete to authenticated using (auth.uid() = user_id);

-- 4) 메모 (나만 보기) -------------------------------------------------------
create table if not exists public.memos (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade default auth.uid(),
  title      text not null check (char_length(title) between 1 and 60),
  body       text not null default '' check (char_length(body) <= 3000),
  photo_url  text check (photo_url is null or char_length(photo_url) <= 500),
  pin_id     uuid references public.pins (id) on delete set null,   -- 관련 핀 (핀이 지워지면 비워짐)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.memos enable row level security;

create policy "memos: 본인 것만 읽기" on public.memos
  for select to authenticated using (auth.uid() = owner_id);
create policy "memos: 본인 이름으로만 작성" on public.memos
  for insert to authenticated with check (auth.uid() = owner_id);
create policy "memos: 본인 것만 수정" on public.memos
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "memos: 본인 것만 삭제" on public.memos
  for delete to authenticated using (auth.uid() = owner_id);

drop trigger if exists memos_touch on public.memos;
create trigger memos_touch before update on public.memos
  for each row execute function public.touch_updated_at();

-- 4-1) API 접근 권한 (필요한 만큼만) ------------------------------------------
-- 프로젝트 생성 때 'Grant API access to new tables automatically'를 껐어도 동작하도록 명시적으로 준다.
-- 실제로 어떤 행을 읽고 쓸 수 있는지는 위 RLS 규칙이 다시 거른다.
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.pins to anon, authenticated;
grant update (nickname) on public.profiles to authenticated;
-- 소유자가 바꾸면 안 되는 칸(created_at, station, 좌표, id 등)은 쓰지 못하게 칸 단위로만 준다
grant insert (station, floor, title, category, description, real_x, real_z, x2d, y2d, photo_url) on public.pins to authenticated;
grant update (title, category, description, photo_url) on public.pins to authenticated;
grant delete on public.pins to authenticated;
grant select, insert, delete on public.favorites to authenticated;
grant select, delete on public.memos to authenticated;
grant insert (title, body, photo_url, pin_id) on public.memos to authenticated;
grant update (title, body, photo_url, pin_id) on public.memos to authenticated;

-- 5) 사진 저장소 (Storage 버킷 'photos', 공개 읽기) ---------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

create policy "photos: 본인 폴더에만 올리기" on storage.objects
  for insert to authenticated
  -- '<내 user id>/<uuid>.jpg' 한 단계로만 허용 (깊은 폴더·임의 파일명 방지)
  with check (
    bucket_id = 'photos'
    and name ~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$')
  );
-- Storage는 '읽기' 규칙으로 보이는 파일만 지울 수 있다. 이 규칙이 없으면 삭제가 오류 없이 0개로 끝난다
create policy "photos: 본인 폴더 파일 조회" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos: 본인 폴더 파일만 삭제" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- 6) 계정당 개수 제한 (가입 계정 하나로 핀·메모를 무한히 만드는 것 방지) -----------
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
