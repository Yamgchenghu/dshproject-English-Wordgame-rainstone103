/**
 * 数据层：词表 / 课文 / 玩家进度 / 文件读写。
 * ==================================================================
 * 【为什么词和课文分两个目录】
 *   词表一行是一对"词/释义"，课文一行是一整句，两者解析规则不同。
 *   混在一个目录里，换个读法就会把课文当词表解析出一堆垃圾条目，
 *   而且现场看不出来。分目录之后"读错目录"这件事物理上不可能发生。
 *
 * 【为什么进度是一个 JSON 文件而不是数据库】
 *   私服的使用者通常是自己和几个朋友，进度就是"哪些题做完了"。
 *   一个 JSON 文件足够，且备份 = 复制 data/ 目录，迁移 = 拷走就行。
 *   为了少一个依赖（node:sqlite 在 Node 22 才稳定）而上一套 DB 不划算。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './config.js';

export const LEVEL_RE = /^(\d{6})\.txt$/i;

export function dirs() {
  const d = dataDir();
  return {
    root: d,
    words: path.join(d, 'TYClevel'),
    texts: path.join(d, 'TYCtextlevel'),
    players: path.join(d, 'players'),
    tts: path.join(d, 'ttscache'),
  };
}

export function ensureDirs() {
  const d = dirs();
  for (const p of [d.root, d.words, d.texts, d.players, d.tts]) {
    fs.mkdirSync(p, { recursive: true });
  }
  return d;
}

/** 题目 id：小写 + 空白归一化。跨端、跨次请求稳定，手机端本地存档就拿它当主键。 */
export function idOf(en) {
  return String(en == null ? '' : en).toLowerCase().replace(/\s+/g, ' ').trim();
}

const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/* ---------------------------- 词表解析 ---------------------------- */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * 词表：每行 `英文<TAB>中文` 或 `英文 中文`（也接受中文在前、行首编号）。
 * 返回 [{ en, zh }]，按 en 去重（保留第一条）。
 */
export function parseWords(text) {
  const out = [];
  for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
    let line = rawLine.replace(/^\s*\d+\s*[.、)．]\s*/, '').trim();
    if (!line) continue;

    let en = '';
    let zh = '';
    const tab = line.indexOf('\t');
    if (tab >= 0) {
      en = line.slice(0, tab).trim();
      zh = line.slice(tab + 1).trim();
    } else {
      const cjkAt = line.search(CJK_RE);
      if (cjkAt > 0) {
        // 中文在后：英文 ... 中文
        en = line.slice(0, cjkAt).trim();
        zh = line.slice(cjkAt).trim();
      } else if (cjkAt === 0) {
        // 中文在前：中文 ... 英文（词表里确实有这种排法）
        const latinAt = line.search(/[A-Za-z]/);
        if (latinAt > 0) {
          zh = line.slice(0, latinAt).trim();
          en = line.slice(latinAt).trim();
        } else {
          zh = line.trim();
        }
      } else {
        en = line.trim();
      }
    }
    // 去掉英文末尾常带的标点/词性标记残留
    en = collapse(en).replace(/[,;:]+$/, '').trim();
    zh = collapse(zh);
    if (!en) continue;
    out.push({ en, zh });
  }
  const seen = new Set();
  const uniq = [];
  for (const it of out) {
    const id = idOf(it.en);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniq.push(it);
  }
  return uniq;
}

export function formatWords(list) {
  return (list || []).map((w) => `${w.en}\t${w.zh || ''}`).join('\n') + '\n';
}

/* ---------------------------- 课文解析 ---------------------------- */

/**
 * 句子边界。
 *
 * 【为什么中文标点后面不能要求空白】
 *   英文习惯句号后打一个空格（"A. B."），中文习惯紧挨着写（"甲。乙。"）。
 *   若统一写成 `(?<=[.!?。！？…])\s+`，一整段中文会被当成**一整句**
 *   —— 10 句译文变成 1 条超长译文，只配上第 1 句英文，课文整个错位，
 *   而界面完全看不出异常。所以中英文标点分别处理：
 *   英文标点后要空白才算边界，中文标点后直接断。
 *
 * 【英文标点后加了"缩写保护"】
 *   只按"点+空格"切，会把 `Mr. Smith`、`3.14 and` 也切开。
 *   办法是先把这些点换成占位符再切，切完还原 —— 纯正则前瞻做不到
 *   "前面是不是一个缩写词"，而这个判断必须看前面的字符。
 */
const SENT_SPLIT = /(?<=[.!?…])\s+|(?<=[。！？；])|\n+/;

/** 常见缩写：这些词的句点不是句子边界 */
const ABBR = /\b(Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|No|Fig|Inc|Ltd|Co|approx|dept|e\.g|i\.e|U\.S|a\.m|p\.m)\./gi;
const DOT_PLACEHOLDER = '\u0000';

function protectDots(s) {
  return s.replace(ABBR, (m) => m.slice(0, -1) + DOT_PLACEHOLDER)
    // 小数：3.14
    .replace(/(\d)\.(\d)/g, '$1' + DOT_PLACEHOLDER + '$2');
}

function restoreDots(s) {
  return s.split(DOT_PLACEHOLDER).join('.');
}

/**
 * 课文：支持三种输入
 *   1. 每行 `英文<TAB>中文`
 *   2. 每行一句（英文、中文各自成行）—— 走词表那套行解析
 *   3. 整段散文（英文一段 + 中文一段）—— 切句后按出现顺序配对
 */
