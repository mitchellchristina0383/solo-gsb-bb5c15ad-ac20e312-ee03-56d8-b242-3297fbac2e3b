#!/usr/bin/env bash
# 端到端规则验证脚本（依赖 curl + python3 做 JSON 断言）
set -u
BASE="http://localhost:3000"
PASS=0; FAIL=0

check() { # desc  expected_substr  actual
  if [[ "$3" == *"$2"* ]]; then echo "✅ $1"; PASS=$((PASS+1));
  else echo "❌ $1"; echo "   期望包含: $2"; echo "   实际: $3"; FAIL=$((FAIL+1)); fi
}

post() { curl -s -X POST "$BASE$1" -H 'Content-Type: application/json' -d "$2"; }

post /api/reset '{}' >/dev/null

echo "== 1. host-only cookie，默认 Path（/admin/dashboard -> /admin） =="
R=$(post /api/store '{"url":"https://shop.example.com/admin/dashboard?tab=1","setCookie":"tracker=xyz; Max-Age=3600"}')
check "入罐成功" '"action":"stored"' "$R"
check "host-only 作用域" "host-only" "$R"
check "默认 Path=/admin 提示" "默认路径" "$R"

echo "== 2. Domain cookie，显式 Path=/ =="
R=$(post /api/store '{"url":"https://example.com/","setCookie":"prefs=dark; Domain=example.com; Path=/; Max-Age=100"}')
check "Domain 入罐" '"action":"stored"' "$R"
check "domain 作用域" "domain" "$R"

echo "== 3. Domain 不匹配响应主机 -> 拒绝 =="
R=$(post /api/store '{"url":"http://evil.example.org/","setCookie":"bad=nope; Domain=example.com"}')
check "拒绝状态" '"action":"rejected"' "$R"
check "拒绝原因（不匹配响应主机）" "不匹配响应主机" "$R"

echo "== 4. 上级子域写法合法（host=a.b.example.com, Domain=b.example.com） =="
R=$(post /api/store '{"url":"https://a.b.example.com/x/y","setCookie":"z=1; Domain=b.example.com"}')
check "上级域入罐" '"action":"stored"' "$R"
check "默认 Path=/x" 'Path=/x' "$R"

echo "== 5. 非法 Path（相对路径）忽略，取默认路径 =="
R=$(post /api/store '{"url":"https://shop.example.com/admin/dashboard","setCookie":"rel=v; Path=admin; Max-Age=99"}')
check "入罐" '"action":"stored"' "$R"
check "Path 提示" "不是绝对路径" "$R"

echo "== 6. http 响应写 Secure 给提示但仍记录 =="
R=$(post /api/store '{"url":"http://shop.example.com/","setCookie":"sec=1; Path=/; Secure"}')
check "入罐（带提示）" '"action":"stored"' "$R"
check "Secure 提示" "明文 http" "$R"

echo "== 7. IP 主机 + 不匹配 Domain -> 拒绝 =="
R=$(post /api/store '{"url":"http://192.168.1.10/","setCookie":"ipbad=1; Domain=example.com"}')
check "IP 拒绝" '"action":"rejected"' "$R"

echo "== 8. 同名同域同路径覆盖，沿用创建序号 =="
R=$(post /api/store '{"url":"https://example.com/","setCookie":"prefs=light; Domain=example.com; Path=/; Max-Age=200"}')
check "更新动作" '"action":"updated"' "$R"
check "值被覆盖" 'prefs' "$R"

echo "== 9. Max-Age<=0 删除同名项 =="
R=$(post /api/store '{"url":"https://shop.example.com/admin/dashboard","setCookie":"tracker=gone; Max-Age=0"}')
check "删除动作" '"action":"deleted"' "$R"
check "删除原因" "已删除" "$R"

echo "== 10. 负 Max-Age 删不存在的项 =="
R=$(post /api/store '{"url":"https://shop.example.com/admin/dashboard","setCookie":"ghost=x; Max-Age=-5"}')
check "删除动作（无目标）" '"action":"deleted"' "$R"
check "无可删除" "无可删除" "$R"

echo "== 11. 缺 name= 解析失败 =="
R=$(post /api/store '{"url":"https://example.com/","setCookie":"notacookie"}')
check "拒绝" '"action":"rejected"' "$R"
check "解析失败原因" "解析失败" "$R"

