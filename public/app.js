/**
 * 三玖关 · 三玖课文关 私服 —— 前端（免构建，原生 JS）
 * ==================================================================
 * 【为什么不用 React + 构建】
 *   这是个"拷走目录、node 一跑就能玩"的私服。只要引入构建步骤，
 *   用户就得先 npm install、再 build，失败一环就卡住。
 *   零构建换来的是：下载即运行，改一行刷新就生效。
 *
 * 【判分为什么全信服务端】
 *   借来的题第二次对只给 5 分、两次都错 0 分且不计完成、整篇奖励要等全部完成……
 *   分支太多，前端再实现一遍迟早和服务端不一致（界面写"已达标"而没发分是最糟的）。
 *   本地只维护**进度**（第几题/第几次尝试），分数一律用响应里的 earnedScore。
 */
(function () {
  'use strict';

  /* ------------------------------ 常量 ------------------------------ */
  const API = '/api/wordgame';
  const KINDS = {
    word: { path: API, idKey: 'wid', unit: '词', one: '这个词', name: '三玖关' },
    text: { path: API + '/text', idKey: 'sid', unit: '句', one: '这句', name: '三玖课文关' },
  };

  const PLAYER_KEY = 'sanjian.playerId';
  const ADMIN_KEY = 'sanjian.adminToken';

  /* ------------------------------ 状态 ------------------------------ */
  const state = {
    tab: 'word',
    kind: 'word',
    info: null,          // 当前 kind 的 info
    infoAll: null,       // 两个 kind 的 info
    history: [],         // 当前 kind 的历史关列表
    keys: null,
    play: null,
    studyAt: null,
    attempt: 1,
    input: '',
    hint: '',
    reveal: null,
    feedback: null,
    groupSettle: null,
    levelSettle: null,
    busy: false,
    err: '',
    msg: '',
    ttsUrls: new Map(),  // text -> objectURL
    noticeDismissed: false,
  };

  /* ------------------------------ 工具 ------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function playerId() {
    let v = localStorage.getItem(PLAYER_KEY);
    if (!v) {
      v = 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(PLAYER_KEY, v);
    }
    return v;
  }

  function adminToken() {
    return localStorage.getItem(ADMIN_KEY) || '';
  }

  function toast(msg, bad) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (bad ? ' bad' : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
  }

  /** 与 server/scoring.js 的 norm 完全一致：标点当空格、压缩空白、保留撇号与连字符 */
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[\u2019\u2018]/g, "'")
      .replace(/[^a-z0-9\u3400-\u9fff'\-\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ------------------------------ API ------------------------------ */
  async function api(path, opt) {
    const o = opt || {};
    const headers = { 'X-Player-Id': playerId() };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.admin) {
      if (adminToken()) headers['X-Admin-Token'] = adminToken();
    }
    const res = await fetch(path, {
      method: o.method || 'GET',
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json().catch(() => null);
    else data = await res.text().catch(() => '');
    if (!res.ok) {
      const e = new Error((data && data.message) || ('HTTP ' + res.status));
      e.status = res.status;
      e.code = (data && data.code) || '<error>';
      throw e;
    }
    return data;
  }

  async function loadKeys() {
    try { state.keys = await api('/api/keys/status'); } catch { state.keys = null; }
  }

  function ttsReady() {
    const t = state.keys && state.keys.tts;
    if (!t) return false;
    return !!(t.qwen || t.mimo || t.qwentokenplan || t.mimotokenplan);
  }

  function ttsProvider() {
    const t = (state.keys && state.keys.tts) || {};
    if (t.qwen) return 'qwen';
    if (t.qwentokenplan) return 'qwentokenplan';
    if (t.mimo) return 'mimo';
    if (t.mimotokenplan) return 'mimotokenplan';
    return 'qwen';
  }

  /* ------------------------------ 渲染 ------------------------------ */
  function render() {
    const main = $('#main');
    document.querySelectorAll('#tabs .tab').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === state.tab);
    });

    if (state.tab === 'upload') { main.innerHTML = viewUpload(); return; }
    if (state.tab === 'docs') { main.innerHTML = viewDocs(); return; }

    if (state.play) {
      if (state.levelSettle) { main.innerHTML = viewLevelSettle(); return; }
      if (state.groupSettle) { main.innerHTML = viewGroupSettle(); return; }
      if (state.studyAt !== null) { main.innerHTML = viewStudy(); return; }
      main.innerHTML = viewExam();
      return;
    }
    main.innerHTML = viewHome();
  }

  /* ------------------------------ 首页 ------------------------------ */
  function viewHome() {
    const k = KINDS[state.kind];
    const info = state.info;
    if (!info) return '<div class="loading">载入中…</div>';

    const lv = info.level;
    const banner = state.err
      ? `<div class="card"><b style="color:var(--bad)">出错了</b><div class="small" style="margin-top:6px">${esc(state.err)}</div></div>`
      : '';

    if (!lv) {
      return banner + `
        <div class="card">
          <h2>${esc(k.name)}</h2>
          <p class="sub">这台私服还没有上传${k.unit === '句' ? '课文' : '关卡'}。</p>
          <div class="row" style="margin-top:14px">
            <button class="btn-primary" data-act="goto-upload">去上传</button>
          </div>
          <p class="tiny muted" style="margin-top:12px">
            管理员可用 <code>POST ${esc(k.path)}/upload</code> 上传，或直接点上面按钮。
          </p>
        </div>`;
    }

    const pct = lv.total ? Math.round((lv.completedCount / lv.total) * 100) : 0;
    return banner + `
      <div class="card">
        <div class="row between">
          <div>
            <h2>${esc(k.name)}</h2>
            <div class="sub">第 ${lv.num} 关 · 共 ${lv.total} ${k.unit} · ${lv.groups} 组</div>
          </div>
          <span class="badge ${lv.completedCount >= lv.total ? 'ok' : ''}">已完成 ${lv.completedCount}/${lv.total}</span>
        </div>

        <div class="progress" style="margin-top:10px">
          <span>${pct}% 已完成</span>
          <span class="muted">· 每 10 ${k.unit}一组，85% 达标</span>
        </div>

        <div class="row" style="margin-top:18px">
          <button class="btn-primary" data-act="start" data-study="1">学习模式进入（先学一遍再考）</button>
          <button data-act="start" data-study="0">直接开始</button>
        </div>
        <p class="tiny muted" style="margin-top:10px">
          学习模式：先看完整英文 + 译文 + 朗读，照着敲一遍，学完这组再按原流程考。
          学习顺序与考试顺序不同。
        </p>
      </div>

      <div class="card">
        <div class="row between">
          <h2 style="font-size:15px">能力</h2>
          <span class="small muted">${ttsReady() ? '朗读可用' : '未配置语音密钥，朗读关闭'}</span>
        </div>
        <div class="kv"><span class="k">语音</span><span>${ttsReady() ? '已配置' : '未配置（qwen / mimo）'}</span></div>
        <div class="kv"><span class="k">上传补中文</span><span>${state.keys && state.keys.llm && Object.values(state.keys.llm).some(Boolean) ? '可用' : '未配置模型'}</span></div>
        <div class="kv"><span class="k">我的标识</span><span class="mono tiny">${esc(playerId())}</span></div>
        <div class="row" style="margin-top:12px">
          <button class="btn-sm btn-bad" data-act="reset">清空我的进度</button>
        </div>
      </div>

      ${viewLevelTable()}
      ${viewHistory()}
    `;
  }

  /* ------------------------------ 历史关 ------------------------------ */
  /**
   * 历史关 = 以前上传过、后来被新关顶替的那些。
   * 服务端只把"编号最大的那个"当现役关，其余天然就是历史关：
   * 上传时用的文件名是关号，旧文件一直躺在盘上。
   */
  function viewHistory() {
    const k = KINDS[state.kind];
    if (!state.history.length) {
      return `
        <div class="card">
          <div class="row between">
            <h2 style="font-size:15px">历史关</h2>
            <span class="small muted">暂无</span>
          </div>
          <p class="tiny muted" style="margin-top:8px">
            上传新${k.unit === '句' ? '课文' : '关卡'}时如果用了新的关号，旧的就会自动进这里。
          </p>
        </div>`;
    }
    return `
      <div class="card">
        <div class="row between">
          <h2 style="font-size:15px">历史关（${state.history.length}）</h2>
          <span class="tiny muted">复习模式 · 不记进度</span>
        </div>
        <table class="list" style="margin-top:10px">
          <tr><th>关号</th><th>${k.unit}数</th><th>组</th><th>更新时间</th><th></th></tr>
          ${state.history.map((h) => `
            <tr>
              <td class="mono">${h.num}</td>
              <td>${h.count}</td>
              <td>${h.groups}</td>
              <td class="tiny muted">${esc((h.updatedAt || '').slice(0, 10))}</td>
              <td style="text-align:right">
                <button class="btn-sm" data-act="start-history" data-num="${h.num}">复习</button>
                <button class="btn-sm" data-act="study-history" data-num="${h.num}">学习</button>
              </td>
            </tr>`).join('')}
        </table>
        <p class="tiny muted" style="margin-top:10px">
          历史关会把全部${k.unit}都过一遍，不跳过、不写进度，所以也不发整关奖励。
        </p>
      </div>`;
  }

  function viewLevelTable() {
    const lv = state.info && state.info.level;
    if (!lv) return '';
    const k = KINDS[state.kind];
    return `
      <div class="card">
        <div class="row between">
          <h2 style="font-size:15px">整关对照表</h2>
          <button class="btn-sm" data-act="toggle-table">显示 / 隐藏</button>
        </div>
        <div id="tablebox" class="hidden" style="margin-top:12px">
          <div class="loading" style="padding:20px 0">载入中…</div>
        </div>
      </div>`;
  }

  /* ------------------------------ 学习 ------------------------------ */
  function groupIndexOfQueue(gi) {
    const q = state.play.queue;
    return q.filter((x) => x.groupIndex === gi);
  }

  /** 学习顺序：同组内按 studyPos 升序；服务端保证它 ≠ 考试顺序 */
  function studyOrderOf(gi) {
    const items = groupIndexOfQueue(gi).map((x) => ({ ...x }));
    items.sort((a, b) => (a.studyPos ?? 0) - (b.studyPos ?? 0));
    return items;
  }

  function viewStudy() {
    const p = state.play;
    const cur = p.queue[state.studyAt];
    if (!cur) return viewHomeFallback();
    const k = KINDS[p.kind];
    const order = studyOrderOf(cur.groupIndex);
    const posInGroup = order.findIndex((x) => x.id === cur.id) + 1;
    const gi = cur.groupIndex;
    const totalInGroup = groupIndexOfQueue(gi).length;
    const last = posInGroup >= totalInGroup;

    const ttsBtn = ttsReady()
      ? `<button class="btn-sm" data-act="speak" data-text="${esc(cur.en || '')}">🔊 朗读</button>`
      : '<span class="tiny muted">（未配置语音密钥）</span>';

    return `
      <div class="card">
        <div class="row between">
          <span class="progress">学习阶段 · 第 ${gi + 1} 组</span>
          <span class="progress">本组 ${posInGroup}/${totalInGroup}</span>
        </div>

        <div class="sentence-en">${esc(cur.en || '（缺英文）')}</div>
        <div class="sentence-zh">${esc(cur.zh || '（无译文）')}</div>
        <div class="row">
          ${ttsBtn}
          <span class="tiny muted">${cur.wordCount} 词 / ${cur.charCount} 字母</span>
        </div>

        <div style="margin-top:16px">
          <textarea id="study-input" placeholder="照着上面敲一遍，敲对才能继续" rows="3"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
          <div id="study-msg" class="tiny" style="margin-top:6px;color:var(--bad)"></div>
        </div>

        <div class="row between" style="margin-top:14px">
          <button class="btn-ghost btn-sm" data-act="exit">退出</button>
          <div class="row">
            <button class="btn-ghost btn-sm" data-act="skip-study">跳过学习，直接考</button>
            <button class="btn-primary" data-act="study-next">${last ? '学完了，开始考这组' : '敲对了，下一个'}</button>
          </div>
        </div>
        <p class="tiny muted center" style="margin-top:10px">
          ${last ? '本组学完了，点右边立刻按原流程考这一组' : `本组 ${totalInGroup} ${k.unit}学完后，立刻按原流程考这一组`}
        </p>
      </div>`;
  }

  /* ------------------------------ 考试 ------------------------------ */
  function viewExam() {
    const p = state.play;
    const cur = p.queue[p.qi];
    if (!cur) return viewHomeFallback();
    const k = KINDS[p.kind];
    const gi = cur.groupIndex;
    const inGroup = groupIndexOfQueue(gi);
    const posInGroup = inGroup.findIndex((x) => x.id === cur.id) + 1;

    const banner = p.requiz
      ? '<div class="card" style="padding:10px 14px;border-color:#4a3a12;background:#2a2313"><span class="small">本篇有题错了不止一次，现在是补考这一遍（不计分、不改完成度）</span></div>'
      : p.history
        ? `<div class="card" style="padding:10px 14px;border-color:#4a3a12;background:#2a2313"><span class="small">历史关 ${esc(p.historyNum)} · 复习模式（全部${esc(k.unit)}都过一遍，不记进度）</span></div>`
        : '';

    return banner + `
      <div class="card">
        <div class="row between">
          <span class="progress">${esc(k.name)} · 第 ${gi + 1} 组</span>
          <span class="progress">本组 ${posInGroup}/${inGroup.length} · 全篇 ${p.qi + 1}/${p.queue.length}</span>
        </div>

        <div class="tiny muted" style="margin-top:12px">请默写${esc(k.one)}的英文：</div>
        <div class="prompt-zh">${esc(cur.zh || '（无译文 —— 这题只能靠记忆，管理员可在上传时补译文）')}</div>
        <div class="tiny muted">${cur.wordCount} 词 / ${cur.charCount} 字母${cur.borrowed ? ' · 复习题（第二次对只给 5 分，不计完成）' : ''}</div>

        <div style="margin-top:14px">
          <textarea id="exam-input" rows="3" placeholder="${state.attempt === 1 ? '第 1 次作答（不区分大小写，标点不算错）' : '第 2 次作答'}"
            ${state.reveal ? 'disabled' : ''} autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">${esc(state.input)}</textarea>
          ${state.hint ? `<div class="hintbar">提示：<b class="mono">${esc(state.hint)}</b></div>` : ''}
          ${state.reveal ? `<div class="revealbar"><b>正确答案</b>${esc(state.reveal.en)}<div class="tiny muted" style="margin-top:4px">${esc(state.reveal.zh || '')}</div></div>` : ''}
          ${state.feedback ? `<div class="okbar">对了，+${state.feedback} 分</div>` : ''}
        </div>

        <div class="row between" style="margin-top:14px">
          <button class="btn-ghost btn-sm" data-act="exit">退出</button>
          <div class="row">
            <span class="tiny muted">本页累计 ${state.play.scoreTotal || 0} 分</span>
            <button class="btn-primary" data-act="submit" ${state.busy || state.reveal ? 'disabled' : ''}>
              ${state.busy ? '提交中…' : '提交'}
            </button>
          </div>
        </div>
      </div>`;
  }

  /* ------------------------------ 结算 ------------------------------ */
  function viewGroupSettle() {
    const r = state.groupSettle;
    const k = KINDS[state.play.kind];
    return `
      <div class="card">
        <h2>本组结算</h2>
        <div style="margin:14px 0 4px" class="big-num">${r.score} <span class="muted" style="font-size:16px">/ ${r.fullMark}</span></div>
        <div class="settle-row"><span>是否达标</span><b>${r.passed ? '<span class="badge ok">已达标</span>' : '<span class="badge bad">未达标（本组不计完成、不发分）</span>'}</b></div>
        <div class="settle-row"><span>获得积分</span><b>${r.points}</b></div>
        <div class="settle-row"><span>一次答对</span><b>${(r.firstTryList || []).length} ${k.unit}</b></div>
        <div class="settle-row"><span>两次答对</span><b>${(r.secondTryList || []).length} ${k.unit}</b></div>
        <div class="row end" style="margin-top:16px">
          ${r.isLast
            ? '<button class="btn-primary" data-act="finish-level">整篇结算</button>'
            : '<button class="btn-primary" data-act="next-group">下一组</button>'}
        </div>
      </div>`;
  }

  function viewLevelSettle() {
    const r = state.levelSettle;
    const k = KINDS[state.play.kind];
    const isHistory = !!state.play.history;
    return `
      <div class="card">
        <h2>整篇结算</h2>
        ${isHistory
          ? `<div class="card" style="margin:12px 0;padding:10px 14px;border-color:#4a3a12;background:#2a2313">
               <span class="small">${esc(r.note || '历史关是复习模式：不记录进度，也不发整关奖励')}</span>
             </div>`
          : ''}
        <div class="settle-row" style="margin-top:12px"><span>全部计入完成</span><b>${r.allCompleted ? '<span class="badge ok">是</span>' : '<span class="badge bad">否（整篇奖励不发）</span>'}</b></div>
        <div class="settle-row"><span>整篇奖励</span><b>${r.bigReward} 积分</b></div>
        <div class="settle-row"><span>${isHistory ? '本次做过' : '完成进度'}</span><b>${r.completedUnits} / ${r.totalUnits} ${k.unit}</b></div>
        <div class="row" style="margin-top:16px">
          <button class="btn-primary" data-act="close-settle">返回列表</button>
        </div>
        <p class="tiny muted" style="margin-top:12px">
          ${isHistory
            ? '复习历史关不会改动现役关的完成记录。'
            : `整篇奖励只在"全部${k.unit}都计入完成"时发放：每${k.unit} ${r.totalUnits ? (r.bigReward / r.totalUnits || (state.play.kind === 'text' ? 0.5 : 0.1)) : (state.play.kind === 'text' ? 0.5 : 0.1)} 积分 × ${r.totalUnits}。`}
        </p>
      </div>`;
  }

  function viewHomeFallback() {
    state.play = null;
    state.studyAt = null;
    return viewHome();
  }

  /* ------------------------------ 上传 ------------------------------ */
  function viewUpload() {
    const isText = state.kind === 'text';
    const k = KINDS[state.kind];
    const llmOn = !!(state.keys && state.keys.llm && Object.values(state.keys.llm).some(Boolean));
    return `
      <div class="card">
        <h2>上传${esc(k.name)}</h2>
        <p class="sub">直接粘贴内容，或选一个 .txt 文件。上传会替换这台私服的现役${k.unit === '句' ? '课文' : '关卡'}。</p>

        <label class="field" style="margin-top:14px">
          <span>管理口令（服务端设置了 ADMIN_TOKEN 才需要；未设置时只允许本机上传）</span>
          <input id="admin-token" type="password" placeholder="X-Admin-Token" value="${esc(adminToken())}" />
        </label>

        <label class="field">
          <span>${isText ? '课文内容 —— 每行「英文<TAB>中文」，或直接粘整段（英文一段 + 中文一段，自动切句配对）' : '词表内容 —— 每行「英文<TAB>中文」或「英文 中文」'}</span>
          <textarea id="upload-text" rows="10" placeholder="${isText
            ? 'The morning train was late again.\\t早班火车又晚点了。\n…'
            : 'vocabulary\\tn. 词汇\nsuppress\\tv. 抑制'}"></textarea>
        </label>

        <div class="row">
          <input id="upload-file" type="file" accept=".txt,text/plain" style="max-width:260px" />
          ${isText ? '' : `<label class="row tiny muted" style="gap:6px"><input type="checkbox" id="fill-cn" style="width:auto" ${llmOn ? '' : 'disabled'} /> 用大模型补全缺失的中文${llmOn ? '' : '（未配置模型）'}</label>`}
        </div>

        <label class="field" style="margin-top:12px">
          <span>关号（留空 = 自动取下一个号）</span>
          <input id="upload-num" type="text" inputmode="numeric" placeholder="例如 100002" />
        </label>

        <div class="row" style="margin-top:8px">
          <button class="btn-primary" data-act="do-upload">上传</button>
          <button class="btn-ghost btn-sm" data-act="goto-word">切到三玖关</button>
          <button class="btn-ghost btn-sm" data-act="goto-text">切到三玖课文关</button>
        </div>
        <div id="upload-msg" class="small" style="margin-top:12px"></div>
      </div>`;
  }

  /* ------------------------------ 接口页 ------------------------------ */
  function viewDocs() {
    return `
      <div class="card">
        <h2>手机 App 怎么连这台私服</h2>
        <p class="sub">App 只需要知道三件事：<b>baseUrl</b>、<b>deviceId</b>、<b>接口路径</b>。</p>

        <pre class="code">// 1) 领设备令牌（只需一次，deviceId 本地保存）
POST {baseUrl}/api/wordgame/m/device
{ "deviceId": "my-phone-uuid", "platform": "android" }
→ { "ok": true, "token": "..." }

// 2) 之后每个请求都带
X-Device-Token: &lt;token&gt;

// 3) 拉三玖关 / 三玖课文关
GET {baseUrl}/api/wordgame/m/level?scope=sanj
GET {baseUrl}/api/wordgame/text/m/level</pre>

        <p class="small" style="margin-top:14px">
          完整字段说明见 <a href="/docs/API.md" target="_blank" rel="noreferrer">docs/API.md</a>。
          本机当前地址：<span class="mono tiny">${esc(location.origin)}</span>
        </p>

        <div class="row" style="margin-top:14px">
          <button class="btn-sm" data-act="copy-base">复制 baseUrl</button>
          <button class="btn-sm" data-act="copy-device">复制我的 deviceId</button>
        </div>
      </div>

      <div class="card">
        <h2 style="font-size:15px">常用接口一览</h2>
        <table class="list">
          <tr><th>方法</th><th>路径</th><th>说明</th></tr>
          <tr><td>GET</td><td class="mono">/api/wordgame/info</td><td>关卡信息 + 能力</td></tr>
          <tr><td>GET</td><td class="mono">/api/wordgame/level?study=1</td><td>开一局（study=1 才下发英文）</td></tr>
          <tr><td>POST</td><td class="mono">/api/wordgame/answer</td><td>作答</td></tr>
          <tr><td>POST</td><td class="mono">/api/wordgame/group/finish</td><td>组结算</td></tr>
          <tr><td>POST</td><td class="mono">/api/wordgame/level/finish</td><td>整篇结算</td></tr>
          <tr><td>POST</td><td class="mono">/api/wordgame/requiz</td><td>错题补考</td></tr>
          <tr><td>POST</td><td class="mono">/api/wordgame/upload</td><td>上传（需管理口令）</td></tr>
          <tr><td>GET</td><td class="mono">/api/keys/status</td><td>哪些密钥已配置（不回显）</td></tr>
        </table>
        <p class="tiny muted" style="margin-top:10px">课文版把上表的 <span class="mono">/api/wordgame</span> 换成 <span class="mono">/api/wordgame/text</span>。</p>
      </div>`;
  }

  /* ------------------------------ 动作 ------------------------------ */
  async function loadInfo(kind) {
    const k = KINDS[kind];
    try {
      state.info = await api(k.path + '/info');
      if (!state.infoAll) state.infoAll = {};
      state.infoAll[kind] = state.info;
      state.err = '';
    } catch (e) {
      state.info = null;
      state.err = e.message;
    }
    // 历史关单独一个接口，失败不影响主流程
    try {
      const h = await api(k.path + '/history');
      state.history = h.levels || [];
    } catch {
      state.history = [];
    }
  }

  async function startPlay(study, opts) {
    const o = opts || {};
    const kind = state.kind;
    const k = KINDS[kind];
    state.busy = true;
    state.err = '';
    try {
      const q = [];
      if (o.history) {
        q.push('mode=history', 'num=' + encodeURIComponent(o.num));
      }
      if (study) q.push('study=1');
      const d = await api(k.path + '/level' + (q.length ? '?' + q.join('&') : ''));
      const queue = [];
      for (const g of d.groups || []) {
        for (const it of g.items || []) queue.push({ ...it, id: it[k.idKey], groupIndex: g.index });
      }
      if (!queue.length) throw new Error('这一篇没有可' + (kind === 'text' ? '背' : '答') + '的内容');

      state.play = {
        kind, sessionId: d.sessionId, queue, qi: 0,
        study: !!study, requiz: false, history: !!o.history,
        historyNum: o.history ? o.num : null,
        scoreTotal: 0,
        levelNum: d.levelNum, totalUnits: d.totalUnits,
        wrong: new Map(),
      };
      state.groupSettle = null;
      state.levelSettle = null;
      resetAnswerState();

      /*
       * 学习从"学习顺序的第一题"开始，不是 queue[0]。
       * 曾经写成 0：queue[0] 在学习顺序里可能排第 8，而"下一个"是沿着学习顺序往后走，
       * 于是只学了第 8、9、10 题就发卷，前面七题从没给用户看过 ——
       * 界面不报错，只表现为"本组学习 8/10"。
       */
      if (study) {
        const first = studyOrderOf(0)[0];
        state.studyAt = first ? queue.findIndex((x) => x.id === first.id) : 0;
      } else {
        state.studyAt = null;
      }
    } catch (e) {
      state.err = e.message;
      toast(e.message, true);
    } finally {
      state.busy = false;
      render();
      focusInput();
    }
  }

  function resetAnswerState() {
    state.attempt = 1;
    state.input = '';
    state.hint = '';
    state.reveal = null;
    state.feedback = null;
  }

  function focusInput() {
    const el = document.getElementById(state.studyAt !== null ? 'study-input' : 'exam-input');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }

  function studyNext() {
    const p = state.play;
    if (!p || state.studyAt === null) return;
    const cur = p.queue[state.studyAt];
    const typed = (document.getElementById('study-input') || {}).value || '';
    if (norm(typed) !== norm(cur.en)) {
      const msg = document.getElementById('study-msg');
      if (msg) msg.textContent = '敲错了，再对着上面看一遍（标点、大小写不计）';
      return;
    }
    const order = studyOrderOf(cur.groupIndex);
    const pos = order.findIndex((x) => x.id === cur.id);
    if (pos + 1 >= order.length) {
      // 本组学完 -> 开始考这一组
      state.studyAt = null;
      resetAnswerState();
      // 考试必须从本组第一题开始（queue 顺序即考试顺序）
      const gi = cur.groupIndex;
      state.play.qi = p.queue.findIndex((x) => x.groupIndex === gi);
    } else {
      const nextItem = order[pos + 1];
      state.studyAt = p.queue.findIndex((x) => x.id === nextItem.id);
    }
    render();
    focusInput();
  }

  function skipStudy() {
    const p = state.play;
    if (!p || state.studyAt === null) return;
    const gi = p.queue[state.studyAt].groupIndex;
    state.studyAt = null;
    resetAnswerState();
    state.play.qi = p.queue.findIndex((x) => x.groupIndex === gi);
    render();
    focusInput();
  }

  async function submitAnswer() {
    const p = state.play;
    if (!p || state.busy || state.reveal) return;
    const cur = p.queue[p.qi];
    if (!cur) return;
    const el = document.getElementById('exam-input');
    const text = (el && el.value ? el.value : '').trim();
    if (!text) return;

    state.busy = true;
    state.input = text;
    render();
    try {
      const k = KINDS[p.kind];
      const r = await api(k.path + '/answer', {
        method: 'POST',
        body: { sessionId: p.sessionId, [k.idKey]: cur.id, attempt: state.attempt, input: text },
      });
      if (r.correct) {
        state.feedback = r.earnedScore;
        p.scoreTotal = Math.round(((p.scoreTotal || 0) + Number(r.earnedScore || 0)) * 100) / 100;
        state.busy = false;
        render();
        setTimeout(() => advance(), 550);
        return;
      }
      // 答错
      p.wrong.set(cur.id, (p.wrong.get(cur.id) || 0) + 1);
      if (state.attempt === 1) {
        state.attempt = 2;
        state.hint = r.hint || '';
        state.input = '';
        state.busy = false;
        render();
        focusInput();
      } else {
        state.reveal = r.reveal || { en: '（服务端未返回答案）', zh: '' };
        state.busy = false;
        render();
        setTimeout(() => advance(), 2200);
      }
    } catch (e) {
      state.busy = false;
      toast(e.message, true);
      render();
    }
  }

  function advance() {
    const p = state.play;
    if (!p) return;
    const cur = p.queue[p.qi];
    if (!cur) return;
    const next = p.qi + 1;
    resetAnswerState();
    const groupEnd = next >= p.queue.length || p.queue[next].groupIndex !== cur.groupIndex;
    if (groupEnd) {
      finishGroup(cur.groupIndex, next);
    } else {
      p.qi = next;
      state.busy = false;
      render();
      focusInput();
    }
  }

  async function finishGroup(gi, nextQi) {
    const p = state.play;
    const k = KINDS[p.kind];
    try {
      const r = await api(k.path + '/group/finish', {
        method: 'POST',
        body: { sessionId: p.sessionId, groupIndex: gi },
      });
      const firstList = r.firstTryWords || r.firstTrySentences || [];
      const secondList = r.secondTryWords || r.secondTrySentences || [];
      state.groupSettle = {
        score: r.score, fullMark: r.fullMark, passed: r.passed, points: r.points,
        firstTryList: firstList, secondTryList: secondList,
        isLast: r.isLast, nextQi,
      };
    } catch (e) {
      toast(e.message, true);
    }
    state.busy = false;
    render();
  }

  async function finishLevel() {
    const p = state.play;
    const k = KINDS[p.kind];
    state.groupSettle = null;
    try {
      const r = await api(k.path + '/level/finish', {
        method: 'POST',
        body: { sessionId: p.sessionId },
      });
      state.levelSettle = r;
      render();

      // 整篇结束后，把"错超过一次"的题再考一遍
      if (!p.requiz && p.wrong && [...p.wrong.values()].some((n) => n > 1)) {
        await startRequiz();
      }
    } catch (e) {
      toast(e.message, true);
      render();
    }
  }

  async function startRequiz() {
    const p = state.play;
    const k = KINDS[p.kind];
    try {
      const r = await api(k.path + '/requiz', {
        method: 'POST', body: { sessionId: p.sessionId },
      });
      if (!r.sessionId || !r.groups || !r.groups.length) return;
      const queue = [];
      for (const g of r.groups) {
        for (const it of g.items || []) queue.push({ ...it, id: it[k.idKey], groupIndex: g.index });
      }
      state.levelSettle = null;
      state.play = {
        kind: p.kind, sessionId: r.sessionId, queue, qi: 0,
        study: false, requiz: true, scoreTotal: 0,
        levelNum: p.levelNum, totalUnits: queue.length,
        wrong: new Map(),
      };
      resetAnswerState();
      render();
      toast('有 ' + queue.length + ' 题错了不止一次，现在补考一遍');
      focusInput();
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function doUpload() {
    const isText = state.kind === 'text';
    const k = KINDS[state.kind];
    const msg = document.getElementById('upload-msg');
    const tokenEl = document.getElementById('admin-token');
    const textEl = document.getElementById('upload-text');
    const fileEl = document.getElementById('upload-file');
    const numEl = document.getElementById('upload-num');
    const fillEl = document.getElementById('fill-cn');

    if (tokenEl) localStorage.setItem(ADMIN_KEY, tokenEl.value.trim());

    let text = (textEl && textEl.value) || '';
    const file = fileEl && fileEl.files && fileEl.files[0];
    if (file) {
      text = await file.text();
    }
    if (!text.trim()) {
      if (msg) msg.innerHTML = '<span style="color:var(--bad)">内容为空</span>';
      return;
    }
    if (msg) msg.textContent = '上传中…';
    try {
      const body = { text, fillChinese: !!(fillEl && fillEl.checked) };
      const num = (numEl && numEl.value || '').trim();
      if (num) body.num = Number(num);
      const r = await api(k.path + '/upload', { method: 'POST', body, admin: true });
      if (msg) {
        msg.innerHTML = `<span style="color:var(--ok)">上传成功：第 ${r.num} 关，共 ${r.total} ${k.unit}${r.filled ? `，补全中文 ${r.filled} 条` : ''}</span>`;
      }
      toast('上传成功');
      await loadInfo(state.kind);
      state.tab = state.kind;
      render();
    } catch (e) {
      if (msg) msg.innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
      toast(e.message, true);
    }
  }

  async function loadTable() {
    const box = document.getElementById('tablebox');
    if (!box) return;
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const k = KINDS[state.kind];
    try {
      const d = await api(k.path + (state.kind === 'text' ? '/sentences' : '/words'));
      box.innerHTML = `
        <div class="tiny muted" style="margin-bottom:8px">共 ${d.total} ${k.unit}</div>
        <table class="list">
          ${(d.items || []).map((it, i) => `<tr><td class="muted tiny" style="width:38px">${i + 1}</td><td>${esc(it.en)}</td><td class="muted">${esc(it.zh || '')}</td></tr>`).join('')}
        </table>`;
    } catch (e) {
      box.innerHTML = `<div class="small" style="color:var(--bad)">${esc(e.message)}</div>`;
    }
  }

  async function speak(text) {
    if (!ttsReady()) return toast('未配置语音密钥', true);
    try {
      const r = await api('/api/wordgame/tts?provider=' + encodeURIComponent(ttsProvider()) + '&text=' + encodeURIComponent(text));
      const audio = new Audio(r.url);
      audio.play().catch(() => toast('浏览器拦了自动播放，再点一次', true));
    } catch (e) {
      toast('朗读失败：' + e.message, true);
    }
  }

  async function resetProgress() {
    if (!confirm('确定清空这台设备在本私服上的完成记录？')) return;
    const k = KINDS[state.kind];
    try {
      await api(k.path + '/reset', { method: 'POST', body: {} });
      toast('已清空');
      await loadInfo(state.kind);
      render();
    } catch (e) {
      toast(e.message, true);
    }
  }

  /* ------------------------------ 事件 ------------------------------ */
  document.addEventListener('click', async (ev) => {
    const tab = ev.target.closest('#tabs .tab');
    if (tab) {
      const t = tab.dataset.tab;
      if (t === 'upload' || t === 'docs') {
        state.tab = t;
        state.play = null; state.studyAt = null;
        state.groupSettle = null; state.levelSettle = null;
        render();
        return;
      }
      state.tab = t;
      state.kind = t;
      state.play = null; state.studyAt = null;
      state.groupSettle = null; state.levelSettle = null;
      state.info = null;
      render();
      await loadInfo(t);
      render();
      return;
    }

    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'start') { await startPlay(btn.dataset.study === '1'); return; }
    if (act === 'start-history') { await startPlay(false, { history: true, num: Number(btn.dataset.num) }); return; }
    if (act === 'study-history') { await startPlay(true, { history: true, num: Number(btn.dataset.num) }); return; }
    if (act === 'study-next') { studyNext(); return; }
    if (act === 'skip-study') { skipStudy(); return; }
    if (act === 'submit') { await submitAnswer(); return; }
    if (act === 'exit') {
      if (!confirm('退出这一篇？本组进度不会保留。')) return;
      state.play = null; state.studyAt = null;
      state.groupSettle = null; state.levelSettle = null;
      await loadInfo(state.kind);
      render();
      return;
    }
    if (act === 'next-group') {
      const r = state.groupSettle;
      state.groupSettle = null;
      const p = state.play;
      p.qi = r.nextQi;
      resetAnswerState();
      if (p.study && !p.requiz) {
        const gi = p.queue[r.nextQi] ? p.queue[r.nextQi].groupIndex : 0;
        const first = studyOrderOf(gi)[0];
        state.studyAt = first ? p.queue.findIndex((x) => x.id === first.id) : r.nextQi;
      } else {
        state.studyAt = null;
      }
      render();
      focusInput();
      return;
    }
    if (act === 'finish-level') { await finishLevel(); return; }
    if (act === 'close-settle') {
      state.levelSettle = null;
      state.play = null;
      state.studyAt = null;
      await loadInfo(state.kind);
      render();
      return;
    }
    if (act === 'reset') { await resetProgress(); return; }
    if (act === 'toggle-table') { await loadTable(); return; }
    if (act === 'speak') { await speak(btn.dataset.text); return; }
    if (act === 'goto-upload') { state.tab = 'upload'; render(); return; }
    if (act === 'goto-word') { state.kind = 'word'; state.tab = 'upload'; render(); return; }
    if (act === 'goto-text') { state.kind = 'text'; state.tab = 'upload'; render(); return; }
    if (act === 'do-upload') { await doUpload(); return; }
    if (act === 'copy-base') {
      navigator.clipboard.writeText(location.origin).then(() => toast('已复制 ' + location.origin));
      return;
    }
    if (act === 'copy-device') {
      navigator.clipboard.writeText(playerId()).then(() => toast('已复制 deviceId'));
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const t = ev.target;
    if (!t || t.tagName !== 'TEXTAREA') return;
    // 输入法组词中不提交（中文输入法回车选词会误触）
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.shiftKey) return; // Shift+Enter 换行
    ev.preventDefault();
    if (state.studyAt !== null) studyNext();
    else if (state.play && !state.reveal) submitAnswer();
  });

  /* ------------------------------ 启动 ------------------------------ */
  (async function boot() {
    await loadKeys();
    await loadInfo('word');
    render();
  })();
})();
