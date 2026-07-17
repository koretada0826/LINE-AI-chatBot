// ============================================================
// レポートAPI（トークン保護）
// 例: /api/report?token=XXX&format=html&since=30
//   format: html（社長向け画面・既定）/ csv（スプシ用）/ text（短文）/ json
//   since : 直近N日に絞る（例 30=月次）。未指定なら全期間
//   token : 会社のreport_token（自社のみ）／運営のREPORT_ACCESS_TOKEN（company_idで全社）
// ============================================================
import {
  generateReport,
  reportToCsv,
  reportToText,
  reportToHtml,
} from "../lib/report.js";
import { getCompanyByReportToken, getCompany } from "../lib/tenant.js";

const REPORT_TOKEN = process.env.REPORT_ACCESS_TOKEN; // 運営マスタ（全社閲覧）

export default async function handler(req, res) {
  const token =
    req.query?.token || (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).send("Unauthorized");

  const isMaster = REPORT_TOKEN && token === REPORT_TOKEN;
  let companyId = req.query?.company_id ? Number(req.query.company_id) : null;
  let companyName = "";

  if (!isMaster) {
    // 会社トークン → その会社に強制スコープ（company_idを差し替えても他社は見えない）
    const company = await getCompanyByReportToken(token);
    if (!company) return res.status(401).send("Unauthorized");
    companyId = company.id; // ★A社トークンではA社の集計しか返さない
    companyName = company.name || "";
  } else if (companyId) {
    const c = await getCompany(companyId);
    companyName = c?.name || "";
  }

  const format = req.query?.format || "html";
  const sinceDays = req.query?.since ? Number(req.query.since) : null;
  const periodLabel = sinceDays ? `直近${sinceDays}日` : "全期間";

  const rep = await generateReport(companyId, sinceDays);
  if (!rep) return res.status(500).send("report unavailable (Supabase未接続の可能性)");

  if (format === "html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(reportToHtml(rep, companyName, periodLabel));
  }
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="report.csv"');
    return res.status(200).send(reportToCsv(rep));
  }
  if (format === "text") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(reportToText(rep));
  }
  return res.status(200).json(rep);
}
