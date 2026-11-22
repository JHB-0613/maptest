-- 회원 탈퇴 기능 (2026-11-23). schema.sql·002·003을 실행한 프로젝트에 추가로 한 번 실행
-- SQL Editor → New query → 전체 붙여넣고 Run
--
-- 브라우저용 키(Publishable)로는 계정(auth.users)을 지울 수 없어서, 로그인한 본인만 부를 수 있는 함수를 만든다.
-- 계정을 지우면 외래키(on delete cascade)로 그 사람의 프로필·핀·즐겨찾기·메모가 함께 지워지고,
-- 다른 사람이 그 핀을 즐겨찾기한 기록도 지워지며, 다른 사람 메모의 '관련 핀'은 비워진다.
-- 사진 파일(Storage)은 SQL로 직접 지울 수 없어서, 앱이 이 함수를 부르기 전에 자기 폴더 파일을 먼저 지운다.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception '로그인이 필요해요.' using errcode = '42501';
  end if;
  delete from auth.users where id = uid;   -- 본인 계정만 (다른 id는 지정할 수 없음)
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
