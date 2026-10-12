#!/usr/bin/env bash
# Exercises every endpoint with curl. Usage: scripts/verify.sh [base_url]
B=${1:-http://localhost:3000}; P=${ADMIN_PASSWORD:-admin123}; pass=0; fail=0
chk(){ local name=$1 want=$2; shift 2; local out code; out=$(curl -s -w '\n%{http_code}' "$@"); code=${out##*$'\n'}; BODY=${out%$'\n'*}
  if [ "$code" = "$want" ]; then pass=$((pass+1)); echo "PASS $code $name"; else fail=$((fail+1)); echo "FAIL $code (want $want) $name: $BODY"; fi; }
J=(-H 'Content-Type: application/json'); TMPX=$(mktemp)
chk "GET / (UI)" 200 $B/; echo "$BODY" | grep -q 'Loan Dashboard' || { echo "FAIL UI content"; fail=$((fail+1)); }
chk "GET chart.js asset" 200 -o /dev/null $B/vendor/chart.js/chart.umd.js
chk "GET /api/health" 200 $B/api/health
chk "GET /api/summary unauth" 401 $B/api/summary
chk "POST /api/login bad" 401 "${J[@]}" -d '{"username":"admin","password":"nope"}' $B/api/login
chk "POST /api/login" 200 "${J[@]}" -d "{\"username\":\"admin\",\"password\":\"$P\"}" $B/api/login
T=$(echo "$BODY" | sed -E 's/.*"token":"([a-f0-9]+)".*/\1/'); A=(-H "Authorization: Bearer $T" "${J[@]}")
chk "GET /api/me" 200 "${A[@]}" $B/api/me
chk "GET /api/settings" 200 "${A[@]}" $B/api/settings
chk "PUT /api/settings" 200 "${A[@]}" -X PUT -d '{"currency":"XAF"}' $B/api/settings
chk "GET /api/summary" 200 "${A[@]}" $B/api/summary; echo "     $BODY" | cut -c1-400
chk "GET /api/borrowers" 200 "${A[@]}" $B/api/borrowers
chk "GET /api/borrowers?q=" 200 "${A[@]}" "$B/api/borrowers?q=Bello"
chk "POST /api/borrowers" 201 "${A[@]}" -d '{"name":"[TEST] Verify Borrowé","phone":"+237 600000000","id_number":"TEST-123"}' $B/api/borrowers
BID=$(echo "$BODY" | sed -E 's/.*"id":([0-9]+).*/\1/;' | head -c 10); BID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
chk "POST /api/borrowers invalid" 400 "${A[@]}" -d '{}' $B/api/borrowers
chk "GET /api/borrowers/:id" 200 "${A[@]}" $B/api/borrowers/$BID
chk "PUT /api/borrowers/:id" 200 "${A[@]}" -X PUT -d '{"address":"Akwa, Douala"}' $B/api/borrowers/$BID
chk "GET /api/loans" 200 "${A[@]}" $B/api/loans
chk "GET /api/loans?status=overdue" 200 "${A[@]}" "$B/api/loans?status=overdue"
chk "POST /api/loans" 201 "${A[@]}" -d "{\"borrower_id\":$BID,\"principal\":120000,\"interest_rate\":24,\"term_months\":6,\"start_date\":\"$(date +%F)\"}" $B/api/loans
LID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
chk "GET /api/loans/:id" 200 "${A[@]}" $B/api/loans/$LID
chk "PUT /api/loans/:id" 200 "${A[@]}" -X PUT -d '{"notes":"verified"}' $B/api/loans/$LID
chk "GET /api/loans/:id/schedule" 200 "${A[@]}" $B/api/loans/$LID/schedule
ok_(){ pass=$((pass+1)); echo "PASS $1"; }; ko_(){ fail=$((fail+1)); echo "FAIL $1"; }
jsn(){ node -e "const d=JSON.parse(process.argv[1]);process.exit(($1)?0:1)" "$BODY"; }
chk "legacy loan" 200 "${A[@]}" $B/api/loans/$LID; jsn "d.model==='legacy'&&d.total_due===134400" && ok_ "legacy loan keeps annual-rate total 134400" || ko_ "legacy loan: $BODY"
chk "GET /api/calculate 10000/40%/14d" 200 "${A[@]}" "$B/api/calculate?principal=10000&interest_rate=40&term_days=14&start_date=2026-10-12"
jsn "d.total_interest===4000&&d.total_repayable===14000&&d.installments===1&&d.due_date==='2026-10-26'&&d.schedule[0].amount===14000" && ok_ "calculator: 10000 @40%/14d = 4000 interest, 14000 lump sum on 2026-10-26" || ko_ "calc short: $BODY"
chk "GET /api/calculate fixed XAF interest" 200 "${A[@]}" "$B/api/calculate?principal=10000&interest_amount=4000&term_days=14&start_date=2026-10-12"; jsn "d.interest_pct===40&&d.total_repayable===14000" && ok_ "fixed 4000 XAF interest = 40%" || ko_ "calc amount: $BODY"
chk "POST short-term loan (40%, 14d, 2 installments)" 201 "${A[@]}" -d "{\"borrower_id\":$BID,\"principal\":10000,\"interest_rate\":40,\"term_days\":14,\"installments\":2,\"start_date\":\"$(date +%F)\"}" $B/api/loans
SLID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2); jsn "d.model==='short'&&d.interest_amount===4000&&d.total_due===14000&&d.installment===7000&&d.term_days===14" && ok_ "short loan: interest_amount 4000 synced, total 14000, 2x7000" || ko_ "short loan: $BODY"
chk "GET /api/calculate same as short loan" 200 "${A[@]}" "$B/api/calculate?principal=10000&interest_rate=40&term_days=14&installments=2&start_date=$(date +%F)"; CALC=$BODY
chk "GET short loan schedule" 200 "${A[@]}" $B/api/loans/$SLID/schedule
node -e "const c=JSON.parse(process.argv[1]),s=JSON.parse(process.argv[2]);process.exit(c.schedule.length===s.schedule.length&&c.schedule.every((r,i)=>r.due_date===s.schedule[i].due_date&&r.amount===s.schedule[i].amount)&&c.total_repayable===s.total_due?0:1)" "$CALC" "$BODY" && ok_ "calculator matches server schedule for identical loan" || ko_ "calc vs schedule: $CALC / $BODY"
chk "PUT short loan interest_amount 5000" 200 "${A[@]}" -X PUT -d '{"interest_amount":5000}' $B/api/loans/$SLID; jsn "d.interest_rate===50&&d.total_due===15000" && ok_ "interest XAF -> % in sync (50%)" || ko_ "sync: $BODY"
chk "POST short loan lump, started 20 days ago" 201 "${A[@]}" -d "{\"borrower_id\":$BID,\"principal\":10000,\"interest_rate\":40,\"term_days\":14,\"start_date\":\"$(date -d '-20 days' +%F)\"}" $B/api/loans
OLID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2); jsn "d.effective_status==='overdue'&&d.arrears===14000" && ok_ "past due date with balance owed = overdue" || ko_ "overdue: $BODY"
chk "POST repayment (late) clearing it" 201 "${A[@]}" -d "{\"loan_id\":$OLID,\"amount\":14000,\"date\":\"$(date +%F)\"}" $B/api/repayments; ORID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
chk "GET cleared loan" 200 "${A[@]}" $B/api/loans/$OLID; jsn "d.effective_status==='paid'" && ok_ "fully repaid short loan is paid" || ko_ "paid: $BODY"
chk "GET /api/cashflow next7" 200 "${A[@]}" "$B/api/cashflow?range=next7"
jsn "d.from==='$(date -u +%F)'&&d.days.some(x=>x.events.some(e=>e.type==='expected'&&e.loan_id===$SLID&&e.date==='$(date -u -d '+7 days' +%F)'&&e.amount===7500))&&d.days.some(x=>x.events.some(e=>e.type==='disbursed'&&e.loan_id===$SLID&&e.amount===10000))&&d.days.every(x=>x.date>=d.from&&x.date<=d.to)" && ok_ "cash flow next 7 days: disbursement out + expected 7500 on due date" || ko_ "cashflow next7: ${BODY:0:400}"
jsn "d.days.find(x=>x.date===d.today).out>=10000&&d.days.find(x=>x.date===d.today).in_received>=14000" && ok_ "cash flow daily totals in/out for today" || ko_ "daily totals: ${BODY:0:300}"
for r in today week next14 next30 past; do chk "GET /api/cashflow?range=$r" 200 "${A[@]}" "$B/api/cashflow?range=$r"; done
jsn "d.days.every(x=>x.date<d.today)&&d.days.some(x=>x.events.some(e=>e.loan_id===$OLID&&e.type==='disbursed'))" && ok_ "cash flow past: only past dates, includes back-dated disbursement" || ko_ "past: ${BODY:0:300}"
chk "GET /api/cashflow week" 200 "${A[@]}" "$B/api/cashflow?range=week"; jsn "new Date(d.from+'T00:00:00Z').getUTCDay()===1" && ok_ "this week starts Monday" || ko_ "week: ${BODY:0:200}"
chk "GET /api/cashflow unauth" 401 "$B/api/cashflow"
chk "GET /api/borrowers (dates)" 200 "${A[@]}" "$B/api/borrowers?q=Verify"; jsn "d[0].last_loan_date==='$(date -u +%F)'&&d[0].next_due_date==='$(date -u -d '+7 days' +%F)'" && ok_ "borrower last loan date + next due date" || ko_ "borrower dates: $BODY"
chk "GET schedule has dates" 200 "${A[@]}" $B/api/loans/$SLID/schedule; jsn "d.start_date&&d.end_date==='$(date -u -d '+14 days' +%F)'" && ok_ "loan schedule includes disbursement + due date" || ko_ "sched dates: $BODY"
chk "POST short loan installments > days" 400 "${A[@]}" -d "{\"borrower_id\":$BID,\"principal\":1000,\"interest_rate\":10,\"term_days\":3,\"installments\":5,\"start_date\":\"$(date +%F)\"}" $B/api/loans
chk "GET /api/settings default capital" 200 "${A[@]}" $B/api/settings; jsn "d.starting_capital===200000" && ok_ "starting_capital defaults to 200000" || ko_ "capital default: $BODY"
chk "PUT starting_capital invalid" 400 "${A[@]}" -X PUT -d '{"starting_capital":-5}' $B/api/settings
chk "PUT starting_capital 500000" 200 "${A[@]}" -X PUT -d '{"starting_capital":500000}' $B/api/settings
chk "GET /api/growth month" 200 "${A[@]}" "$B/api/growth?period=month"
jsn "d.series.length===12&&d.starting_capital===500000&&d.series.every(x=>Math.abs(x.equity-(500000+x.cumulative_profit-x.write_offs))<0.02)&&'lent' in d.growth_pct&&d.current.new_loans>=2" && ok_ "growth monthly: equity = capital + cumulative interest - write-offs at every point" || ko_ "growth: ${BODY:0:300}"
jsn "d.series.every(x=>'cash_on_hand' in x&&'on_loan' in x)&&d.current.on_loan>=d.current.outstanding_book-0.01" && ok_ "growth has cash-on-hand / on-loan split" || ko_ "split: ${BODY:0:200}"
chk "GET /api/growth week" 200 "${A[@]}" "$B/api/growth?period=week"; jsn "d.period==='week'&&d.series.length===12&&d.current.interest_earned>=4000-0.01" && ok_ "growth weekly with interest earned this week" || ko_ "growth week: ${BODY:0:300}"
chk "PUT starting_capital back to 200000" 200 "${A[@]}" -X PUT -d '{"starting_capital":200000}' $B/api/settings
chk "GET /api/growth unauth" 401 $B/api/growth
for s in loans borrowed repaid ontime; do chk "GET /api/leaderboard?sort=$s" 200 "${A[@]}" "$B/api/leaderboard?sort=$s"; done
jsn "d.rows.length>0&&d.rows[0].badge==='gold'&&d.rows.every(r=>'on_time_rate' in r)" && ok_ "leaderboard ranks with badges + on-time rate" || ko_ "leaderboard: ${BODY:0:300}"
chk "GET /api/leaderboard?sort=loans" 200 "${A[@]}" "$B/api/leaderboard?sort=loans"; jsn "(()=>{const r=d.rows.find(x=>x.name.includes('Verify'));return r&&r.loan_count===3&&r.completed_loans===1&&r.on_time_rate===0})()" && ok_ "on-time rate: late-cleared loan is not on time (0/1)" || ko_ "on-time: ${BODY:0:400}"
chk "GET /api/leaderboard unauth" 401 $B/api/leaderboard
chk "DELETE short loan" 200 "${A[@]}" -X DELETE $B/api/loans/$SLID; chk "DELETE overdue loan" 200 "${A[@]}" -X DELETE $B/api/loans/$OLID
chk "GET /api/calculate invalid" 400 "${A[@]}" "$B/api/calculate?principal=-5"
chk "GET /api/calculate unauth" 401 "$B/api/calculate?principal=1"
chk "GET /lib.js (shared calc code)" 200 -o /dev/null $B/lib.js
curl -s $B/ | grep -q 'data-v="calc"' && curl -s $B/ | grep -q 'data-v="growth"' && curl -s $B/ | grep -q 'data-v="leaders"' && curl -s $B/ | grep -q 'id="g5"' && curl -s $B/ | grep -q 'data-v="cash"' && { pass=$((pass+1)); echo "PASS UI has Calculator, Growth (+Revenue & Equity), Leaderboard"; } || { fail=$((fail+1)); echo "FAIL UI calculator tab"; }
chk "DELETE borrower with loan (blocked)" 400 "${A[@]}" -X DELETE $B/api/borrowers/$BID
chk "GET /api/repayments" 200 "${A[@]}" $B/api/repayments
chk "GET /api/repayments?method=" 200 "${A[@]}" "$B/api/repayments?method=cash"
chk "POST /api/repayments" 201 "${A[@]}" -d "{\"loan_id\":$LID,\"amount\":22400,\"date\":\"$(date +%F)\",\"method\":\"mobile_money\"}" $B/api/repayments
RID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
chk "GET export.xlsx unauth" 401 -o /dev/null $B/api/export.xlsx
chk "GET export.xlsx" 200 -D $TMPX.h -o $TMPX.xlsx "${A[@]}" $B/api/export.xlsx
grep -qi "content-disposition: attachment; filename=\"loan-data-$(date -u +%F).xlsx\"" $TMPX.h && { pass=$((pass+1)); echo "PASS xlsx dated attachment filename"; } || { fail=$((fail+1)); echo "FAIL xlsx disposition: $(cat $TMPX.h)"; }
node -e "const E=require('exceljs');new E.Workbook().xlsx.readFile('$TMPX.xlsx').then(w=>{const n=w.worksheets.map(s=>s.name).join();if(n!=='Borrowers,Loans,Repayments'||!w.getWorksheet('Loans').getRow(1).values.includes('balance'))process.exit(1)}).catch(()=>process.exit(1))" && { pass=$((pass+1)); echo "PASS xlsx valid with 3 sheets + balance column"; } || { fail=$((fail+1)); echo "FAIL xlsx invalid"; }
for t in borrowers loans repayments; do chk "GET export/$t.csv" 200 -D $TMPX.h -o $TMPX.csv "${A[@]}" $B/api/export/$t.csv
  head -c3 $TMPX.csv | od -An -tx1 | grep -q 'ef bb bf' && grep -qi "attachment; filename=\"$t-" $TMPX.h && { pass=$((pass+1)); echo "PASS $t.csv BOM + attachment"; } || { fail=$((fail+1)); echo "FAIL $t.csv BOM/disposition"; }; done