echo "== 12. 非法 URL =="
R=$(post /api/store '{"url":"not-a-url","setCookie":"a=b"}')
check "拒绝" '"action":"rejected"' "$R"

echo
echo "------- 请求演算 -------"

echo "== A. https 子域请求，Domain cookie + Path 命中 =="
R=$(post /api/send '{"url":"https://api.shop.example.com/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "prefs 发送" "prefs=light" "$HDR"
# sec 是 shop.example.com 的 host-only cookie，api 子域不应收到
if [[ "$HDR" != *"sec=1"* ]]; then echo "✅ host-only sec 不发往 api 子域"; PASS=$((PASS+1));
else echo "❌ host-only cookie 被错误发给子域"; FAIL=$((FAIL+1)); fi

echo "== B. http 请求：Secure 项被排除 =="
R=$(post /api/send '{"url":"http://shop.example.com/"}')
check "Secure 排除原因" "仅经 https 发送" "$R"
check "host-only prefs? prefs 是 domain example.com -> 子域 shop 可发，但 http 不影响非 Secure" "prefs=light" "$R"

echo "== C. Path 不匹配（/home 不命中 /admin） =="
R=$(post /api/send '{"url":"https://shop.example.com/home"}')
check "Path 排除原因" "Path 不匹配" "$R"

echo "== D. Path 边界规则：/adminxxx 不命中 /admin；/admin/x 命中 =="
R=$(post /api/send '{"url":"https://shop.example.com/adminxxx"}')
check "/adminxxx 不命中" "Path 不匹配" "$R"
R=$(post /api/send '{"url":"https://shop.example.com/admin/users"}')
if [[ "$R" != *"Path 不匹配"* ]]; then echo "✅ /admin/users 命中 cookie-path=/admin"; PASS=$((PASS+1));
else echo "❌ /admin/users 应命中 /admin"; FAIL=$((FAIL+1)); fi

echo "== E. host-only 仅匹配原主机（tracker 已删；z 是 domain=b.example.com） =="
R=$(post /api/send '{"url":"https://other.example.com/"}')
check "prefs(domain) 仍发" "prefs=light" "$R"
R=$(post /api/send '{"url":"https://b.example.com/x/"}')
check "z 发往 b.example.com 本身" "z=1" "$R"
R=$(post /api/send '{"url":"https://c.b.example.com/x/deep"}')
check "z 发往子域 c.b.example.com" "z=1" "$R"
R=$(post /api/send '{"url":"https://notb.example.com/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"z=1"* ]]; then echo "✅ z 不发往无关域（$HDR）"; PASS=$((PASS+1));
else echo "❌ z 不应发往 notb.example.com"; FAIL=$((FAIL+1)); fi

echo "== F. 排序：Path 长度降序 =="
post /api/store '{"url":"https://sorted.test/a/b/c","setCookie":"long=1; Path=/a/b"}' >/dev/null
post /api/store '{"url":"https://sorted.test/","setCookie":"root=2; Path=/"}' >/dev/null
post /api/store '{"url":"https://sorted.test/","setCookie":"short=3; Path=/a"}' >/dev/null
R=$(post /api/send '{"url":"https://sorted.test/a/b/c/page"}')
LONG_AT=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);h=d['cookieHeader'];print(h.find('long=1'))")
SHORT_AT=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);h=d['cookieHeader'];print(h.find('short=3'))")
ROOT_AT=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);h=d['cookieHeader'];print(h.find('root=2'))")
if [ "$LONG_AT" -lt "$SHORT_AT" ] && [ "$SHORT_AT" -lt "$ROOT_AT" ]; then
  echo "✅ 排序正确: $(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")"; PASS=$((PASS+1))
else echo "❌ 排序错误 long=$LONG_AT short=$SHORT_AT root=$ROOT_AT"; FAIL=$((FAIL+1)); fi

