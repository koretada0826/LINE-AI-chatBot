-- ============================================================
-- migration_7_mentors.sql
-- メンター（相談相手）のマスタと、企業ごとの担当メンター割当（例：3名）。
-- 「才職事業部 メンバー一覧」スプレッドシートを元にDB化。データは変わる前提。
-- ============================================================

create table if not exists mentors (
  id           bigint generated always as identity primary key,
  display_name text not null,          -- HP/LINEに出す表示名（本名・あだ名可）
  tags         text[] default '{}',    -- 特徴タグ（戦略思考／寄り添い 等）
  industries   text,                   -- 経験業界（カンマ区切り文字列）
  tagline      text,                   -- 一言メッセージ・アピール
  avatar_url   text,                   -- 顔写真URL（後で差し込み。無ければ頭文字アイコン）
  accent_color text default '#2f6fb0', -- カードのアクセントカラー
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

-- セキュリティ：RLS有効（service_roleのみバイパスで利用）
alter table mentors         enable row level security;
alter table company_mentors enable row level security;
grant all on table mentors         to service_role;
grant all on table company_mentors to service_role;

-- ============================================================
-- シード（スプレッドシートから4名。企業番号2630=Uniboostに3名割当）
-- ※データは変わる前提。運営がここを差し替えて運用。
-- ============================================================
insert into mentors (display_name, tags, industries, tagline, accent_color) values
  ('坂田真有',   array['フレンドリー','冷静沈着'],           '人材, 店舗経営, アパレル, 美容, 営業', 'キャリアも恋愛も、“自分らしい選択”ができるように。人材業界と経営の経験、占いの視点から、あなたのモヤモヤを一緒に整理しましょう！', '#E8734A'),
  ('朝日田 果南', array['戦略思考','頭の整理','圧倒的味方'],   '行政, 人材, 美容, コンサル, 営業',       '「このままでいいのかな？」を、一緒に整理する壁打ち相手です。公務員→ベンチャー執行役員→独立まで経験しました。', '#2F6FB0'),
  ('Kiko',       array['圧倒的味方','寄り添いタイプ','活力'], '営業, 金融',                             '貴方の長所を活かしたキャリアとライフを、一緒に見つけていきましょう💐', '#3AAE8C'),
  ('寺井翠',     array['戦略思考','フレンドリー','活力'],     '店舗経営, 保険, 営業',                   '大手も独立も経験しました✨ キャリアの選択肢を広げるお手伝いを。気楽に相談してください！', '#B5651D')
on conflict do nothing;

-- 2630（Uniboost）に先頭3名を割当
insert into company_mentors (company_id, mentor_id, sort_order)
select c.id, m.id, m.id
from companies c
join mentors m on m.display_name in ('坂田真有','朝日田 果南','Kiko')
where c.invite_code = '2630'
on conflict do nothing;
