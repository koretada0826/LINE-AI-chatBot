// ============================================================
// メンター データアクセス（企業ごとの担当メンター）
// ============================================================
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase =
  SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// 企業に割り当てられたメンター一覧（sort_order順）
export async function getCompanyMentors(companyId) {
  if (!supabase || !companyId) return [];
  const { data, error } = await supabase
    .from("company_mentors")
    .select("sort_order, mentors(*)")
    .eq("company_id", companyId)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("getCompanyMentors error:", error.message);
    return [];
  }
  return (data ?? [])
    .map((r) => r.mentors)
    .filter((m) => m && m.is_active !== false);
}

// 単体メンター
export async function getMentor(id) {
  if (!supabase || !id) return null;
  const { data, error } = await supabase.from("mentors").select("*").eq("id", id).single();
  if (error) {
    console.error("getMentor error:", error.message);
    return null;
  }
  return data;
}
