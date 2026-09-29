/** Spend: the ledger summed the ways a person asks about money. Months are UTC calendar months. */

export async function tableCosts(db, tableId, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  const [last, mTable, mAll] = await Promise.all([
    db.prepare(`SELECT id, label, budget_micros, spent_micros, status, created_at, finished_at FROM runs WHERE table_id=?1 ORDER BY id DESC LIMIT 1`).bind(tableId).first(),
    db.prepare(`SELECT COALESCE(sum(cost_micros),0) AS s, count(*) AS n FROM ledger WHERE table_id=?1 AND substr(ts,1,7)=?2`).bind(tableId, month).first(),
    db.prepare(`SELECT COALESCE(sum(cost_micros),0) AS s FROM ledger WHERE substr(ts,1,7)=?1`).bind(month).first(),
  ]);
  return { month, last_run: last || null, month_table_micros: mTable.s, month_table_calls: mTable.n, month_all_micros: mAll.s };
}

export async function spendReport(db, now = new Date()) {
  const month = now.toISOString().slice(0, 7);
  const [byProvider, byTable, byMonth, recent] = await Promise.all([
    db.prepare(`SELECT provider, count(*) AS calls, sum(cost_micros) AS micros,
                  sum(CASE WHEN outcome='done' THEN 1 ELSE 0 END) AS hits
                  FROM ledger WHERE substr(ts,1,7)=?1 GROUP BY provider ORDER BY micros DESC, calls DESC`).bind(month).all(),
    db.prepare(`SELECT l.table_id, t.name, count(*) AS calls, sum(l.cost_micros) AS micros FROM ledger l
                  LEFT JOIN tables t ON t.id=l.table_id WHERE substr(l.ts,1,7)=?1 GROUP BY l.table_id ORDER BY micros DESC`).bind(month).all(),
    db.prepare(`SELECT substr(ts,1,7) AS month, sum(cost_micros) AS micros, count(*) AS calls FROM ledger GROUP BY month ORDER BY month DESC LIMIT 12`).all(),
    db.prepare(`SELECT l.ts, l.provider, l.cost_micros, l.outcome, l.note, l.row_id, t.name AS table_name FROM ledger l
                  LEFT JOIN tables t ON t.id=l.table_id ORDER BY l.id DESC LIMIT 100`).all(),
  ]);
  return { month, by_provider: byProvider.results, by_table: byTable.results, by_month: byMonth.results, recent: recent.results };
}
