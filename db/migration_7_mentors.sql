-- ============================================================
-- migration_7_mentors.sql
-- メンター（相談相手）のマスタと、企業ごとの担当メンター割当（例：3名）。
-- 「才職事業部 メンバー一覧」スプレッドシートを元にDB化。データは変わる前提。
-- 写真は public/mentors/ に配置し、/mentors/<file>.png で配信（HTTPS必須）。
-- ============================================================

create table if not exists mentors (
  id           bigint generated always as identity primary key,
  display_name text not null,          -- HP/LINEに出す表示名（本名・あだ名可）
  tags         text[] default '{}',    -- 特徴タグ（戦略思考／寄り添い 等）
  industries   text,                   -- 経験業界（カンマ区切り文字列）
  tagline      text,                   -- 一言メッセージ・アピール
  avatar_url   text,                   -- 顔写真URL（無ければ頭文字アイコン）
  accent_color text default '#2f6fb0', -- カードのアクセントカラー
  status       text default 'available', -- 在席: available / busy / offline
  next_available text,                 -- 「◯分後」「18:00以降」等の表示用（任意）
  is_active    boolean default true,
  created_at   timestamptz default now()
);

-- 企業ごとの担当メンター（キックオフで決めた3名など）
create table if not exists company_mentors (
  company_id bigint references companies(id) on delete cascade,
  mentor_id  bigint references mentors(id)  on delete cascade,
  sort_order int default 0,
  primary key (company_id, mentor_id)
);

-- 既存テーブルに列が無い場合の追加（再実行安全）
alter table mentors add column if not exists status text default 'available';
alter table mentors add column if not exists next_available text;
alter table mentors add column if not exists booking_url text; -- Spir等の予約ページURL

-- セキュリティ：RLS有効（service_roleのみバイパスで利用）
alter table mentors         enable row level security;
alter table company_mentors enable row level security;
grant all on table mentors         to service_role;
grant all on table company_mentors to service_role;

-- ============================================================
-- シード：岡本希実 / 坂田真有 / 朝日田 果南（写真つき）。2630=Uniboostに割当。
-- ※データは変わる前提。運営がここを差し替えて運用。
-- ============================================================
insert into mentors (display_name, tags, industries, tagline, avatar_url, accent_color)
select '岡本希実', array['戦略思考','面接のプロ'], '人材, コンサル',
       '戦略的にキャリアを整理し、面接まで一緒に伴走します。',
       'https://line-ai-chat-bot-eosin.vercel.app/mentors/okamoto.png', '#7E6FBF'
where not exists (select 1 from mentors where display_name='岡本希実');

insert into mentors (display_name, tags, industries, tagline, avatar_url, accent_color)
select '坂田真有', array['フレンドリー','冷静沈着'], '人材, 店舗経営, アパレル, 美容, 営業',
       'キャリアも恋愛も、“自分らしい選択”ができるように。占いの視点も交えて、モヤモヤを一緒に整理しましょう！',
       'https://line-ai-chat-bot-eosin.vercel.app/mentors/sakata.png', '#9B6FBF'
where not exists (select 1 from mentors where display_name='坂田真有');

insert into mentors (display_name, tags, industries, tagline, avatar_url, accent_color)
select '朝日田 果南', array['戦略思考','頭の整理','圧倒的味方'], '行政, 人材, 美容, コンサル, 営業',
       '「このままでいいのかな？」を、一緒に整理する壁打ち相手です。公務員→ベンチャー執行役員→独立まで経験しました。',
       'https://line-ai-chat-bot-eosin.vercel.app/mentors/asahida.png', '#3E5AA6'
where not exists (select 1 from mentors where display_name='朝日田 果南');

-- 既存レコードにも写真・色を反映（再実行時の更新）
update mentors set avatar_url='https://line-ai-chat-bot-eosin.vercel.app/mentors/okamoto.png', accent_color='#7E6FBF' where display_name='岡本希実';
update mentors set avatar_url='https://line-ai-chat-bot-eosin.vercel.app/mentors/sakata.png',  accent_color='#9B6FBF' where display_name='坂田真有';
update mentors set avatar_url='https://line-ai-chat-bot-eosin.vercel.app/mentors/asahida.png', accent_color='#3E5AA6' where display_name='朝日田 果南';

-- Spir予約URL（もらった分だけ設定。未提供の人は受付フォールバック）
update mentors set booking_url='https://app.spirinc.com/t/L-gP_tEKlNTmjmIYfvmRh/as/tQRbfA7objY4WHWUOnyYA/confirm' where display_name='岡本希実';

-- 2630（Uniboost）の担当を「岡本・坂田・朝日田」の3名に設定
delete from company_mentors where company_id = (select id from companies where invite_code='2630');
insert into company_mentors (company_id, mentor_id, sort_order)
select (select id from companies where invite_code='2630'), m.id,
       case m.display_name when '岡本希実' then 1 when '坂田真有' then 2 when '朝日田 果南' then 3 end
from mentors m
where m.display_name in ('岡本希実','坂田真有','朝日田 果南');