chk "GET export/borrowers.csv" 200 -o $TMPX.csv "${A[@]}" $B/api/export/borrowers.csv
grep -q 'Verify Borrowé' $TMPX.csv && { pass=$((pass+1)); echo "PASS borrowers.csv contains UTF-8 accented test row"; } || { fail=$((fail+1)); echo "FAIL borrowers.csv accents"; }
grep -q '120000' <(curl -s "${A[@]}" $B/api/export/loans.csv) && { pass=$((pass+1)); echo "PASS loans.csv contains test loan"; } || { fail=$((fail+1)); echo "FAIL loans.csv content"; }
chk "GET export unknown table" 404 "${A[@]}" $B/api/export/sessions.csv
CK=$(curl -s -D - -o /dev/null "${J[@]}" -d "{\"username\":\"admin\",\"password\":\"$P\"}" $B/api/login | grep -i '^set-cookie' | sed -E 's/.*(session=[a-f0-9]+).*/\1/')
chk "GET export.xlsx via cookie only" 200 -o /dev/null -H "Cookie: $CK" $B/api/export.xlsx
curl -s -o /dev/null -X POST -H "Cookie: $CK" $B/api/logout
curl -s $B/ | grep -q 'href="/api/export.xlsx"' && { pass=$((pass+1)); echo "PASS UI has Export link"; } || { fail=$((fail+1)); echo "FAIL UI export link"; }
rm -f $TMPX.h $TMPX.xlsx $TMPX.csv
chk "GET /api/repayments/:id" 200 "${A[@]}" $B/api/repayments/$RID
chk "PUT /api/repayments/:id" 200 "${A[@]}" -X PUT -d '{"reference":"VERIFY"}' $B/api/repayments/$RID
chk "GET /api/loans/:id/repayments" 200 "${A[@]}" $B/api/loans/$LID/repayments
chk "DELETE /api/repayments/:id" 200 "${A[@]}" -X DELETE $B/api/repayments/$RID
chk "DELETE /api/loans/:id" 200 "${A[@]}" -X DELETE $B/api/loans/$LID
chk "DELETE /api/borrowers/:id" 200 "${A[@]}" -X DELETE $B/api/borrowers/$BID
chk "GET deleted borrower" 404 "${A[@]}" $B/api/borrowers/$BID
chk "POST /api/logout" 200 "${A[@]}" -X POST $B/api/logout
chk "token revoked" 401 "${A[@]}" $B/api/me

