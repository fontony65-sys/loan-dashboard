#!/usr/bin/env bash
# Exercises every endpoint with curl. Usage: scripts/verify.sh [base_url]
B=${1:-http://localhost:3000}; P=${ADMIN_PASSWORD:-admin123}; pass=0; fail=0
chk(){ local name=$1 want=$2; shift 2; local out code; out=$(curl -s -w '\n%{http_code}' "$@"); code=${out##*$'\n'}; BODY=${out%$'\n'*}
  if [ "$code" = "$want" ]; then pass=$((pass+1)); echo "PASS $code $name"; else fail=$((fail+1)); echo "FAIL $code (want $want) $name: $BODY"; fi; }
J=(-H 'Content-Type: application/json')
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
chk "POST /api/borrowers" 201 "${A[@]}" -d '{"name":"[TEST] Verify Borrower","phone":"+237 600000000","id_number":"TEST-123"}' $B/api/borrowers
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
chk "DELETE borrower with loan (blocked)" 400 "${A[@]}" -X DELETE $B/api/borrowers/$BID
chk "GET /api/repayments" 200 "${A[@]}" $B/api/repayments
chk "GET /api/repayments?method=" 200 "${A[@]}" "$B/api/repayments?method=cash"
chk "POST /api/repayments" 201 "${A[@]}" -d "{\"loan_id\":$LID,\"amount\":22400,\"date\":\"$(date +%F)\",\"method\":\"mobile_money\"}" $B/api/repayments
RID=$(echo "$BODY" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
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
