# 三玖关 · 三玖课文关 —— 公开 API

> 面向手机 App / 第三方客户端的接口文档。
> 任何一台跑着本项目的「私服」都实现这套接口，App 只要把 `baseUrl` 换掉就能连。

- 默认地址：`http://<服务器IP>:8787`
- 所有响应都是 UTF-8 JSON，除 `format=txt` 与音频二进制
- 时间一律 ISO 8601 字符串

---

## 0. 一分钟接入

```bash
# 1) 领一个设备令牌（deviceId 由 App 自己生成并永久保存）
curl -X POST http://localhost:8787/api/wordgame/m/device \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"my-phone-uuid","platform":"android"}'
# → {"ok":true,"token":"bXktcGhvbmUtdXVpZA.xxxxx","deviceId":"my-phone-uuid"}

# 2) 之后每个请求都带这个头
curl http://localhost:8787/api/wordgame/m/catalog \
  -H 'X-Device-Token: bXktcGhvbmUtdXVpZA.xxxxx'
```

> **令牌是无状态的**：`token = base64url(deviceId) + "." + HMAC-SHA256(secret, deviceId)`。
> 服务器不存设备表，重启后旧 token 依然有效。secret 首次启动生成在 `data/.device-secret`。

### 身份头一览

| 头 | 谁用 | 作用 |
|---|---|---|
| `X-Device-Token` | App | 手机身份，决定"谁的进度" |
| `X-Player-Id` | 网页 / 自建客户端 | 与设备令牌等价的轻量身份（任意 ≤64 字符） |
| `X-Admin-Token` | 管理员 | 上传关卡。服务端未设 `ADMIN_TOKEN` 时只允许本机 |

`X-Device-Token` 优先；两者都没有时，读接口仍然可用（只是不记进度）。

### CORS

所有 `/api/wordgame/m/*`、`/api/wordgame/text/m/*`、`/api/wordgame/tts*` 的响应（**含错误响应**）都带：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type, X-Auth, X-Device-Token, X-Player-Id, X-Admin-Token
```

并且 `/api/` 下所有路径的 `OPTIONS` 预检统一回 `204`，WebView 直接可用。

### 错误格式

```json
{ "ok": false, "code": "<rate-limited>", "message": "请求太频繁（上限 120 次/分钟）" }
```

`message` 是给人看的中文，**客户端可以直接展示**。常见 code：

| code | HTTP | 含义 |
|---|---|---|
| `<unauthorized>` | 401 | 没带身份或令牌无效 |
| `<no-level>` | 404 | 这台私服还没上传关卡 |
| `<no-session>` | 404 | 会话过期（30 分钟），重新 `/level` |
| `<no-api-key>` | 503 | 对应供应商没配密钥（语音/模型） |
| `<rate-limited>` | 429 | 触发限流 |
| `<forbidden>` | 403 | 管理口令不对 |
| `<empty-level>` | 400 | 上传内容解析不出任何条目 |

---

## 1. 手机端接口（推荐 App 用）

手机端是**只读**的：拿关卡、拿全部、拿语音。作答逻辑放在 App 本地或走第 2 节的完整流程。

### 1.1 领令牌

```
POST /api/wordgame/m/device
Content-Type: application/json

{ "deviceId": "my-phone-uuid", "platform": "android", "model": "Pixel", "appVersion": "1.0.0" }
```

```json
{ "ok": true, "token": "...", "deviceId": "my-phone-uuid" }
```

`deviceId` 限 64 字符，自己生成（UUID 即可）。同 IP 每小时最多 60 次。

### 1.2 探活

```
GET /api/wordgame/m/ping
GET /api/wordgame/text/m/ping
```

```json
{ "ok": true, "service": "sanjian-wordgame", "time": "2026-11-16T14:24:00.769Z",
  "tts": { "qwen": false, "mimo": false, "qwentokenplan": false, "mimotokenplan": false } }
```

用来区分三种故障：DNS/隧道不通（请求发不出去）、服务没起（连接被拒）、
服务在但模块坏（这个接口也不通）。

### 1.3 目录

```
GET /api/wordgame/m/catalog
```

```json
{
  "ok": true,
  "deviceId": "my-phone-uuid",
  "sanj": { "num": 100002, "name": "100002", "count": 10, "groups": 1,
            "completedCount": 0, "updatedAt": "2026-11-16T14:24:00.769Z" },
  "text": { "num": 100002, "name": "100002", "count": 3, "groups": 1,
            "completedCount": 0, "updatedAt": "..." },
  "history": {
    "sanj": [ { "num": 100001, "name": "100001", "count": 10, "groups": 1,
                "updatedAt": "...", "saved": false } ],
    "text": []
  },
  "caps": { "sanj": true, "text": true, "history": true,
            "tts": {...}, "export": true, "upload": true }
}
```

`sanj` / `text` 为 `null` 表示这台私服还没上传对应的关卡。
`history` 是**历史关列表**（见 §1.8），`saved: false` 表示这些关不记进度。

### 1.4 拉取一整关

```
GET /api/wordgame/m/level                     # 三玖关（词）
GET /api/wordgame/text/m/level                # 三玖课文关（句）