echo "== G. 同 Path 长度按创建顺序升序 =="
post /api/store '{"url":"https://order.test/aa","setCookie":"c1=1; Path=/aa"}' >/dev/null
post /api/store '{"url":"https://order.test/aa","setCookie":"c2=2; Path=/aa"}' >/dev/null
R=$(post /api/send '{"url":"https://order.test/aa/x"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "c1 在 c2 前" "c1=1; c2=2" "$HDR"

echo "== H. 过期 cookie 不发送（Max-Age=1 秒） =="
post /api/store '{"url":"https://exp.test/","setCookie":"quick=dying; Path=/; Max-Age=1"}' >/dev/null
sleep 1.5
R=$(post /api/send '{"url":"https://exp.test/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"quick=dying"* ]]; then echo "✅ 过期项不在 Cookie 头"; PASS=$((PASS+1));
else echo "❌ 过期项仍被发送"; FAIL=$((FAIL+1)); fi
check "排除原因标注已过期" "已过期" "$R"

echo "== I. GET /api/jar 与重置 =="
J=$(curl -s "$BASE/api/jar")
check "jar 接口 ok" '"ok":true' "$J"
R=$(post /api/reset '{}')
check "重置 ok" '"ok":true' "$R"
J=$(curl -s "$BASE/api/jar")
check "重置后为空" '"cookies":[]' "$J"

echo
echo "------- SameSite 写入演算 -------"

echo "== J1. SameSite 大小写不敏感（STRICT） =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_strict=1; Path=/; SameSite=STRICT"}')
check "入罐" '"action":"stored"' "$R"
check "解析为 strict" '"sameSite":"strict"' "$R"

echo "== J2. 非法 SameSite 值 -> 默认 Lax + 提示 =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_def=1; Path=/; SameSite=Banana"}')
check "入罐" '"action":"stored"' "$R"
check "记为 lax" '"sameSite":"lax"' "$R"
check "标记为默认" '"sameSiteDefault":true' "$R"
check "非法值提示" "SameSite 值非法" "$R"

echo "== J3. 未声明 SameSite -> 默认 Lax =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_plain=1; Path=/"}')
check "默认 lax" '"sameSite":"lax"' "$R"
check "标记为默认" '"sameSiteDefault":true' "$R"

echo "== J4. SameSite=None 未带 Secure -> 拒绝入罐 =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_none_bad=1; SameSite=None"}')
check "拒绝" '"action":"rejected"' "$R"
check "拒绝原因" "SameSite=None 必须同时声明 Secure" "$R"

echo "== J5. SameSite=None + Secure（混合大小写） -> 入罐 =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_none=1; Path=/; Secure; SameSite=nOnE"}')
check "入罐" '"action":"stored"' "$R"
check "解析为 none" '"sameSite":"none"' "$R"

echo "== J6. 显式 Lax（非默认） =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_lax=1; Path=/; SameSite=Lax"}')
check "解析为 lax" '"sameSite":"lax"' "$R"
check "非默认" '"sameSiteDefault":false' "$R"

echo "== J7. Domain cookie + Strict（供子域同站测试） =="
R=$(post /api/store '{"url":"https://ss.test/","setCookie":"ss_dom=1; Domain=ss.test; Path=/; SameSite=Strict"}')
check "入罐" '"action":"stored"' "$R"

echo
echo "------- SameSite 发送演算 -------"

