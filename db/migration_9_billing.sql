-- ============================================================
-- migration_9_billing : 請求（課金）モジュール
-- Notion単価表の3階建てを算出する土台。
--   ① 月額基本料 50,000円/月          … 固定（コード定数）
--   ② 社員従量   500円/人・月          … 登録社員数から自動算出
--   ③ セッション従量（面談/レポート等） … 都度発生。この billing_items に積む
-- ①②はデータから自動計算。③はメニューごとに1行ずつ積み上げる（手入力 or 将来Spir連携）。
-- ============================================================

-- 会社ごとの請求上書き設定（未設定なら code のデフォルト定数を使う）
alter table companies add column if not exists billing_config jsonb not null default '{}'::jsonb;
-- 例: {"base_monthly": 50000, "per_employee": 500}  ← 個別契約で上書きしたい時だけ入れる

-- ③ セッション従量の明細（面談・レポート・研修・チャット稼働 等）
create table if not exists billing_items (
  id            bigint generated always as identity primary key,
  company_id    bigint references companies (id) not null,
  billing_month date   not null,               -- 対象月（月初日。例 2026-07-01）
  menu          text   not null,               -- メニュー名（個別面談/経営フィードバック/研修 等）
  qty           numeric not null default 1,     -- 人数・回数・時間など
  unit_price    numeric not null,               -- 単価（円）Notion単価表より
  amount        numeric generated always as (qty * unit_price) stored, -- 小計＝qty×unit_price
  priority      text,                           -- 低/中/高（時間単価の根拠。任意）
  note          text,                           -- 備考（誰が何分対応 等。個人名は入れない運用）
  created_at    timestamptz not null default now()
);
create index if not exists idx_billing_items_company_month
  on billing_items (company_id, billing_month);

-- RLS（サービスロールのみ。他テーブルと同方針でガチガチに）
alter table billing_items enable row level security;

-- 参考：手入力の例（面談5名×6,000円を2026年7月分としてA社(company_id=1)に計上）
-- insert into billing_items (company_id, billing_month, menu, qty, unit_price, priority, note)
-- values (1, '2026-07-01', '個別面談セッション', 5, 6000, '中', '初期全社員面談の一部');
