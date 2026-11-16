/**
 * 目录入口：让 `node --test test/` 能跑起来。
 *
 * Node v24 实测：--test 的位置参数若是**目录**，会被交给 CJS loader 当成待执行模块，
 * 目录里没有 index 就报 Cannot find module。放一个只做 re-export 的 index.js 即可。
 * `node --test test/*.test.js` 这条路径同样可用。
 */
import './scoring.test.js';
import './store.test.js';