echo "== K1. 同站上下文（缺省 topUrl=请求 URL）全部放行 =="
R=$(post /api/send '{"url":"https://ss.test/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "Strict 同站发送" "ss_strict=1" "$HDR"
check "None 同站发送" "ss_none=1" "$HDR"
check "同站标记" '"sameSiteContext":true' "$R"

echo "== K2. 跨站顶层 GET：Strict 排除，Lax/None 放行 =="
R=$(post /api/send '{"url":"https://ss.test/","topUrl":"https://other.org/","method":"GET","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "跨站标记" '"sameSiteContext":false' "$R"
check "显式 Lax 跨站顶层 GET 放行" "ss_lax=1" "$HDR"
check "默认 Lax 跨站顶层 GET 放行" "ss_def=1" "$HDR"
check "None 跨站放行" "ss_none=1" "$HDR"
if [[ "$HDR" != *"ss_strict=1"* ]]; then echo "✅ Strict 跨站不发送"; PASS=$((PASS+1));
else echo "❌ Strict 跨站被误发"; FAIL=$((FAIL+1)); fi
check "Strict 排除原因" "SameSite=Strict：仅同站请求发送" "$R"

echo "== K3. 跨站顶层 POST：默认 Lax 120 秒宽限放行，显式 Lax 排除 =="
R=$(post /api/send '{"url":"https://ss.test/","topUrl":"https://other.org/","method":"POST","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "默认 Lax 宽限内放行" "ss_def=1" "$HDR"
check "宽限说明" "120 秒宽限的顶层 POST" "$R"
if [[ "$HDR" != *"ss_lax=1"* ]]; then echo "✅ 显式 Lax 跨站 POST 不享受宽限"; PASS=$((PASS+1));
else echo "❌ 显式 Lax 跨站 POST 被误发"; FAIL=$((FAIL+1)); fi
check "显式 Lax 排除原因" "跨站顶层导航仅安全方法" "$R"

echo "== K4. 跨站非顶层导航 GET：仅 None 放行 =="
R=$(post /api/send '{"url":"https://ss.test/","topUrl":"https://other.org/","method":"GET","topLevelNav":false}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "None 仍放行" "ss_none=1" "$HDR"
if [[ "$HDR" != *"ss_lax=1"* ]] && [[ "$HDR" != *"ss_def=1"* ]]; then echo "✅ Lax 非顶层导航不发送"; PASS=$((PASS+1));
else echo "❌ Lax 非顶层导航被误发（$HDR）"; FAIL=$((FAIL+1)); fi
check "非顶层导航排除原因" "非顶层导航" "$R"

echo "== K5. 子域同站：api.ss.test 请求 + ss.test 顶层页 =="
R=$(post /api/send '{"url":"https://api.ss.test/","topUrl":"https://ss.test/","method":"GET","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "同站标记（eTLD+1 相同）" '"sameSiteContext":true' "$R"
check "Strict Domain cookie 同站发送" "ss_dom=1" "$HDR"
R=$(post /api/send '{"url":"https://api.ss.test/","topUrl":"https://other.org/","method":"GET","topLevelNav":true}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
if [[ "$HDR" != *"ss_dom=1"* ]]; then echo "✅ Strict Domain cookie 跨站不发"; PASS=$((PASS+1));
else echo "❌ Strict Domain cookie 跨站误发"; FAIL=$((FAIL+1)); fi

echo "== K6. schemeful：http 与 https 不同站 =="
post /api/store '{"url":"http://plain.test/","setCookie":"sch=1; Path=/; SameSite=Strict"}' >/dev/null
R=$(post /api/send '{"url":"http://plain.test/","topUrl":"https://plain.test/"}')
check "scheme 不同即跨站" '"sameSiteContext":false' "$R"
R=$(post /api/send '{"url":"http://plain.test/","topUrl":"http://plain.test/"}')
check "scheme 相同同站" '"sameSiteContext":true' "$R"
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "Strict 同站发送" "sch=1" "$HDR"

echo "== K7. localhost / IP 按完整主机比较 =="
post /api/store '{"url":"http://localhost/","setCookie":"lo=1; Path=/; SameSite=Strict"}' >/dev/null
R=$(post /api/send '{"url":"http://localhost/","topUrl":"http://127.0.0.1/"}')
check "localhost ≠ 127.0.0.1" '"sameSiteContext":false' "$R"
R=$(post /api/send '{"url":"http://localhost/","topUrl":"http://localhost:8080/"}')
check "localhost 不同端口仍同站" '"sameSiteContext":true' "$R"
post /api/store '{"url":"http://192.168.1.10/","setCookie":"ipc=1; Path=/; SameSite=Strict"}' >/dev/null
R=$(post /api/send '{"url":"http://192.168.1.10/","topUrl":"http://192.168.1.11/"}')
check "不同 IP 不同站" '"sameSiteContext":false' "$R"
R=$(post /api/send '{"url":"http://192.168.1.10/","topUrl":"http://192.168.1.10/"}')
HDR=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['cookieHeader'])")
check "同 IP 同站发送" "ipc=1" "$HDR"

echo "== K8. 公共后缀：example.co.uk 整域才是可注册域 =="
post /api/store '{"url":"https://shop.example.co.uk/","setCookie":"uk=1; Path=/; SameSite=Strict"}' >/dev/null
R=$(post /api/send '{"url":"https://shop.example.co.uk/","topUrl":"https://example.co.uk/"}')
check "同 eTLD+1 同站" '"sameSiteContext":true' "$R"
R=$(post /api/send '{"url":"https://shop.example.co.uk/","topUrl":"https://other.co.uk/"}')
check "co.uk 下不同注册域跨站" '"sameSiteContext":false' "$R"

echo "== K9. 顶层页面 URL 非法 -> 报错 =="
R=$(post /api/send '{"url":"https://ss.test/","topUrl":"not-a-url"}')
check "非法顶层 URL" "顶层页面 URL 非法" "$R"

post /api/reset '{}' >/dev/null

echo
echo "================================"
echo "通过 $PASS，失败 $FAIL"
[ "$FAIL" -eq 0 ]