可选参数：
  format=json|txt    默认 json
  scope=history      取历史关（此时必须带 num）
  num=100001         scope=history 时要哪一关
  hash=<上次拿到的 hash>   内容没变则只回 { "unchanged": true }
```

```json
{
  "ok": true, "scope": "sanj", "num": 100001, "name": "100001",
  "count": 10, "hash": "4e09dc66e19b4d56", "groupSize": 10, "saved": true,
  "words": [
    { "wid": "vocabulary", "en": "vocabulary", "zh": "n. 词汇；词汇量",
      "index": 0, "wordCount": 1, "charCount": 10 }
  ]
}
```

课文版把 `words` 换成 `sentences`，`wid` 换成 `sid`。

`scope=history` 时 `scope` 回 `"history"`、`saved` 为 `false`。

**`format=txt`** 返回 `text/plain`，每行 `英文<TAB>中文`，响应头带：

```
X-WG-Hash:   内容指纹
X-WG-Count:  条目数
X-WG-Num:    关号
```

这个格式可以**原样存成 .txt 再上传回来**，适合做离线包 / 导出。

> **为什么手机端能拿到英文原文**：学习模式本来就要把整篇英文摊给用户看，
> 所以整包下载没有新增泄露面。

### 1.5 一次拿全部

```
GET /api/wordgame/m/export
GET /api/wordgame/text/m/export
```

```json
{ "ok": true, "exportedAt": "...",
  "sanj": { "num": 100002, "name": "100002", "count": 10, "hash": "...", "words": [ ... ] },
  "text": { "num": 100002, "name": "100002", "count": 3,  "hash": "...", "sentences": [ ... ] },
  "history": {
    "sanj": [ { "num": 100001, "count": 10, "hash": "...", "saved": false, "words": [ ... ] } ],
    "text": []
  } }
```

历史关默认**一并导出**，方便做离线包（想复习旧关就不必再发一次请求）。
如果只想要现役关，客户端忽略 `history` 字段即可。

限流 20 次/分钟（整包比单关大得多）。

### 1.8 历史关列表

```
GET /api/wordgame/m/catalog     # 已含 history 字段，一般不用单独调
GET /api/wordgame/history       # 网页端
GET /api/wordgame/text/history  # 课文
```

```json
{
  "ok": true,
  "current": { "num": 100002, "name": "100002", "count": 10 },
  "count": 1,
  "levels": [
    { "num": 100001, "name": "100001", "count": 10, "groups": 1,
      "updatedAt": "2026-11-16T14:24:00.769Z", "saved": false }
  ],
  "note": "历史关是复习模式：全部词都参与、不跳过、不记录进度"
}
```

**历史关怎么来的**：上传新关时若没指定关号，会取"当前最大号 + 1"，旧文件原样留着；
编号最大的那个是现役关，其余天然就是历史关。所以它不需要额外存储，也不会丢。

**历史关的语义（与现役关的区别）**

| | 现役关 | 历史关 |
|---|---|---|
| 参与题目 | 只考未完成的，不足 10 时借已完成题 | **全部题目，不跳过** |
| 读写进度 | 是 | **否**（完成度只活在本次会话） |
| 整关奖励 | 全部完成才发 | **不发** |
| 借题 | 有 | 无 |

> 为什么历史关完全不碰进度：它是"回头复习"，不是主线。若也读写那份完成记录，
> 复习一遍就会把现役关的完成度搅乱（完成度是按题目 id 存的，跨关会串）。
> 所以历史关的完成度只活在这次会话的内存里，退出即散。

### 1.6 语音

```
GET  /api/wordgame/tts?text=hello&provider=qwen
POST /api/wordgame/tts/batch      { "texts": ["a","b"], "provider": "qwen" }
GET  /api/wordgame/tts/<key>.wav
```

```json
// 单个
{ "ok": true, "key": "3f2a...", "cached": true, "bytes": 49964,
  "provider": "qwen", "url": "/api/wordgame/tts/3f2a....wav" }

// 批量（最多 20 条，内部 3 路并发）
{ "ok": true, "items": [
  { "text": "a", "ok": true, "key": "...", "url": "..." },
  { "text": "b", "ok": false, "code": "<no-api-key>", "error": "供应商 mimo 未配置密钥" } ] }