export function parseText(text) {
  const raw = String(text == null ? '' : text);
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  if (lines.some((l) => l.includes('\t'))) {
    const out = [];
    for (const l of lines) {
      const i = l.indexOf('\t');
      out.push({ en: collapse(i < 0 ? l : l.slice(0, i)), zh: i < 0 ? '' : collapse(l.slice(i + 1)) });
    }
    const got = dedupePairs(out);
    if (got.length) return got;
  }

  if (lines.length >= 2 && lines.every((l) => /[A-Za-z]/.test(l))) {
    const got = parseWords(raw);
    if (got.length) return got;
  }

  // 整段：分列后按顺序配对（按序号配，不按相似度 —— 相似度在句数不等时会静默错位）
  const protectedRaw = protectDots(raw);
  const units = protectedRaw.split(SENT_SPLIT).map((u) => collapse(restoreDots(u))).filter(Boolean);
  const engs = [];
  const zhs = [];
  for (const u of units) {
    const cjkCount = (u.match(/[\u3400-\u9fff]/g) || []).length;
    const latinCount = (u.match(/[A-Za-z]/g) || []).length;
    if (typeof u === 'string' && u.length && cjkCount > latinCount / 4) zhs.push(u);
    else if (/[A-Za-z]/.test(u)) engs.push(u);
  }
  const out = [];
  const n = Math.max(engs.length, zhs.length);
  for (let i = 0; i < n; i++) out.push({ en: engs[i] || '', zh: zhs[i] || '' });
  return dedupePairs(out);
}

function dedupePairs(list) {
  const seen = new Set();
  const out = [];
  for (const it of list) {
    const en = collapse(it && it.en);
    if (!en) continue;
    const id = idOf(en);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ en, zh: collapse(it.zh) });
  }
  return out;
}

export function formatText(list) {
  return (list || []).map((s) => `${s.en}\t${s.zh || ''}`).join('\n') + '\n';
}

/* ---------------------------- 关卡文件 ---------------------------- */

export function listLevels(kind) {
  const d = dirs();
  const dir = kind === 'text' ? d.texts : d.words;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .map((n) => LEVEL_RE.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a); // 新的在前
}

export function levelPath(kind, num) {
  const d = dirs();
  const dir = kind === 'text' ? d.texts : d.words;
  return path.join(dir, String(num).padStart(6, '0') + '.txt');
}

export function readLevelFile(kind, num) {
  const p = levelPath(kind, num);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function writeLevelFile(kind, num, list) {
  ensureDirs();
  const p = levelPath(kind, num);
  const body = kind === 'text' ? formatText(list) : formatWords(list);
  const tmp = p + '.tmp' + process.pid;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

/** 读一个指定编号的关卡；不存在/解析不出内容返回 null */
export function loadLevel(kind, num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return null;
  const raw = readLevelFile(kind, n);
  if (raw == null) return null;
  const list = kind === 'text' ? parseText(raw) : parseWords(raw);
  if (!list.length) return null;
  let mtime = 0;
  try { mtime = fs.statSync(levelPath(kind, n)).mtimeMs; } catch { /* 忽略 */ }
  return { num: n, name: String(n), items: list, mtime };
}

/** 当前关卡：取编号最大的那个（私服通常只留一个"现役关"） */
export function loadCurrent(kind) {
  const nums = listLevels(kind);
  if (!nums.length) return null;
  return loadLevel(kind, nums[0]);
}

/**
 * 历史关：除"现役关"（编号最大的那个）以外的所有关卡。
 *
 * 【为什么历史关不需要单独一处存储】
 *   上传时若没指定关号，会取"当前最大号 + 1"写入一个新文件，旧文件原样留着。
 *   也就是说历史关**天然已经存在**，只是之前只暴露了编号最大的那一个。
 *   所以这个功能不需要迁移、不占额外磁盘，只要把剩下的列出来。
 *   同理，用户指定了已存在的关号去覆盖时，那一版就被覆盖了（视为修订）。
 */
export function listHistory(kind) {
  const nums = listLevels(kind);
  const out = [];
  for (const n of nums.slice(1)) {
    const lv = loadLevel(kind, n);
    if (lv) out.push({ num: lv.num, name: lv.name, count: lv.items.length, updatedAt: lv.mtime });
  }
  return out;
}

export function nextLevelNum(kind) {
  const nums = listLevels(kind);
  return nums.length ? nums[0] + 1 : 100001;
}

/* ---------------------------- 玩家进度 ---------------------------- */

function playerFile(pid) {
  const h = crypto.createHash('sha1').update(String(pid)).digest('hex');
  return path.join(dirs().players, h + '.json');
}

export function loadPlayer(pid) {
  if (!pid) return { done: [], num: null };
  try {
    const j = JSON.parse(fs.readFileSync(playerFile(pid), 'utf8'));
    return {
      done: Array.isArray(j.done) ? j.done.filter((x) => typeof x === 'string') : [],
      num: Number.isFinite(j.num) ? j.num : null,
      updatedAt: j.updatedAt || 0,
    };
  } catch {
    return { done: [], num: null };
  }
}

export function savePlayer(pid, p) {
  if (!pid) return;
  ensureDirs();
  const f = playerFile(pid);
  const body = JSON.stringify({
    done: (p.done || []).slice(0, 50000),
    num: p.num ?? null,
    updatedAt: Date.now(),
  });
  const tmp = f + '.tmp' + process.pid;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, f);
}

export default {
  LEVEL_RE, dirs, ensureDirs, idOf,
  parseWords, formatWords, parseText, formatText,
  listLevels, levelPath, readLevelFile, writeLevelFile,
  loadCurrent, nextLevelNum,
  loadPlayer, savePlayer,
};
