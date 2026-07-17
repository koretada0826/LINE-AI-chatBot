-- ============================================================
-- マイグレーション⑤：相手を"どんどん学ぶ"構造化プロフィール
-- user_profiles に profile(jsonb) を追加。AIが会話のたびに積み上げて更新する。
-- （narrative/concerns/context/watch_points/hopes/follow_ups を保持）
-- ============================================================
alter table user_profiles add column if not exists profile jsonb not null default '{}'::jsonb;

-- 参考: 蓄積したプロフィールを見る
-- select line_user_id, profile, updated_at from user_profiles order by updated_at desc;
