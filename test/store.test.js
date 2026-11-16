/**
 * 解析层单元测试 —— 专测"错了也不报错"的那几件事。
 *
 * 这里最重要的是 ③：中文段落切句。
 * 早先按英文习惯要求"标点后必须有空格"，而中文不写空格，
 * 结果一整段中文被当成一整句 —— 10 句译文变成 1 条超长译文，
 * 只配上第 1 句英文，课文整个错位，界面却看不出任何异常。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// store.js 在 import 时会读 config（dataDir 可用环境变量覆盖），所以先设临时目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanjian-test-'));
process.env.DATA_DIR = tmp;

const { parseWords, parseText, formatWords, formatText, idOf, loadCurrent, writeLevelFile, listLevels } =
  await import('../server/store.js');

test('① 词表：TAB 分隔', () => {
  const r = parseWords('vocabulary\tn. 词汇\nsuppress\tv. 抑制');
  assert.equal(r.length, 2);
  assert.equal(r[0].en, 'vocabulary');
  assert.equal(r[0].zh, 'n. 词汇');
});

test('② 词表：空格分隔 + 中文在前 + 行首编号', () => {
  assert.equal(parseWords('1. vocabulary 词汇')[0].en, 'vocabulary');
  const cnFirst = parseWords('词汇 vocabulary');
  assert.equal(cnFirst[0].en, 'vocabulary');
  assert.equal(cnFirst[0].zh, '词汇');
});

test('③ 课文：一整段中文必须切成多句（回归测试）', () => {
  const raw = [
    'The morning train was late. I walked to the office. It was raining.',
    '早班火车又晚点了。我走路去了办公室。当时正在下雨。',
  ].join('\n');
  const r = parseText(raw);
  assert.equal(r.length, 3, '应为 3 句，实际 ' + r.length);
  assert.equal(r[0].en, 'The morning train was late.');
  assert.equal(r[0].zh, '早班火车又晚点了。');
  assert.equal(r[1].zh, '我走路去了办公室。');
  assert.equal(r[2].zh, '当时正在下雨。');
});

test('④ 课文：英文句号后要空格才算边界（不切开 3.14 / Mr. Smith）', () => {
  const r = parseText('Pi is about 3.14 and Mr. Smith agrees.');
  assert.equal(r.length, 1, '不该被小数点切开，实际切成 ' + r.length + ' 段');
});

test('⑤ 课文：TAB 逐行原样采用', () => {
  const r = parseText('Hello world.\t你好世界。\nGood morning.\t早上好。');
  assert.equal(r.length, 2);
  assert.equal(r[0].zh, '你好世界。');
  assert.equal(r[1].zh, '早上好。');
});

test('⑥ 课文：只有英文没有译文也要能背（zh 留空，不丢句）', () => {
  const r = parseText('First sentence here.\nSecond sentence here.');
  assert.equal(r.length, 2);
  assert.equal(r[0].zh, '');
});

test('⑦ 空输入不炸', () => {
  assert.deepEqual(parseWords(''), []);
  assert.deepEqual(parseText(''), []);
  assert.deepEqual(parseText('   \n\n '), []);
});

test('⑧ 写出再读回，句子与译文都不丢', () => {
  const src = [
    { en: 'The bakery was still open.', zh: '面包店还开着。' },
    { en: 'Only two loaves were left.', zh: '只剩两条面包。' },
  ];
  const back = parseText(formatText(src));
  assert.equal(back.length, 2);
  assert.equal(back[0].en, src[0].en);
  assert.equal(back[1].zh, src[1].zh);

  const w = parseWords(formatWords([{ en: 'a', zh: '甲' }]));
  assert.equal(w[0].zh, '甲');
});

test('⑨ id 稳定：大小写与空白不影响', () => {
  assert.equal(idOf('Hello   World'), idOf('hello world'));
  assert.equal(idOf('  A\tB '), 'a b');
});

test('⑩ 关卡文件读写 + 取"编号最大"的现役关', () => {
  writeLevelFile('word', 100001, [{ en: 'one', zh: '一' }]);
  writeLevelFile('word', 100002, [{ en: 'two', zh: '二' }]);
  assert.deepEqual(listLevels('word'), [100002, 100001]);
  const cur = loadCurrent('word');
  assert.equal(cur.num, 100002);
  assert.equal(cur.items[0].en, 'two');
});

test('⑪ 去重：同一关里重复的英文只留第一条', () => {
  const r = parseWords('a\t甲\nA\t乙');
  assert.equal(r.length, 1);
  assert.equal(r[0].zh, '甲');
});

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
});
