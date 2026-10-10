/* ==========================================================================
   文字游戏工坊 · 规则书检索（retrieval.js）
   --------------------------------------------------------------------------
   目的：规则书动辄几十万字，每回合全发会让首字延迟到 15 秒以上。
        这里把规则书切成章节，每回合只发「目录 + 最相关的几节原文」。

   为什么是原文而不是摘要：
     摘要会让模型把「抄错的小册子」当真理，出错时还说「规则书第X条明确规定…」；
     发原文则是「少了几页书」——模型知道自己没看到，会保守处理。
     对数值密集的规则书，这个差别是决定性的。

   做法：
     1. split()  按标题（第X部分 / S255.3 / markdown 标题 / 段落）切成 4k–40k 字的节
     2. build()  建 TF-IDF 索引（中文用二字组，英文用整词）
     3. pick()   按当前剧情关键词打分，选出最相关的几节，受字符预算约束
     4. compose() 生成「全书目录 + 选中的原文」，并告诉模型哪些节没收到

   浏览器：<script src="retrieval.js"></script> → window.GWRetrieve
   Node：  module.exports = GWRetrieve
   ========================================================================== */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.GWRetrieve = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEF = {
    minChars: 4000,      // 一节最小字数（比这小的和相邻节合并）
    maxChars: 40000,     // 一节最大字数（比这大的按段落再拆）
    vocabSize: 8000,     // 词表大小
    budget: 60000,       // 每回合最多发多少字规则书原文
    maxSections: 8,      // 最多选几节
    coreKeep: 2,         // 标题像「总纲/开局/创建」的，至少保留几节
  };

  /* ==================== 一、分词 ==================== */

  /** 中文按二字组、英文按整词切 */
  function terms(s) {
    const out = [];
    const t = String(s == null ? '' : s).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ');
    const segs = t.split(' ');
    for (let k = 0; k < segs.length; k++) {
      const seg = segs[k];
      if (!seg) continue;
      if (/^[a-zA-Z0-9]+$/.test(seg)) {
        if (seg.length > 1) out.push(seg.toLowerCase());
        continue;
      }
      for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
      if (seg.length === 1) out.push(seg);
    }
    return out;
  }

  /* ==================== 二、切章节 ==================== */

  function isHeading(s) {
    if (!s || s.length > 90) return false;
    if (/^#{1,4}\s+\S/.test(s)) return true;
    if (/^第\s*[0-9一二三四五六七八九十百千]+\s*(部分|章|节|篇)/.test(s)) return true;
    if (/^S\d+(\.\d+)*[\s、.·:：]/.test(s)) return true;
    if (/^[（(]?[0-9]{1,3}[）)]?\s*[、.．]\s*\S/.test(s) && /[\u4e00-\u9fa5]/.test(s) && s.length < 40) return true;
    return false;
  }

  function normalizeTitle(s) {
    return String(s || '').replace(/^#{1,4}\s*/, '').replace(/\*\*/g, '').trim().slice(0, 60);
  }

  /** 这一节是不是 Word 导出的目录（一堆 HYPERLINK/PAGEREF 行）—— 纯噪音，检索时跳过 */
  function looksLikeToc(txt) {
    const lines = String(txt || '').split('\n').filter((l) => l.trim());
    if (lines.length < 20) return false;
    let hit = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/HYPERLINK|PAGEREF|_Toc\d+|\.{4,}\s*\d+\s*$/.test(lines[i])) hit++;
    }
    return hit / lines.length > 0.5;
  }

  /**
   * 把规则书切成节。
   * @returns {{id:number,title:string,text:string,chars:number}[]}
   */
  function split(text, opts) {
    const o = Object.assign({}, DEF, opts || {});
    const src = String(text == null ? '' : text);
    if (!src.trim()) return [];
    const lines = src.split('\n');

    // 1) 找标题行
    const heads = [];
    for (let i = 0; i < lines.length; i++) {
      if (isHeading(lines[i].trim())) heads.push(i);
    }

    // 2) 切成原始块
    let raw = [];
    if (heads.length >= 3) {
      if (heads[0] > 0) raw.push({ title: '（前言）', from: 0, to: heads[0] });
      for (let k = 0; k < heads.length; k++) {
        raw.push({
          title: normalizeTitle(lines[heads[k]]),
          from: heads[k],
          to: (k + 1 < heads.length) ? heads[k + 1] : lines.length,
        });
      }
    } else {
      raw = [{ title: '全文', from: 0, to: lines.length }];
    }

    // 3) 太大的按空行拆，太小的往后并
    const pieces = [];
    for (const r of raw) {
      let seg = lines.slice(r.from, r.to);
      let size = seg.join('\n').length;
      if (size <= o.maxChars) { pieces.push({ title: r.title, lines: seg }); continue; }
      // 按空行分段，累积到 maxChars 就断开
      let buf = [], bufLen = 0;
      const flush = () => { if (buf.length) pieces.push({ title: r.title, lines: buf }); buf = []; bufLen = 0; };
      for (const ln of seg) {
        if (ln.length > o.maxChars) {
          // 单行本身就超长（没有换行的大段）→ 按字符硬切，否则这一节永远切不开
          flush();
          for (let p = 0; p < ln.length; p += o.maxChars) {
            pieces.push({ title: r.title, lines: [ln.slice(p, p + o.maxChars)] });
          }
          continue;
        }
        buf.push(ln); bufLen += ln.length + 1;
        if (bufLen >= o.maxChars) flush();
      }
      flush();
    }

    const merged = [];
    for (const p of pieces) {
      const len = p.lines.join('\n').length;
      const last = merged[merged.length - 1];
      if (last && (last.lines.join('\n').length + len) < o.minChars) {
        last.lines = last.lines.concat(p.lines);
      } else {
        merged.push({ title: p.title, lines: p.lines.slice() });
      }
    }

    return merged.map((m, i) => {
      const txt = m.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      return { id: i, title: m.title || ('第 ' + (i + 1) + ' 节'), text: txt, chars: txt.length, toc: looksLikeToc(txt) };
    }).filter((s) => s.chars > 0);
  }

  /* ==================== 三、建索引（TF-IDF） ==================== */

  function build(text, opts) {
    const o = Object.assign({}, DEF, opts || {});
    const sections = split(text, o);

    // 全局词频
    const global = new Map();
    const local = [];
    for (const sec of sections) {
      const m = new Map();
      const ts = terms(sec.text);
      for (let i = 0; i < ts.length; i++) {
        m.set(ts[i], (m.get(ts[i]) || 0) + 1);
      }
      local.push(m);
      for (const [k, v] of m) global.set(k, (global.get(k) || 0) + v);
    }

    // 取高频词作词表
    const vocabArr = Array.from(global.entries());
    vocabArr.sort((a, b) => b[1] - a[1]);
    const vocab = new Map();
    for (let i = 0; i < Math.min(o.vocabSize, vocabArr.length); i++) vocab.set(vocabArr[i][0], i);

    // 每节的稀疏向量 + IDF
    const df = new Array(vocab.size).fill(0);
    const vectors = local.map((m) => {
      const v = [];
      let norm = 0;
      for (const [term, tf] of m) {
        const idx = vocab.get(term);
        if (idx === undefined) continue;
        v.push([idx, tf]);
        norm += tf * tf;
      }
      v.sort((a, b) => a[0] - b[0]);
      for (const [idx] of v) df[idx]++;
      return { v, norm: Math.sqrt(norm) || 1 };
    });
    const N = sections.length || 1;
    const idf = df.map((d) => Math.log(1 + N / (1 + d)));

    // 标题里出现的词额外加权
    const titles = sections.map((s) => new Set(terms(s.title + ' ' + s.title)));

    return {
      sections, vocab, idf, vectors, titles,
      totalChars: sections.reduce((a, s) => a + s.chars, 0),
      opts: o,
    };
  }

  /* ==================== 四、检索 ==================== */

  /** 标题像「总纲 / 开局 / 创建 / 世界」的属于地基，加分（不含「速查」，否则会全是速查卡） */
  const CORE_RE = /总纲|总则|总览|核心|基础|通用|开局|创建|角色创建|世界观|前言|概述|总协议|规则总览/;

  function pick(idx, query, opts) {
    const o = Object.assign({}, idx.opts || DEF, opts || {});
    const n = idx.sections.length;
    if (!n) return { picked: [], dropped: [], chars: 0 };

    const qs = terms(String(query || '') + ' ' + String((opts && opts.extra) || ''));
    // 查询词向量
    const qv = new Map();
    for (const t of qs) qv.set(t, (qv.get(t) || 0) + 1);

    const scores = new Array(n).fill(0);
    // 目录节直接排除
    for (let i = 0; i < n; i++) if (idx.sections[i].toc) scores[i] = -1e9;
    const firstOk = idx.sections.findIndex((s) => !s.toc);

    for (const [term, qtf] of qv) {
      const vi = idx.vocab.get(term);
      if (vi === undefined) continue;
      const w = qtf * idx.idf[vi];
      for (let s = 0; s < n; s++) {
        if (scores[s] < -1e8) continue;
        const vec = idx.vectors[s].v;
        // 稀疏向量二分查找
        let lo = 0, hi = vec.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (vec[mid][0] === vi) { scores[s] += w * vec[mid][1] / idx.vectors[s].norm; break; }
          if (vec[mid][0] < vi) lo = mid + 1; else hi = mid - 1;
        }
      }
    }

    // 标题命中加权 + 地基章节加成 + 短查询时靠前的章节加成
    const shortQuery = qv.size < 5;
    for (let s = 0; s < n; s++) {
      if (scores[s] < -1e8) continue;
      let hit = 0;
      for (const t of qv.keys()) if (idx.titles[s].has(t)) hit++;
      scores[s] += hit * 3;
      if (CORE_RE.test(idx.sections[s].title)) scores[s] += 1.2;
      if (shortQuery) scores[s] += Math.max(0, 1.6 * (1 - s / n));   // 开局时优先靠前的章节
    }

    const order = scores.map((sc, i) => ({ i, sc })).filter((x) => x.sc > -1e8).sort((a, b) => b.sc - a.sc);

    // 按预算选，且保证「地基章节」至少若干节
    const picked = [], dropped = [];
    let used = 0;
    const take = (i, force) => {
      if (i < 0 || picked.indexOf(i) >= 0 || idx.sections[i].toc) return false;
      const c = idx.sections[i].chars;
      if (!force && used + c > o.budget && picked.length > 0) return false;
      picked.push(i); used += c;
      return true;
    };

    take(firstOk, true);            // 第一节（通常是总协议/规则总览）永远带上
    let core = 0;
    for (const s of order) {
      if (core >= o.coreKeep) break;
      if (CORE_RE.test(idx.sections[s.i].title)) { if (take(s.i)) core++; }
    }
    for (const s of order) {
      if (picked.length >= o.maxSections) break;
      if (used >= o.budget) break;
      take(s.i);
    }
    for (let i = 0; i < n; i++) if (picked.indexOf(i) < 0 && !idx.sections[i].toc) dropped.push(i);
    picked.sort((a, b) => a - b);
    return { picked, dropped, chars: used };
  }

  /** 按关键词强制取几节（给「模型主动索取」用） */
  function search(idx, keyword, limit) {
    const kw = terms(String(keyword || ''));
    if (!kw.length) return [];
    const n = idx.sections.length;
    const scores = new Array(n).fill(0);
    for (const t of kw) {
      const vi = idx.vocab.get(t);
      if (vi === undefined) continue;
      for (let s = 0; s < n; s++) {
        const vec = idx.vectors[s].v;
        for (let k = 0; k < vec.length; k++) if (vec[k][0] === vi) { scores[s] += vec[k][1] / idx.vectors[s].norm; break; }
      }
      for (let s = 0; s < n; s++) if (idx.sections[s].title.indexOf(String(keyword).trim()) >= 0) scores[s] += 5;
    }
    return scores.map((sc, i) => ({ i, sc })).filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc).slice(0, limit || 2).map((x) => x.i);
  }

  /* ==================== 五、拼装发给模型的内容 ==================== */

  function compose(idx, opts) {
    const o = Object.assign({}, idx.opts || DEF, opts || {});
    const pickedIds = (opts && opts.picked) || [];
    const needIds = (opts && opts.need) || [];
    const all = pickedIds.concat(needIds.filter((i) => pickedIds.indexOf(i) < 0));
    const sent = new Set(all);

    const toc = idx.sections.map((s, i) => ({ s, i }))
      .filter((x) => !x.s.toc)                       // 目录节不进目录
      .map((x, k) => (k + 1) + '. ' + x.s.title + '　（' + Math.round(x.s.chars / 1000) + ' 千字）' +
        (sent.has(x.i) ? '　★已附' : '')).join('\n');

    const body = all.sort((a, b) => a - b).map((i) =>
      '────────── 【' + idx.sections[i].title + '】 ──────────\n\n' + idx.sections[i].text
    ).join('\n\n');

    return {
      toc, body,
      sentIds: all,
      sentChars: all.reduce((a, i) => a + idx.sections[i].chars, 0),
      sentTitles: all.map((i) => idx.sections[i].title),
      totalSections: idx.sections.length,
      totalChars: idx.totalChars,
    };
  }

  /** 一句话概括（给界面显示用） */
  function describe(idx, res) {
    if (!idx || !idx.sections.length) return '';
    return '规则书 ' + idx.sections.length + ' 节 / ' + Math.round(idx.totalChars / 10000) + ' 万字　→　本次附上 ' +
      res.sentIds.length + ' 节（' + Math.round(res.sentChars / 10000) + ' 万字）';
  }

  return { DEF, terms, split, build, pick, search, compose, describe, isHeading };
});
