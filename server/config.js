/**
 * 配置与密钥读取。
 * ==================================================================
 * 【为什么密钥是「点号路径」】用户要求预留的就是 `qwen.api.key` 这种写法。
 *   所以内部统一用 get('qwen.api.key') 读，配置文件里也就按同名嵌套结构放。
 *   好处是新增一个供应商只加一行配置，不用改读取代码。
 *
 * 【优先级】环境变量 > config/keys.json > config/keys.example.json（全空）
 *   环境变量优先，是为了 Docker / systemd / 云平台的常规做法能直接用，
 *   不必把密钥写进文件。文件优先于 example，是为了本地开发方便。
 *
 * 【为什么 example 里也有 key 为空的条目】
 *   让读者一眼看到"这个位置是留给谁的"。空串在读取时被当作"未配置"，
 *   所有用到它的功能都会优雅降级（前端隐藏朗读按钮、上传时不补中文），
 *   而不是启动失败。
 */
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const ROOT = path.resolve(HERE, '..');
export const CONFIG_DIR = path.join(ROOT, 'config');

/** 环境变量 -> 点号路径。一个路径允许多个别名（OpenAI 那套习惯名）。 */
const ENV_MAP = {
  QWEN_API_KEY: 'qwen.api.key',
  QWEN_KEY: 'qwen.api.key',
  MIMO_API_KEY: 'mimo.api.key',
  MIMO_KEY: 'mimo.api.key',
  DEEPSEEK_API_KEY: 'deepseek.api.key',
  GPT_API_KEY: 'gpt.api.key',
  OPENAI_API_KEY: 'gpt.api.key',
  GROK_API_KEY: 'grok.api.key',
  XAI_API_KEY: 'grok.api.key',
  GEMINI_API_KEY: 'gemini.api.key',
  GOOGLE_API_KEY: 'gemini.api.key',
  GENIMI_API_KEY: 'genimi.api.key',
  DOUBAO_API_KEY: 'doubao.api.key',
  ARK_API_KEY: 'doubao.api.key',
  VOLC_API_KEY: 'doubao.api.key',
  QWEN_TOKENPLAN_API_KEY: 'qwentokenplan.api.key',
  MIMO_TOKENPLAN_API_KEY: 'mimotokenplan.api.key',
};

/** 用户明确点名要预留的 9 个槽位（gemini/genimi 是同一个供应商的两种拼法） */
export const RESERVED_KEY_PATHS = [
  'qwen.api.key',
  'mimo.api.key',
  'deepseek.api.key',
  'gpt.api.key',
  'grok.api.key',
  'gemini.api.key',
  'genimi.api.key',
  'doubao.api.key',
  'qwentokenplan.api.key',
  'mimotokenplan.api.key',
];

/** gemini 的两种拼法互为别名（用户写的是 genimi，正确的拼法是 gemini，两个都认） */
const ALIAS = [['gemini.api.key', 'genimi.api.key']];

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadFile() {
  const real = path.join(CONFIG_DIR, 'keys.json');
  if (fs.existsSync(real)) return { data: readJson(real) || {}, from: real };
  const ex = path.join(CONFIG_DIR, 'keys.example.json');
  return { data: readJson(ex) || {}, from: ex };
}

let cache = null;

function build() {
  const { data, from } = loadFile();
  const flat = new Map();

  // 先铺文件里的值
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (k.startsWith('_')) continue; // _readme 之类的注释字段
      const key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
      else if (typeof v === 'string' && v.trim()) flat.set(key, { value: v.trim(), source: 'file' });
    }
  };
  walk(data, '');

  // 环境变量覆盖
  for (const [envName, p] of Object.entries(ENV_MAP)) {
    const v = process.env[envName];
    if (v && v.trim()) flat.set(p, { value: v.trim(), source: 'env' });
  }

  // 别名互通：任意一方有值，另一方也能读到
  for (const [a, b] of ALIAS) {
    if (flat.has(a) && !flat.has(b)) flat.set(b, flat.get(a));
    else if (flat.has(b) && !flat.has(a)) flat.set(a, flat.get(b));
  }

  return { flat, file: from };
}

function ensure() {
  if (!cache) cache = build();
  return cache;
}

/** 重新读盘（改完 keys.json 不必重启进程） */
export function reload() {
  cache = null;
  return ensure();
}

/** 读一个点号路径；没配置返回空串 */
export function get(dotted) {
  const hit = ensure().flat.get(String(dotted));
  return hit ? hit.value : '';
}

/** 是否配置了（有值且不是明显占位符） */
export function has(dotted) {
  const v = get(dotted);
  return !!v && !/^(your|sk-xxx|<|changeme|todo)/i.test(v);
}

/** 只报"有没有"，绝不回显 key 本身 —— 这个结果会经 HTTP 暴露出去 */
export function status() {
  const out = {};
  for (const p of RESERVED_KEY_PATHS) {
    out[p] = {
      configured: has(p),
      // 来源只是 file/env，不含任何密钥片段
      source: has(p) ? (ensure().flat.get(p) || {}).source || 'unknown' : 'none',
    };
  }
  return out;
}

/** 语音供应商可用性（前端据此决定是否显示朗读按钮） */
export function ttsAvailable() {
  return {
    qwen: has('qwen.api.key') || has('qwentokenplan.api.key'),
    mimo: has('mimo.api.key') || has('mimotokenplan.api.key'),
  };
}

/** LLM 供应商列表（按优先级），用于"补全中文"等 */
export function llmCandidates() {
  return ['deepseek', 'gpt', 'grok', 'gemini', 'doubao']
    .filter((p) => has(p + '.api.key'));
}

/** 管理口令：环境变量 ADMIN_TOKEN 优先，其次 config/admin.token */
export function adminToken() {
  const env = (process.env.ADMIN_TOKEN || '').trim();
  if (env) return env;
  const p = path.join(CONFIG_DIR, 'keys.json');
  const j = readJson(p) || {};
  return String((j.admin && j.admin.token) || '').trim();
}

export function port() {
  return Number(process.env.PORT || 8787);
}

export function host() {
  return process.env.HOST || '0.0.0.0';
}

export function dataDir() {
  return process.env.DATA_DIR || path.join(ROOT, 'data');
}

export function ttsCacheDir() {
  return path.join(dataDir(), 'ttscache');
}

export default {
  ROOT, CONFIG_DIR, RESERVED_KEY_PATHS,
  get, has, status, reload, ttsAvailable, llmCandidates,
  adminToken, port, host, dataDir, ttsCacheDir,
};
