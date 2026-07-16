-- ============================================================
-- 才職CARE AI相談ボット Supabaseスキーマ（第一弾）
-- Supabase の SQL Editor に貼って実行する
-- ============================================================

-- 会話履歴（深掘りヒアリングのための記憶）
create table if not exists conversations (
  id           bigint generated always as identity primary key,
  line_user_id text not null,
  role         text not null check (role in ('user', 'assistant')),
  content      text not null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_conversations_user on conversations (line_user_id, created_at);

-- 相談ログ（匿名集計・レポートの元データ）
create table if not exists consultation_logs (
  id           bigint generated always as identity primary key,
  line_user_id text not null,
  category     text not null,   -- ai_only / mentor_normal / mentor_caution / escalation / admin_broadcast / onboarding / other
  risk_level   int  not null,   -- 0..3
  topic        text,
  summary      text,
  escalated    boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists idx_logs_user on consultation_logs (line_user_id, created_at);
create index if not exists idx_logs_category on consultation_logs (category, created_at);

-- 継続学習：相手ごとの長期メモ（会話を重ねるほど賢くなる土台）
create table if not exists user_profiles (
  line_user_id     text primary key,
  memory           text,               -- AIが更新し続ける、この相手の要点
  human_mode_until timestamptz,         -- 有人テイクオーバー中の期限（緊急ハンドオフ）
  updated_at       timestamptz not null default now()
);

-- 緊急ハンドオフ：エスカレーション記録（対応漏れ防止・SLA管理）
create table if not exists escalations (
  id           bigint generated always as identity primary key,
  line_user_id text not null,
  risk_level   int,
  topic        text,
  summary      text,
  status       text not null default 'open',  -- open / in_progress / resolved
  created_at   timestamptz not null default now()
);
create index if not exists idx_escalations_status on escalations (status, created_at);

-- 継続学習：ナレッジで扱いきれなかった論点（ナレッジ育成の材料）
create table if not exists learned_patterns (
  id           bigint generated always as identity primary key,
  line_user_id text,
  topic        text,
  gap          text,               -- 扱いづらかった論点
  summary      text,
  reviewed     boolean not null default false,  -- 運営がナレッジへ反映したか
  created_at   timestamptz not null default now()
);

-- LINEアクセストークンの保存（自動更新：期限が近づくとBotが自動で再発行して上書き）
create table if not exists line_tokens (
  channel_id text primary key,
  token      text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

-- ↓↓↓ 次フェーズ（テナント分離・オンボーディング）で使う土台。今は作るだけでOK ↓↓↓

-- 企業マスタ（テナント分離の起点）
create table if not exists companies (
  id             bigint generated always as identity primary key,
  name           text not null,
  invite_code    text unique not null,   -- 企業ごとの登録コード（会社特定に使う）
  plan           text,
  created_at     timestamptz not null default now()
);

-- 社員（LINEユーザーと企業の紐づけ）
create table if not exists employees (
  id           bigint generated always as identity primary key,
  line_user_id text unique not null,
  company_id   bigint references companies (id),
  name         text,
  role_title   text,
  status       text not null default 'active',
  registered   boolean not null default false,  -- オンボーディング完了フラグ
  created_at   timestamptz not null default now()
);
