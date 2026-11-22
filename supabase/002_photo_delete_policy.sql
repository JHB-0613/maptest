-- schema.sql을 이미 실행한 프로젝트에 추가로 한 번 실행하는 SQL (2026-11-22)
-- 문제: 핀·메모를 지워도 Storage의 사진 파일이 지워지지 않았다.
-- 원인: Storage는 '읽기(select)' 규칙으로 보이는 파일만 지울 수 있는데, 그 규칙이 없었다 (삭제가 오류 없이 0개로 끝남).
-- 해결: 로그인한 사용자가 자기 폴더(<user id>/...) 파일만 조회할 수 있게 한다. 사진은 공개 주소로 누구나 볼 수 있으므로 노출 범위는 그대로다.
create policy "photos: 본인 폴더 파일 조회" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
