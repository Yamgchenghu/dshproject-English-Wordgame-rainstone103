# 三玖关 · 三玖课文关 私服

> 一个可以自己架的背单词 / 背课文服务。**零第三方依赖、零数据库、免构建**，
> 下载下来 `node server/index.js` 就能玩；手机 App 把 `baseUrl` 指过来就能连。

[![Node](https://img.shields.io/badge/node-%3E%3D18-3c873a)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![API](https://img.shields.io/badge/API-docs%2FAPI.md-4f8cff)](docs/API.md)

---

## 这是什么

两种玩法，共用一套答题内核：

| 玩法 | 单位 | 数据目录 | 说明 |
|---|---|---|---|
| **三玖关** | 词 | `data/TYClevel/` | 卷面给中文，默写英文 |
| **三玖课文关** | 句 | `data/TYCtextlevel/` | 同样的流程，但一次背一整句课文 |
| **历史关** | 同上 | 同上（旧文件） | 回头复习以前上传过的关，**不记进度、不发整关奖励** |

流程（前两种一致）：

1. 每 **10 题**一组，题目打乱
2. **学习模式**：先逐题看完整英文 + 译文 + 朗读，照着**敲一遍**才能过
3. 学完这组立刻**考**：卷面只有中文，凭记忆敲英文
4. 第 1 次错给提示，第 2 次错亮答案；本组 **85% 达标**才计完成、才发积分
5. 整关考完，把**错了不止一次**的题再补考一遍

> 学习顺序与考试顺序**故意不同** —— 否则"先学一遍"就等于直接给答案。

### 历史关

上传新关时若没指定关号，会取"当前最大号 + 1"，**旧文件原样留在盘上**。
编号最大的是现役关，其余天然就是历史关 —— 所以这个功能不占额外存储、也不会丢东西。

网页每个模式页底部都有「历史关」表格，点「复习」或「学习」即可进入。
复习历史关：

- **全部题都参与**，不跳过已经做过的
- **不读也不写进度**，完成度只算这一次
- 不发整关奖励

> 为什么不写进度：历史关是"回头复习"，不是主线。若也读写那份完成记录，
> 复习一遍就会把现役关的完成度搅乱（完成度按题目 id 存，跨关会串）。

---

## 快速开始

```bash
git clone <this repo> sanjian-wordgame
cd sanjian-wordgame
node server/index.js
```

打开 <http://localhost:8787> 即可。

就这两步。**不需要 `npm install`**（后端零依赖），**不需要构建**（前端是原生 JS）。

首次启动会自动在 `data/` 里塞一份示例关卡，避免打开就是空白页。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（只想本机访问填 `127.0.0.1`） |
| `DATA_DIR` | `./data` | 数据目录（关卡 / 进度 / 语音缓存） |
| `ADMIN_TOKEN` | 空 | 上传口令。**不设时只允许本机上传** |
| `LOG` | 开 | 设 `0` 关掉每请求日志 |

```bash
PORT=9000 ADMIN_TOKEN=$(openssl rand -hex 16) node server/index.js
```

> Windows 控制台若把中文显示成乱码，先执行 `chcp 65001`。

---

## 密钥配置（可选）

语音朗读和"上传时自动补中文"需要外部 API key。**全部可以不配**，
不配时对应功能优雅降级（朗读按钮消失、上传不补中文），不会报错。

```bash
cp config/keys.example.json config/keys.json
# 编辑 config/keys.json 填入真实 key
```

预留的槽位（就是用户点名要的那几个）：

```jsonc
{
  "qwen":          { "api": { "key": "" } },   // 语音（主）
  "mimo":          { "api": { "key": "" } },   // 语音（备）
  "deepseek":      { "api": { "key": "" } },   // 补中文
  "gpt":           { "api": { "key": "" } },   // 补中文
  "grok":          { "api": { "key": "" } },   // 补中文
  "gemini":        { "api": { "key": "" } },   // 补中文
  "genimi":        { "api": { "key": "" } },   // 同上（两种拼法都认）
  "doubao":        { "api": { "key": "" } },   // 补中文
  "qwentokenplan": { "api": { "key": "" } },   // 语音（qwen 套餐端点）
  "mimotokenplan": { "api": { "key": "" } }    // 语音（mimo 套餐端点）
}
```

也可以用**环境变量**（优先级高于文件），适合 Docker / systemd：

`QWEN_API_KEY` `MIMO_API_KEY` `DEEPSEEK_API_KEY` `GPT_API_KEY` / `OPENAI_API_KEY`
`GROK_API_KEY` / `XAI_API_KEY` `GEMINI_API_KEY` / `GOOGLE_API_KEY`
`DOUBAO_API_KEY` / `ARK_API_KEY` `QWEN_TOKENPLAN_API_KEY` `MIMO_TOKENPLAN_API_KEY`

改完不用重启：

```bash
curl http://localhost:8787/api/keys/status
```

这个接口**只回答"配没配"，永远不回显 key 本身**。

> ⚠️ `config/keys.json` 已在 `.gitignore` 里，**不会被提交**。请勿把真实 key 写进
> `keys.example.json` 或任何会被提交的文件。

---

## 手机 App 接入

App 只需要三件事：`baseUrl`、`deviceId`、接口路径。

```bash
# 1) 领设备令牌（deviceId 自己生成 UUID，本地永久保存）
curl -X POST http://<你的服务器>:8787/api/wordgame/m/device \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"my-phone-uuid","platform":"android"}'
# → {"ok":true,"token":"..."}

# 2) 之后每个请求带这个头
#    X-Device-Token: <token>

# 3) 拉关卡
curl 'http://<你的服务器>:8787/api/wordgame/m/level'        -H 'X-Device-Token: ...'
curl 'http://<你的服务器>:8787/api/wordgame/text/m/level'   -H 'X-Device-Token: ...'
```

- 令牌是**无状态**的（`base64url(deviceId).HMAC`），服务器不存设备表，重启不失效
- 所有 `/m/*` 响应（含错误响应）都带 `Access-Control-Allow-Origin: *`，WebView 直接能用
- 完整字段说明见 **[docs/API.md](docs/API.md)**

---

## 上传关卡

```bash
# 词表：每行「英文<TAB>中文」
curl -X POST http://localhost:8787/api/wordgame/upload \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -F "file=@words.txt"

# 课文：可以直接粘一整段散文，自动切句 + 配对译文
curl -X POST http://localhost:8787/api/wordgame/text/upload \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -F "file=@passage.txt"
```

也可以直接在网页上点「上传」页签粘贴。

课文支持三种格式：

1. 每行 `英文<TAB>中文`
2. 每行一句（英文、中文各自成行）
3. **直接粘一整段** —— 英文一段 + 中文一段，自动切句并按顺序配对

`num` 留空则自动取"当前最大关号 + 1"。上传会替换现役关卡并清空该玩家的完成记录。

---

## 目录结构

```
server/
  index.js    入口：路由装配、静态服务、CORS、启动
  config.js   配置与密钥（点号路径，env 优先）
  http.js     极简 HTTP 框架：路由/中间件/限流/错误
  store.js    数据层：词表与课文解析、关卡读写、玩家进度
  scoring.js  计分引擎（纯函数）
  game.js     三玖关与课文关的完整答题流程（一套代码生成两套路由）
  mobile.js   手机端接口 + 设备令牌 + 语音
  tts.js      语音合成（qwen / mimo / 套餐端点）+ 磁盘缓存
  llm.js      大模型补中文（deepseek / gpt / grok / gemini / doubao）
  static.js   静态文件
public/       免构建前端（index.html + app.js + style.css）
docs/API.md   公开接口文档
config/       密钥模板
data/         运行期数据（关卡、进度、语音缓存）
test/         单元测试 + 端到端自检
```

---

## 测试

```bash
npm test                      # 单元测试（24 个）
node test/selfcheck.mjs       # 端到端自检（需先启动服务）24 项
node test/history-check.mjs   # 历史关自检（43 项，会写入测试关卡）
```

`selfcheck.mjs` / `history-check.mjs` 会真的跑完两条玩法链路、手机端接口、
CORS 预检、密钥槽位与上传。**它们会往 `data/` 里写测试关卡**，
介意的话跑完把 `data/TYClevel`、`data/TYCtextlevel` 里编号 10xxxx 以外的文件删掉即可。

---

## 部署

**systemd**

```ini
[Unit]
Description=sanjian-wordgame
After=network.target

[Service]
WorkingDirectory=/opt/sanjian-wordgame
ExecStart=/usr/bin/node server/index.js
Environment=PORT=8787
Environment=ADMIN_TOKEN=换成你的口令
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

**反向代理**：所有接口都在 `/api/` 下，前端是纯静态。
若走 Nginx，记得给 `/m/*` 与 `/tts*` 保留 CORS 头（或者干脆直接暴露 8787）。

**备份**：整个 `data/` 目录复制走即可（关卡 + 进度 + 缓存）。

---

## 设计取舍（为什么长这样）

- **零第三方依赖**：只要有一个 npm 依赖，用户就得先 `npm install`，再遇到锁文件、
  镜像源、Node 版本不兼容。这点路由功能自己写不到 200 行，换来"零安装"划算。
- **零数据库**：进度就是"哪些题做完了"，一个 JSON 文件足够；备份 = 复制目录。
- **免构建前端**：引入构建步骤就多一道失败点。原生 JS 改一行刷新就生效。
- **判分只信服务端**：借来的题第二次对只给 5 分、两次错 0 分不计完成、整篇奖励要等
  全部完成……分支太多，前端再实现一遍必然漂移（界面写"已达标"却没发分是最糟的）。
- **词与课文分目录**：词表一行是"词/释义"，课文一行是一整句，解析规则不同。
  混在一起换个读法就会把课文当词表解析出一堆垃圾，而且现场看不出来。
- **课文不拆 `/` 和 `=`**：散文里的 `and/or`、`km/h` 是字面写法，
  按并列拆开会让用户敲 `and` 也算对。词表才需要拆（那里 `/` 确实是并列符号）。

---

## 已知限制

- 课文只接受 txt。单词表那套"识图 + 补中文"的收费链路没有复制过来 ——
  课文是整句，OCR 错一个词整句就没法背，收益低于成本。
- 没有账号系统，只有设备/玩家标识。多人共用一台私服时，进度按标识隔离。
- 语音缓存上限 800 个文件 / 120MB，超了按最久未用淘汰。
- 自定义关槽位不在此版本范围内（只做三玖关、三玖课文关、历史关）。
- 历史关不能删除、不能改名：想清掉就删 `data/` 里对应的 `.txt`。

---

## 许可

代码：[MIT](LICENSE)。

关卡内容（词表 / 课文）由使用者自行提供，其版权归原作者所有，不在本仓库授权范围内。
