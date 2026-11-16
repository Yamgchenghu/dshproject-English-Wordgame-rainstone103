/**
 * 计分引擎单元测试
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULES, norm, isCorrect, isCorrectAny, makeHint,
  computeGroup, computeBigReward, round2,
} from '../server/scoring.js';

const items = (n, borrowedFrom = Infinity) =>
  Array.from({ length: n }, (_, i) => ({ wid: 'w' + (i + 1), borrowed: i + 1 > borrowedFrom }));

const answers = (n, pick) =>
  Array.from({ length: n }, (_, i) => ({ wid: 'w' + (i + 1), correctAt: pick(i + 1) }));

test('① 10 题全对：100 分、达标、积分 1.5 + 0.5 = 2', () => {
  const r = computeGroup({ items: items(10), answers: answers(10, () => 1) });
  assert.equal(r.score, 100);
  assert.equal(r.fullMark, 100);
  assert.equal(r.passed, true);
  assert.equal(r.firstTry.length, 10);
  assert.equal(r.points.first, 1.5);
  assert.equal(r.points.second, 0);
  assert.equal(r.points.perfect, 0.5);
  assert.equal(r.points.total, 2);
});

test('② 9 对 1 两次错：90 分、达标', () => {
  const r = computeGroup({ items: items(10), answers: answers(10, (i) => (i === 10 ? 0 : 1)) });
  assert.equal(r.score, 90);
  assert.equal(r.passed, true);
  assert.equal(r.firstTry.length, 9);
});

test('③ 恰好 85% 算达标（边界）', () => {
  // 10 题：8 个第一次对(80) + 1 个第二次对(7) = 87 >= 85
  // 要做到恰好 85：7 个第一次对(70) + 2 个第二次对(14) = 84 < 85 → 不达标
  const r84 = computeGroup({ items: items(10), answers: answers(10, (i) => (i <= 7 ? 1 : i <= 9 ? 2 : 0)) });
  assert.equal(r84.score, 84);
  assert.equal(r84.passed, false);

  // 20 题：17 次对 = 170 = 恰好 85%
  const r85 = computeGroup({
    items: items(20),
    answers: Array.from({ length: 20 }, (_, i) => ({ wid: 'w' + (i + 1), correctAt: i < 17 ? 1 : 0 })),
  });
  assert.equal(r85.score, 170);
  assert.equal(r85.fullMark, 200);
  assert.equal(r85.passed, true);
});

test('④ 不达标时积分与完成全清零', () => {
  const r = computeGroup({ items: items(10), answers: answers(10, (i) => (i <= 4 ? 1 : 2)) });
  assert.equal(r.passed, false);
  assert.deepEqual(r.firstTry, []);
  assert.deepEqual(r.secondTry, []);
  assert.equal(r.points.total, 0);
});

test('⑤ 借来的题第二次对只给 5 分，且不计完成', () => {
  const r = computeGroup({
    items: items(10, 8),                 // 9、10 是借来的
    answers: answers(10, (i) => (i <= 8 ? 1 : 2)),
  });
  assert.equal(r.score, 8 * 10 + 2 * 5);
  assert.equal(r.firstTry.length, 8);
  assert.deepEqual(r.secondTry, []);
});

test('⑥ 归一化：大小写、标点、空白都不算错', () => {
  assert.equal(norm('Hello,  World!'), 'hello world');
  assert.equal(isCorrect('hello world', 'Hello,  World!'), true);
  assert.equal(isCorrect("it's", 'It\u2019s'), true);
  assert.equal(isCorrect('well-known', 'well known'), false);
});

test('⑦ 并列写法：a/b、a=b 任一都对（仅词表用）', () => {
  assert.equal(isCorrectAny('oppose', 'oppose= be opposed to=object to'), true);
  assert.equal(isCorrectAny('be opposed to', 'oppose= be opposed to=object to'), true);
  assert.equal(isCorrectAny('normal', 'oppose= be opposed to'), false);
  // 括号可选成分
  assert.equal(isCorrectAny('have difficulty doing', 'have difficulty (in) doing'), true);
});

test('⑧ 空答案不判对', () => {
  assert.equal(isCorrect('', ''), false);
  assert.equal(isCorrect('   ', 'hello'), false);
  assert.equal(isCorrectAny('', 'a/b'), false);
});

test('⑨ 提示：单词给首字母，多词给到第一个错误点', () => {
  assert.equal(makeHint('prey', 'pray'), 'p');
  assert.equal(makeHint('have difficulty doing', 'have dificulty'), 'have difficulty');
  assert.equal(makeHint('get up', 'zzz'), 'get');
});

test('⑩ 大关奖励：全完成才发', () => {
  assert.equal(computeBigReward({ total: 10, completed: 10, per: 0.1 }).bigReward, 1);
  assert.equal(computeBigReward({ total: 10, completed: 9, per: 0.1 }).bigReward, 0);
  assert.equal(computeBigReward({ total: 3, completed: 3, per: 0.5 }).bigReward, 1.5);
});

test('⑪ 尾组题数不足时 fullMark 按实际题数算', () => {
  const r = computeGroup({ items: items(4), answers: answers(4, () => 1) });
  assert.equal(r.fullMark, 40);
  assert.equal(r.score, 40);
  assert.equal(r.passed, true);
});

test('⑫ 课文用 sid 字段也能算（同一套内核）', () => {
  const r = computeGroup({
    items: [{ sid: 'a' }, { sid: 'b' }],
    answers: [{ sid: 'a', correctAt: 1 }, { sid: 'b', correctAt: 2 }],
  });
  assert.equal(r.score, 17);
  assert.deepEqual(r.firstTry, ['a']);
  assert.deepEqual(r.secondTry, ['b']);
});

test('⑬ RULES 口径', () => {
  assert.equal(RULES.PASS_RATIO, 0.85);
  assert.equal(RULES.BIG_REWARD_PER_WORD, 0.1);
  assert.equal(RULES.BIG_REWARD_PER_SENTENCE, 0.5);
  assert.equal(round2(0.1 + 0.2), 0.3);
});