```

`provider` 可选：`qwen` / `mimo` / `qwentokenplan` / `mimotokenplan`。

服务端没配任何语音密钥时，`/tts` 返回 `503 <no-api-key>`，
`/api/wordgame/m/ping` 与 `/catalog` 的 `tts` 字段也会全 `false` —— App 据此隐藏朗读按钮。

### 1.7 限流

按**主体**计数（有令牌按设备、否则按 IP），不是只按 IP ——
手机走运营商 NAT 时一个出口 IP 后面可能有几百人。

| 接口 | 额度 |
|---|---|
| `/m/catalog`、`/m/level` | 120 次/分钟 |
| `/m/export` | 20 次/分钟 |
| `/tts` | 240 次/分钟 |
| `/tts/batch` | 60 次/分钟 |
| `/m/device` | 60 次/小时（按 IP） |

---

## 2. 完整答题流程（网页端用的就是这套）

如果不想在 App 里重写判分，可以整段走这套。**分数一律由服务端算**，
客户端只维护"第几题、第几次尝试"。

### 2.1 关卡信息

```
GET /api/wordgame/info
GET /api/wordgame/text/info
```

```json
{
  "ok": true, "player": "p_ab12cd34",
  "level": { "num": 100001, "name": "100001", "total": 10, "completedCount": 0,
             "groups": 1, "groupSize": 10, "updatedAt": "..." },
  "capabilities": { "tts": {...}, "llm": { "available": false }, "upload": true },
  "rules": { "groupSize": 10, "passRatio": 0.85, "bigRewardPerUnit": 0.1, "unit": "词" }
}
```

`level` 为 `null` 表示还没上传关卡。

### 2.2 开一局

```
GET /api/wordgame/level?study=1              # study=1 才下发英文
GET /api/wordgame/level?mode=history&num=100001   # 复习某个历史关
```

```json
{
  "ok": true, "sessionId": "s_xxx", "mode": "sanj",
  "levelNum": 100001, "levelName": "100001",
  "totalUnits": 10, "completedUnits": 0, "groupSize": 10, "saved": true,
  "groups": [
    { "index": 0, "items": [
      { "wid": "vocabulary", "zh": "n. 词汇", "wordCount": 1, "charCount": 10,
        "borrowed": false,
        "en": "vocabulary", "studyPos": 7 }        // ← 仅 study=1 时存在
    ] }
  ]
}
```

`mode` 取 `sanj` 或 `history`；`saved` 为 `false` 表示这一局不写进度（历史关）。

> ⚠ **不带 `study` 时响应里绝不能有 `en`** —— 这是防作弊的硬约束。
>
> ⚠ `studyPos` 是**学习顺序**位次，与数组顺序（考试顺序）**不同**。
> 服务端保证二者不完全一致。
>
> **客户端注意**：学习时应该从 `studyPos === 0` 的那一项开始，
> 而不是从 `items[0]` 开始。否则你可能从学习顺序的第 8 位起学，
> 只学 3 题就以为学完了（这是个真实踩过的坑）。

分组规则：

- 每 10 题一组
- 未完成题不足 10 且已存在完成题时，从**已完成题**里随机借满，
  借来的题 `borrowed: true`：第二次答对只给 5 分，且**不计完成、不发奖励**
- 换关后进度清空

### 2.3 作答

```
POST /api/wordgame/answer
{ "sessionId": "s_xxx", "wid": "vocabulary", "attempt": 1, "input": "vocabulary" }
```

课文版把 `wid` 换成 `sid`。

```json
// 答对
{ "ok": true, "correct": true, "attempt": 1, "earnedScore": 10, "completedNow": true }

// 第 1 次答错 —— 给提示
{ "ok": true, "correct": false, "attempt": 1,
  "hint": "vocab", "earnedScore": 0, "completedNow": false }

// 第 2 次答错 —— 亮答案
{ "ok": true, "correct": false, "attempt": 2,
  "reveal": { "en": "vocabulary", "zh": "n. 词汇" }, "earnedScore": 0, "completedNow": false }
```

判对口径：

- 词（三玖关）：忽略大小写/标点/多余空白，且**支持 `a/b`、`a=b` 并列写法任一**
- 句（三玖课文关）：同样忽略大小写/标点/空白，但**不拆 `/` 和 `=`** ——
  散文里的 `and/or`、`km/h` 是字面写法，拆开会让用户敲 `and` 也算对

### 2.4 组结算

```
POST /api/wordgame/group/finish
{ "sessionId": "s_xxx", "groupIndex": 0 }
```

```json
{ "ok": true, "score": 100, "fullMark": 100, "passed": true,
  "firstTryWords": ["vocabulary"], "secondTryWords": [],
  "points": 2, "isLast": true, "saved": true }
