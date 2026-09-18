# 🍪 Cookie 罐演算 Web 工具 · Cookie Jar Lab

一个用于**演算 HTTP Cookie 写入与发送规则**的教学/调试 Web 工具：你按顺序提交
「响应 URL + 单条 Set-Cookie」，服务端按 [RFC 6265](https://www.rfc-editor.org/rfc/rfc6265)
更新内存 Cookie 罐；再输入请求 URL（以及顶层页面 URL、方法、是否顶层导航），即可看到生成的
`Cookie` 请求头，以及每一项**被发送或被排除的具体原因**（含 SameSite 站点演算）。
还可设置**每个可注册域与全局的条数容量**，入罐后按 Priority/最近访问时间/创建序号
演算浏览器式的**容量压力淘汰**。

技术栈：**TypeScript + Express + 原生 HTML/CSS/JS**（前端无框架、无构建），数据仅存内存；
same-site 判定使用 [tldts](https://github.com/remusao/tldts)（内置公共后缀列表 PSL，含私有域段）。

---

## 🚀 单条启动命令

需要安装 Docker（含 Compose 插件）。在项目根目录执行：

```bash
docker compose up --build -d
```

启动后浏览器访问：

> **http://localhost:3000**

- 容器内服务端口：**3000**
- 宿主机默认映射端口：**3000**（想换端口改 `docker-compose.yml` 左侧，如 `"3001:3000"`）

停止与清理：

```bash
docker compose down          # 停止并删除容器（镜像保留）
docker compose down --rmi local   # 同时删除本工具镜像
```

> 不想用 Docker？见文末[不用 Docker 的本地运行](#不用-docker-的本地运行)。

---

## 🧭 使用流程

界面分为三步：

1. **写入 Set-Cookie**（可重复执行，模拟多个响应、按顺序入罐）
   - 填「响应 URL」（cookie 来源页面），如 `https://shop.example.com/admin/dashboard?tab=1`
   - 填「单条 Set-Cookie」（**不要**带 `Set-Cookie:` 前缀），如：
     `session=abc123; Domain=example.com; Path=/; Max-Age=3600; Secure`
   - 点击 **入罐**，查看入罐 / 更新 / 删除 / 拒绝结果与原因
2. **发起请求**：填请求 URL（如 `https://api.shop.example.com/orders/123/detail`），
   并可指定 SameSite 判定上下文——**顶层页面 URL**（留空 = 与请求 URL 同站）、
   **请求方法**、**是否顶层导航**；点击 **生成 Cookie 头**，查看：
   - 最终 `Cookie:` 请求头（可一键复制）
   - 请求站 vs 顶层站（scheme + 可注册域）的同站/跨站结论
   - 📤 **发送项**：命中的主机 / Path / Secure / SameSite 匹配点
   - 🚫 **排除项**：过期、Domain 不匹配、Path 不匹配、Secure 受限、SameSite 拦截等逐项原因
3. **🫙 当前 Cookie 罐**：右侧表格实时展示全部条目（域、作用域、Path、Secure、
   Priority、有效期剩余、创建序号、**最近访问时间**）；点击 **重置** 清空内存罐。
4. **📦 容量压力模拟**（右栏顶部）：
   - 设置**全局容量**（总条数）与各**可注册域**（eTLD+1，如 `example.com` / `example.co.uk`；
     IP、localhost 按完整主机）的条数上限，**留空 = 不限**；
   - 每次**入罐**沿用第 1 步的全部校验，通过后再**依次执行域级、全局两级淘汰**；
   - 某一级超限时：**先清理该范围内已过期项**，仍超限再让候选按
     **Priority 从低到高 → 最近访问时间从早到晚 → 创建序号从小到大**排序，从队首淘汰到达标；
   - 入罐结果区展示**每一级的淘汰清单**（过期清理 / 按序淘汰 / 保留项、逐项排序键与可展开的
     完整候选排序）；修改容量本身**不立即清理**，仅在下次入罐时生效。

### 推荐演算示例（按顺序）

| # | 响应 URL | Set-Cookie | 预期 |
|---|----------|-----------|------|
| 1 | `https://shop.example.com/admin/dashboard` | `sid=host123; Path=/admin; Max-Age=600` | 入罐（host-only，默认 Path 这里被属性指定为 `/admin`） |
| 2 | `https://shop.example.com/admin/dashboard` | `tracker=xyz; Max-Age=3600` | 入罐（host-only，**默认 Path=/admin**，SameSite 记为默认 Lax） |
| 3 | `https://example.com/` | `prefs=a=1; Domain=example.com; Path=/` | 入罐（Domain cookie，覆盖 `example.com` 及所有子域） |
| 4 | `http://evil.example.org/` | `bad=nope; Domain=example.com` | **拒绝**：Domain 不匹配响应主机 |
| 5 | `https://shop.example.com/admin/dashboard` | `tracker=; Max-Age=0` | **删除**同名同域同路径的 tracker |
| 6 | `https://example.com/` | `secure=1; Path=/; Secure` | 入罐（仅 https 发送） |
| 7 | `https://example.com/` | `strict=1; Path=/; SameSite=STRICT` | 入罐（SameSite 大小写不敏感 → Strict） |
| 8 | `https://example.com/` | `xs=1; Path=/; SameSite=None` | **拒绝**：SameSite=None 未带 Secure |
| 9 | `https://example.com/` | `xs=1; Path=/; Secure; SameSite=None` | 入罐（跨站也发送，但仅 https） |
| 10 | `https://example.com/` | `weird=1; Path=/; SameSite=Banana` | 入罐（非法值 → **默认 Lax** 并提示） |

然后分别用以下请求 URL 观察差异：

- `https://api.shop.example.com/admin/orders/9` —— 域 + Path 匹配
- `http://shop.example.com/admin/dashboard` —— 明文 http，Secure 项被排除
- `https://shop.example.com/home` —— Path 不匹配的项被排除并给出原因

SameSite 演算示例（第 2 步的「顶层页面 URL / 方法 / 顶层导航」）：

- 请求 `https://example.com/`，顶层页留空 —— 同站，`strict`/`xs` 都发送
- 请求 `https://example.com/`，顶层页 `https://other.org/`，方法 GET，勾选顶层导航
  —— 跨站：`strict` 被排除；显式/默认 Lax 与 `xs`（None）放行
- 同上但方法 POST —— 显式 Lax 被排除；**默认 Lax**（如第 10 条的 `weird`）
  在创建 120 秒内仍放行（Lax+POST 宽限）
- 同上但取消勾选顶层导航 —— 模拟子资源请求，跨站时只剩 `xs`（None）发送

---

## 📐 实现的演算规则

### 写入（处理 Set-Cookie）

- **Domain**
  - 不带 `Domain` 属性 → **host-only cookie**，只匹配原主机；
  - 带 `Domain` → 规范化（小写、去前导点），且必须是响应主机本身或其上级域，
    否则**拒绝入罐**；
  - 主机是 IP 地址时不做域/子域匹配（Domain 不一致即拒绝）。
- **Path**
  - 合法属性值必须以 `/` 开头，否则忽略属性；
  - **缺省（或非法）时取响应 URL 路径最后一个斜杠之前的目录**
   （`/admin/dashboard` → `/admin`；根路径 → `/`）。
- **Max-Age**
  - 正整数：相对有效期（秒），换算成绝对过期时间；
  - **`<= 0`（含 `0` 与负数）：删除同名 `(name, domain, path)` 项**，不存在则说明无可删除；
  - 非法值（非整数）：忽略并提示，按会话 cookie 处理。`Expires` 属性不参与本演算。
- **Secure**：记录该属性；在明文 `http` 响应中设置会给出提示，且之后绝不会经 http 发送。
- **SameSite**
  - 解析 `Strict` / `Lax` / `None`（**大小写不敏感**）；
  - **未声明或值非法 → 记为默认 Lax**（非法值会给出提示）；
  - **`SameSite=None` 未同时声明 `Secure` → 拒绝入罐**（现代浏览器的强制要求）。
- **Priority**（RFC 6265bis）
  - 解析 `Low` / `Medium` / `High`（**大小写不敏感**）；
  - **缺省或值非法 → 记为默认 Medium**，并在入罐结果中给出提示；
  - Priority 只参与下面的容量淘汰排序，不影响发送。
- **同名同域同路径**再次写入 → 覆盖更新，**沿用首次创建序号**（保证排序稳定），
  并把**最近访问时间**刷新为写入时刻。

### 容量压力模拟（域级 → 全局两级淘汰）

- 容量单位是**条数**，可分别配置：
  - **全局容量**：罐中总条数上限；
  - **每可注册域容量**：按 eTLD+1 归桶（tldts/PSL，含公共后缀，如 `example.co.uk`），
    host-only 主机与其上级 Domain cookie 落同一桶；IP、localhost 按完整主机各成一桶。
  - 留空/不传表示**不限**；配置只在**后续入罐**时生效，修改或重置（重置保留容量配置）
    都不会立即清理已有条目。
- 每次**入罐/覆盖更新**校验通过后依次执行：
  1. **域级**：仅统计与新条目同可注册域桶的条目；
  2. **全局**：统计域级淘汰后的全部条目。
- 任一级**入罐后条数 > 上限**时：
  1. **先清理该范围内所有已过期项**（过期项平时保留并标灰，仅此时主动清除）；
  2. 仍超限，候选按以下复合键排序，**从队首（最该淘汰的一项）开始淘汰**到达标：
     > **Priority 从低到高（Low → Medium → High）**
     > **→ 最近访问时间从早到晚**
     > **→ 创建序号（#）从小到大**
- **最近访问时间**：创建/覆盖更新时取写入时刻；**发送成功**（真正进入 `Cookie` 请求头）
  的条目在每次请求演算后刷新——因此「常被发送」的条目同等优先级下更晚被淘汰。
- 新写入条目自身也可能被立即淘汰（例如高优先级旧条目已占满容量时写入 Low 新条目），
  结果中会以 `storedCookieEvicted` 与界面警告标明。

### 发送（处理请求 URL + SameSite 上下文）

除请求 URL 外，演算还需要三个 SameSite 上下文参数（界面第 2 步）：

- **顶层页面 URL**：决定 same-site 的基准站；留空时视为与请求 URL 相同（同站）；
- **请求方法**：GET / POST / …（大小写不敏感）；
- **是否顶层导航**：地址栏/链接跳转属于顶层导航；子资源、iframe、fetch 不属于。

**站点（site）= scheme + 可注册域（eTLD+1）**，可注册域由公共后缀列表
（tldts 内置 PSL，含私有域段，如 `github.io`）判定；**IP 地址与 localhost
等无可注册域的主机按完整主机比较**（`localhost` ≠ `127.0.0.1`，端口不参与）。
请求站与顶层站一致即「同站」，否则「跨站」（`http://example.com` 与
`https://example.com` 因 scheme 不同也算跨站）。

逐条检查（顺序与 RFC 6265 一致）：

1. **过期检查**：已过期不发送（罐中保留并标灰显示）；
2. **Domain 匹配**：host-only 仅精确匹配原主机；Domain cookie 匹配该域及其子域；
3. **Path 匹配**：请求路径与 cookie-path 相等，或以其开头且边界字符是 `/`；
4. **Secure 检查**：Secure cookie 只在 `https:` 请求中发送；
5. **SameSite 检查**（仅跨站时拦截）：
   - `Strict`：**仅同站发送**；
   - 显式 `Lax`：同站，或**跨站顶层导航的安全方法**（GET/HEAD/OPTIONS/TRACE）；
   - **默认 Lax**（未声明/非法值）：同上，另允许**创建不超过 120 秒的跨站顶层 POST**
     （对齐 Chrome 的 Lax+POST 缓解，按首次创建时间计算）；
   - `None`：跨站照常发送（入罐时已强制 Secure）。

通过检查的条目按：

> **Path 长度降序 → 首次创建顺序（#序号）升序**

排序后以 `; ` 拼接成 `Cookie` 请求头（RFC 6265 的 cookie 排序要求）。

---

## 🔌 HTTP API

| 方法 | 路径 | Body（JSON） | 说明 |
|------|------|--------------|------|
| GET | `/api/jar` | — | 当前罐快照（含 `limits` 用量视图：全局与各可注册域条数/上限） |
| POST | `/api/store` | `{ "url": "...", "setCookie": "...", "globalLimit"?: number\|null, "domainLimits"?: { [regDomain]: number } }` | 顺序写入一条 Set-Cookie；容量字段可选，带上时先应用再入罐，返回 `eviction` 两级淘汰报告 |
| POST | `/api/send` | `{ "url": "...", "topUrl"?: "...", "method"?: "GET", "topLevelNav"?: true }` | 演算 Cookie 头与逐项原因（SameSite 上下文均可缺省：顶层页=请求 URL、GET、顶层导航，即同站）；发送项的最近访问时间随之刷新 |
| GET | `/api/limits` | — | 当前容量配置（`limits`）与实时用量（`usage`） |
| POST | `/api/limits` | `{ "globalLimit"?: number\|null, "domainLimits"?: { [regDomain]: number } }` | 设置容量（缺省字段/null = 不限；须为 ≥1 整数）；不立即触发淘汰 |
| POST | `/api/reset` | — | 清空内存罐（**容量配置保留**） |

容量字段格式：`globalLimit` 为全局条数上限；`domainLimits` 是「可注册域 → 上限」对象。
值必须是 **≥1 的整数**；`null` / 缺省 / 空对象表示该级**不限**。

curl 示例：

```bash
# 写入（SameSite 大小写不敏感；SameSite=None 必须带 Secure）
curl -s -X POST http://localhost:3000/api/store \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://shop.example.com/admin/dashboard",
       "setCookie":"sid=abc; Domain=example.com; Path=/; Max-Age=3600; Secure; SameSite=Lax; Priority=High"}'

# 带容量写入：example.com 域最多 2 条、全局最多 5 条；返回 eviction 淘汰报告
curl -s -X POST http://localhost:3000/api/store \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/",
       "setCookie":"a=1; Path=/; Priority=Low",
       "globalLimit":5,
       "domainLimits":{"example.com":2}}'

# 单独设置/查看容量（null 表示不限）
curl -s -X POST http://localhost:3000/api/limits \
  -H 'Content-Type: application/json' \
  -d '{"globalLimit":10,"domainLimits":{"example.com":3}}'
curl -s http://localhost:3000/api/limits

# 演算请求（跨站顶层导航 GET：Strict 被拦截，Lax/None 放行）
curl -s -X POST http://localhost:3000/api/send \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://api.example.com/orders/123",
       "topUrl":"https://other.org/", "method":"GET", "topLevelNav":true}'

# 重置（罐清空，容量配置保留）
curl -s -X POST http://localhost:3000/api/reset
```

---

## 📁 项目结构

```
.
├── Dockerfile              # 多阶段构建：tsc 编译 → 精简运行镜像
├── docker-compose.yml      # 单条命令启动（3000:3000）
├── package.json
├── tsconfig.json
├── src
│   ├── server.ts           # Express 入口与 API
│   └── cookieJar.ts        # 全部 Cookie 演算规则（解析/入罐/匹配/排序/SameSite 站点演算）
└── public
    ├── index.html          # 原生前端页面
    ├── styles.css
    └── app.js
```

## 不用 Docker 的本地运行

需要 Node.js 18+（推荐 20）：

```bash
npm install
npm run build      # tsc 编译到 dist/
npm start          # 打开 http://localhost:3000
```

开发模式（免编译，自动 ts-node 直跑）：

```bash
npm run dev
```

> 说明：本工具是**演算/教学工具**，Cookie 仅存于服务端进程内存，刻意只实现
> Domain / Path / Max-Age / Secure / SameSite / Priority 等题目要求的规则，
> 并以「条数」模拟每可注册域与全局容量压力；不处理 HttpOnly 发送限制（仅展示标签）、
> Expires（仅 Max-Age）、单条 cookie 字节大小等。