# ---------- deployment checks (temp servers on other ports, temp DB files; skip with SKIP_DEPLOY_CHECKS=1) ----------
if [ -z "$SKIP_DEPLOY_CHECKS" ]; then
  cd "$(dirname "$0")/.."; TMP=$(mktemp -d); PIDS=()
  ok(){ pass=$((pass+1)); echo "PASS $1"; }; ko(){ fail=$((fail+1)); echo "FAIL $1"; }
  up(){ for i in $(seq 1 50); do curl -s -o /dev/null "$1/api/health" && return 0; sleep 0.2; done; return 1; }
  # 1) production without ADMIN_PASSWORD refuses to start
  out=$(env -u ADMIN_PASSWORD NODE_ENV=production PORT=3911 TURSO_DATABASE_URL=file:$TMP/a.db timeout 10 node server.js 2>&1); rc=$?
  [ $rc -ne 0 ] && echo "$out" | grep -q 'ADMIN_PASSWORD must be set' && ok "prod refuses to start without ADMIN_PASSWORD" || ko "prod start without ADMIN_PASSWORD (rc=$rc): $out"
  # 2) production with password: fresh DB migrated, no example data, Secure cookie, uses PORT
  NODE_ENV=production ADMIN_PASSWORD=s3cret-test PORT=3912 TURSO_DATABASE_URL=file:$TMP/p.db node server.js > $TMP/p.log 2>&1 & PIDS+=($!)
  C=http://localhost:3912
  if up $C; then ok "prod server listens on PORT"; else ko "prod server did not start: $(cat $TMP/p.log)"; fi
  grep -q '001_init.sql, 002_sessions.sql' $TMP/p.log && ok "migrations run automatically at startup" || ko "migrations at startup: $(cat $TMP/p.log)"
  hdr=$(curl -s -D - -o /dev/null -H 'Content-Type: application/json' -d '{"username":"admin","password":"s3cret-test"}' $C/api/login)
  echo "$hdr" | grep -qi '^set-cookie:.*; Secure' && ok "Secure session cookie in production" || ko "Secure cookie: $hdr"
  curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' $C/api/login | grep -q 401 && ok "admin123 rejected in production" || ko "admin123 accepted in production"
  PT=$(curl -s -H 'Content-Type: application/json' -d '{"username":"admin","password":"s3cret-test"}' $C/api/login | sed -E 's/.*"token":"([a-f0-9]+)".*/\1/')
  n=$(curl -s -H "Authorization: Bearer $PT" $C/api/borrowers); [ "$n" = "[]" ] && ok "no example data seeded in production" || ko "production seeded data: ${n:0:120}"
  g=$(curl -s -H "Authorization: Bearer $PT" "$C/api/growth?period=week"); echo "$g" | grep -q '"empty":true' && ok "growth handles empty database" || ko "growth empty: ${g:0:200}"
  l=$(curl -s -H "Authorization: Bearer $PT" $C/api/leaderboard); [ "$l" = '{"sort":"loans","rows":[]}' ] && ok "leaderboard empty database" || ko "leaderboard empty: $l"
  # 3) session survives restart
  kill ${PIDS[-1]}; wait ${PIDS[-1]} 2>/dev/null
  NODE_ENV=production ADMIN_PASSWORD=s3cret-test PORT=3912 TURSO_DATABASE_URL=file:$TMP/p.db node server.js > $TMP/p2.log 2>&1 & PIDS+=($!); up $C
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $PT" $C/api/me)" = 200 ] && ok "login survives server restart (DB sessions)" || ko "session lost after restart"
  # 4) SEED_EXAMPLE_DATA=true seeds in production
  NODE_ENV=production ADMIN_PASSWORD=x SEED_EXAMPLE_DATA=true PORT=3913 TURSO_DATABASE_URL=file:$TMP/s.db node server.js > $TMP/s.log 2>&1 & PIDS+=($!); up http://localhost:3913
  grep -q 'Seeded example data' $TMP/s.log && ok "SEED_EXAMPLE_DATA=true seeds example data" || ko "seed flag: $(cat $TMP/s.log)"
  # 5) login rate limiting
  codes=$(for i in $(seq 1 11); do curl -s -o /dev/null -w '%{http_code} ' -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong"}' http://localhost:3913/api/login; done)
  echo "$codes" | grep -q '429' && ok "login rate limit returns 429 after 10 failures" || ko "rate limit: $codes"
  # 6) mobile/PWA assets
  for u in /manifest.webmanifest /apple-touch-icon.png /icon-512.png; do chk "GET $u" 200 -o /dev/null $B$u; done
  echo "$BODY" >/dev/null; curl -s $B/ | grep -q 'apple-touch-icon' && ok "UI links apple-touch-icon + manifest" || ko "UI missing apple-touch-icon"
  kill "${PIDS[@]}" 2>/dev/null; wait 2>/dev/null; rm -rf "$TMP"
fi
echo "RESULT: $pass passed, $fail failed"; [ $fail = 0 ]
