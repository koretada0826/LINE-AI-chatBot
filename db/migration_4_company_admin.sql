-- ============================================================
-- マイグレーション④：企業を簡単に追加（4桁の企業番号を自動生成）
-- 以降、会社追加は「名前＋配信スタイル」を書くだけ。企業番号は自動で振られる。
-- ============================================================

-- 未使用の4桁コードを生成する関数
create or replace function gen_company_code() returns text as $$
declare code text;
begin
  loop
    code := lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from companies where invite_code = code);
  end loop;
  return code;
end;
$$ language plpgsql;

-- invite_code を省略したら自動生成する
alter table companies alter column invite_code set default gen_company_code();

-- ▼▼ 以降、企業追加はこれだけ（invite_code は書かない＝自動で4桁が振られる）▼▼
-- insert into companies (name, push_config) values
--   ('株式会社サンプル',
--    '{"frequency":"weekly","message":"今週、大丈夫ですか？","options":["問題ない","少し不安","相談したい"]}'::jsonb);
--
-- 発行された企業番号を確認:
-- select name, invite_code, push_config from companies order by created_at desc;
