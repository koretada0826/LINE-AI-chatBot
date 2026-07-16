// ============================================================
// 会話記憶・相談ログの保存（Supabase）
// 深掘りヒアリングには「過去の会話」が必要なため、ユーザーごとに履歴を持つ。
// Supabaseの環境変数が未設定でも動くよう、インメモリにフォールバックする
// （※インメモリはサーバー再起動で消える。動作確認用。本番はSupabase必須）
// ============================================================
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HISTORY_LIMIT = 20; // 直近何ターンをAIに渡すか

const supabase =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// インメモリのフォールバック
const memHistory = new Map(); // userId -> [{role, content}]
const memUserMemory = new Map(); // userId -> string（長期メモ）

// 直近の会話履歴を取得（古い順）
export async function getHistory(userId) {
  if (!supabase) return memHistory.get(userId) ?? [];
  const { data, error } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("line_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) {
    console.error("getHistory error:", error.message);
    return [];
  }
  return (data ?? []).reverse().map((r) => ({ role: r.role, content: r.content }));
}

// 1発言を履歴に追記
export async function appendTurn(userId, role, content) {
  if (!supabase) {
    const arr = memHistory.get(userId) ?? [];
    arr.push({ role, content });
    memHistory.set(userId, arr.slice(-HISTORY_LIMIT));
    return;
  }
  const { error } = await supabase
    .from("conversations")
    .insert({ line_user_id: userId, role, content });
  if (error) console.error("appendTurn error:", error.message);
}

// 相談ログ（対応区分・リスク・要約）を保存
export async function logConsultation(userId, result) {
  if (!supabase) return; // フォールバック時はログ保存なし
  const { error } = await supabase.from("consultation_logs").insert({
    line_user_id: userId,
    category: result.category,
    risk_level: result.risk_level,
    topic: result.topic,
    summary: result.summary,
    escalated: result.escalate,
  });
  if (error) console.error("logConsultation error:", error.message);
}

// --- 継続学習ループ ---

// 相手の長期メモを取得（会話を重ねるほど賢くなる土台）
export async function getUserMemory(userId) {
  if (!supabase) return memUserMemory.get(userId) ?? "";
  const { data, error } = await supabase
    .from("user_profiles")
    .select("memory")
    .eq("line_user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("getUserMemory error:", error.message);
    return "";
  }
  return data?.memory ?? "";
}

// 相手の長期メモを更新（AIが書き直した全文で上書き）
export async function saveUserMemory(userId, memory) {
  if (!memory) return; // 空なら更新しない
  if (!supabase) {
    memUserMemory.set(userId, memory);
    return;
  }
  const { error } = await supabase
    .from("user_profiles")
    .upsert(
      { line_user_id: userId, memory, updated_at: new Date().toISOString() },
      { onConflict: "line_user_id" }
    );
  if (error) console.error("saveUserMemory error:", error.message);
}

// ナレッジで扱いきれなかった論点を記録（ナレッジ育成の材料）
export async function logCoverageGap(userId, result) {
  if (!supabase || !result.coverage_gap) return;
  const { error } = await supabase.from("learned_patterns").insert({
    line_user_id: userId,
    topic: result.topic,
    gap: result.coverage_gap,
    summary: result.summary,
  });
  if (error) console.error("logCoverageGap error:", error.message);
}

// --- 緊急ハンドオフ（人へつなぐ） ---

// エスカレーション記録を残す（対応漏れ防止・SLA管理）
export async function logEscalation(userId, result) {
  if (!supabase) return;
  const { error } = await supabase.from("escalations").insert({
    line_user_id: userId,
    risk_level: result.risk_level,
    topic: result.topic,
    summary: result.summary,
    status: "open",
  });
  if (error) console.error("logEscalation error:", error.message);
}

// 有人テイクオーバー：一定時間、Botの自動応答を止めて人が対応するモード
const HUMAN_MODE_HOURS = Number(process.env.HUMAN_MODE_HOURS || 12);
const memHumanUntil = new Map(); // userId -> epoch ms

export async function setHumanMode(userId) {
  const until = new Date(Date.now() + HUMAN_MODE_HOURS * 3600 * 1000);
  if (!supabase) {
    memHumanUntil.set(userId, until.getTime());
    return;
  }
  const { error } = await supabase
    .from("user_profiles")
    .upsert(
      { line_user_id: userId, human_mode_until: until.toISOString() },
      { onConflict: "line_user_id" }
    );
  if (error) console.error("setHumanMode error:", error.message);
}

export async function isHumanMode(userId) {
  if (!supabase) {
    const until = memHumanUntil.get(userId);
    return !!until && Date.now() < until;
  }
  const { data, error } = await supabase
    .from("user_profiles")
    .select("human_mode_until")
    .eq("line_user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("isHumanMode error:", error.message);
    return false;
  }
  return !!data?.human_mode_until && Date.now() < Date.parse(data.human_mode_until);
}
