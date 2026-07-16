// ============================================================
// レポートAPI（運営専用・トークン保護）
// 例: /api/report?token=XXX&company_id=1&format=csv
//   format: json（既定）/ csv（スプレッドシート用）/ text（社長向けサマリー）
// ============================================================
import { generateReport, reportToCsv, reportToText } from "../lib/report.js";

const REPORT_TOKEN = process.env.REPORT_ACCESS_TOKEN;

export default async function handler(req, res) {
  // 認証（機微データのため必須）
  const token =
    req.query?.token || (req.headers.authorization || "").replace("Bearer ", "");
  if (!REPORT_TOKEN || token !== REPORT_TOKEN) {
    return res.status(401).send("Unauthorized");
  }

  const companyId = req.query?.company_id ? Number(req.query.company_id) : null;
  const format = req.query?.format || "json";

  const rep = await generateReport(companyId);
  if (!rep) return res.status(500).send("report unavailable (Supabase未接続の可能性)");

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