```

课文版字段名是 `firstTrySentences` / `secondTrySentences`。
历史关的 `saved` 为 `false`。

### 2.5 整关结算

```
POST /api/wordgame/level/finish
{ "sessionId": "s_xxx" }
```

```json
{ "ok": true, "saved": true, "allCompleted": true, "bigReward": 1,
  "totalUnits": 10, "completedUnits": 10 }
```

历史关：`saved:false`、`allCompleted:false`、`bigReward:0`，并附带
`note: "历史关是复习模式：不记录进度，也不发整关奖励"` —
`completedUnits` 仍然反映**本次复习**做了多少题。

### 2.6 补考（错超过一题的）

```
POST /api/wordgame/requiz
{ "sessionId": "s_xxx" }
```

```json
{ "ok": true, "sessionId": "s_yyy", "count": 2, "groups": [ ... ] }
```

返回的是新会话，`groups` 里只含"错了不止一次"的题。没有错题时 `sessionId` 为 `null`。

### 2.7 其它

```
POST /api/wordgame/reset          清空我的进度（需 X-Player-Id）
GET  /api/wordgame/words          整关对照表（?mode=history&num= 可看历史关）
GET  /api/wordgame/text/sentences 整篇对照表（同上）
GET  /api/wordgame/history        历史关列表
GET  /api/wordgame/text/history   课文历史关列表
GET  /api/wordgame/rules          规则常量
GET  /api/keys/status             哪些密钥已配置（永不回显 key）
```

---

## 3. 上传接口（管理员）

```
POST /api/wordgame/upload
POST /api/wordgame/text/upload
X-Admin-Token: <ADMIN_TOKEN>
```

两种请求体都支持：

**JSON**

```json
{ "text": "vocabulary\tn. 词汇\nsuppress\tv. 抑制", "num": 100002, "fillChinese": false }
```

**multipart/form-data**（字段名 `file`，可带 `num`、`fillChinese`）

```bash
curl -X POST http://localhost:8787/api/wordgame/upload \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -F "file=@words.txt" -F "num=100002"
```

响应：

```json
{ "ok": true, "num": 100002, "total": 10, "filled": 0,
  "preview": [ { "en": "vocabulary", "zh": "n. 词汇" } ] }
```

- `num` 留空则自动取"当前最大关号 + 1"，新关即成为**现役关**
- 指定 `num` 就是写那个号：
  - 写的是**最大号** → 覆盖现役关（视为修订）
  - 写的是**比最大号小**的号 → 这一版会成为**历史关**，现役关不变
- 上传会**替换该关**并清空该玩家的完成记录（否则新关会沿用旧关的完成度）
- `fillChinese: true` 时用大模型补全缺失的中文；**没配任何模型 key 就静默跳过**

### 文本格式

**词表**：每行 `英文<TAB>中文` 或 `英文 中文`，也认中文在前、行首编号（`1. ` / `1、` / `1)`）。

**课文**：三种都能吃

1. 每行 `英文<TAB>中文`
2. 每行一句（英文、中文各自成行）
3. **直接粘一整段散文** —— 支持"英文一段 + 中文一段"，自动切句并按顺序配对

第 3 种是给"整篇课文直接粘贴"用的，不用手工对齐。

---

## 4. 数据文件格式

```
data/TYClevel/<6位关号>.txt        三玖关（词）
data/TYCtextlevel/<6位关号>.txt    三玖课文关（句）
data/players/<sha1>.json           进度（自动生成）
data/ttscache/                     语音缓存（自动生成）
```

关卡文件都是 `英文<TAB>中文` 每行一条，纯 UTF-8。
直接改文件也能生效（重新拉 `/info` 即可，无需重启）。

---

## 5. 密钥配置

服务端从 `config/keys.json`（或环境变量）读取，预留了这些槽位：

| 点号路径 | 用途 |
|---|---|
| `qwen.api.key` | 语音（主） |
| `mimo.api.key` | 语音（备） |
| `qwentokenplan.api.key` | 语音（qwen 套餐端点） |
| `mimotokenplan.api.key` | 语音（mimo 套餐端点） |
| `deepseek.api.key` | 补全中文 |
| `gpt.api.key` | 补全中文 |
| `grok.api.key` | 补全中文 |
| `gemini.api.key` / `genimi.api.key` | 补全中文（两种拼法都认） |
| `doubao.api.key` | 补全中文 |

留空 = 该能力关闭，接口优雅降级，不会报错。

`GET /api/keys/status` 只会回答"配没配"，**永远不回显 key**。
