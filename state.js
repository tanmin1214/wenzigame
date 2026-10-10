/* ==========================================================================
   文字游戏工坊 · 状态层（state.js）
   --------------------------------------------------------------------------
   作用：把 AI 每回合输出的 JSON 补丁，安全地合并进程序持有的权威状态。
   设计要点（见《状态Schema设计.md》）：
     · 只接受「已知键」，未知键不崩、不污染
     · 缺省字段 = 不变（绝不因为没提到就清空）
     · 支持相对增减："+3" / "-5"，以及 [当前,上限] 数组对
     · 集合按 primary 字段配对：同名=更新，新名=新增，"_del":true=删除
     · JSON 一定会有格式错误 → 多级修复 + 分段抢救；全失败就保留旧状态
     · op:"init" 在已有状态时会被忽略（防止中途把玩家数据覆盖掉）

   浏览器：<script src="state.js"></script> 之后 window.GWState 可用
   Node：  module.exports = GWState        （为了能跑测试）
   ========================================================================== */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.GWState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const SECTIONS = ['gw', 'op', 'turn', 'panels', 'state', 'journal', 'rolls'];

  /* ==================================================================
     一、数字与字段的合并原语
     ================================================================== */

  const isNum = (v) => typeof v === 'number' && isFinite(v);

  /** 把一个值解析成 {kind:'abs'|'rel', v:number}；解析不了返回 null */
  function toNumber(v) {
    if (isNum(v)) return { kind: 'abs', v };
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^[+-]\s*\d/.test(s)) return { kind: 'rel', v: parseFloat(s.replace(/\s+/g, '')) };
      if (/^-?\d+(\.\d+)?$/.test(s)) return { kind: 'abs', v: parseFloat(s) };
      // 「3块下品灵石」这类带说明的文本 → 至少提出开头的数字，
      // 这样后续收到「+2」时能算成 5，而不是从 0 开始
      const m = /^(-?\d+(?:\.\d+)?)/.exec(s);
      if (m) return { kind: 'abs', v: parseFloat(m[1]) };
      if (/^[一二三四五六七八九十百千万]+$/.test(s)) {
        const CN2 = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000, 万: 10000 };
        if (s.length === 1) return { kind: 'abs', v: CN2[s] };
      }
    }
    return null;
  }

  /** 单个数值字段：支持绝对覆盖与相对增减 */
  function mergeNum(oldV, newV) {
    const n = toNumber(newV);
    if (!n) return undefined;                   // 无效，保持不变
    if (n.kind === 'abs') return n.v;
    const base = toNumber(oldV);
    return (base ? base.v : 0) + n.v;
  }

  /** [当前, 上限] 这类成对数值 */
  function mergePair(oldV, newV) {
    const oldArr = Array.isArray(oldV) ? oldV : null;
    if (!Array.isArray(newV)) {
      const n = toNumber(newV);
      if (!n) return undefined;
      if (!oldArr) return n.kind === 'abs' ? n.v : undefined;   // 无基准的相对值没有意义
      const cur = toNumber(oldArr[0]);
      const max = toNumber(oldArr[1]);
      return [n.kind === 'abs' ? n.v : ((cur ? cur.v : 0) + n.v), max ? max.v : (cur ? cur.v : 0)];
    }
    const base = oldArr || [0, 0];
    const out = base.slice();
    for (let i = 0; i < Math.min(newV.length, 2); i++) {
      const n = toNumber(newV[i]);
      if (!n) continue;
      const b = toNumber(base[i]);
      out[i] = n.kind === 'abs' ? n.v : ((b ? b.v : 0) + n.v);
    }
    return out;
  }

  /**
   * 这个输入能不能当数值用。
   * 注意：这里要「纯数字」才算 —— 像 "3 块下品灵石" 这种带说明的，
   * 应原样按文本存下来（保住「下品」这类信息），而不是抽成 3 把说明丢掉。
   * （抽数字是 toNumber 的事，只在需要做加减时用。）
   */
  // AI 常把数值写成带单位的文本（「8岁」「3年」「一」）——
  // 原本 validNumericInput 要求纯数字，于是整次更新被丢掉（玩家实测：年龄永远 0）。
  // 这里先尽量把数字抽出来；真抽不出来（「很多」）才跳过。
  const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function coerceNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s) return null;
    const m = s.match(/^(-?\d+(?:\.\d+)?)/);            // 「8岁」→ 8、「8」→ 8
    if (m) return Number(m[1]);
    const c = s.match(/^([零一二两三四五六七八九十]+)/);     // 「八年」→ 8、「十二」→ 12
    if (c) {
      const t = c[1];
      if (CN_NUM[t] !== undefined) return CN_NUM[t];
      const i10 = t.indexOf('十');
      if (i10 === 0) return 10 + (CN_NUM[t[1]] || 0);
      if (i10 > 0) return (CN_NUM[t[0]] || 1) * 10 + (CN_NUM[t[1]] || 0);
    }
    return null;
  }
  function coerceNumericValue(v) {
    const one = coerceNum(v);
    if (one !== null) return one;
    if (Array.isArray(v)) {
      const out = v.map(coerceNum);
      return out.every((x) => x !== null) ? out : null;
    }
    return null;
  }

  function validNumericInput(v) {
    if (Array.isArray(v)) return v.some((x) => validNumericInput(x));
    if (isNum(v)) return true;
    if (typeof v === 'string') {
      const s = v.trim();
      return /^[+-]?\s*\d+(\.\d+)?$/.test(s);      // 纯数字（可带正负号）
    }
    return false;
  }

  /** 通用字段合并：数值型字段走数值规则，其余直接覆盖 */
  function mergeField(fieldType, oldV, newV) {
    // 新值本身像「数值对」（如 ["60", 100]）时也要按数值处理 —— 否则新字段会把 "60" 原样存成字符串
    const newPair = Array.isArray(newV) && newV.length <= 2 &&
                    newV.length > 0 && newV.every((x) => toNumber(x) !== null);
    const numeric = fieldType === 'number' || fieldType === 'money' || fieldType === 'bar' ||
                    isNum(oldV) || Array.isArray(oldV) || newPair;
    if (!numeric) return Array.isArray(newV) ? newV.slice() : newV;
    if (Array.isArray(oldV) || Array.isArray(newV)) {
      const r = mergePair(oldV, newV);
      return r === undefined ? oldV : r;
    }
    const r = mergeNum(oldV, newV);
    return r === undefined ? oldV : r;
  }

  /* ==================================================================
     二、集合（collections）合并
     ================================================================== */

  /**
   * 集合键归一到面板 id。
   * AI 有时写 state.collections.task（面板 id），有时写 state.collections.任务（中文面板名）。
   * 不归一的话，同一个面板会变成两个标签，名字还一模一样。
   */
  function resolveCollectionId(rawCid, panels) {
    const list = (panels || []).filter((p) => p && p.id);
    const s = String(rawCid == null ? '' : rawCid).trim();
    if (!s) return s;
    let hit = list.find((p) => p.id === s);
    if (!hit) hit = list.find((p) => p.id === s.toLowerCase());
    if (!hit) hit = list.find((p) => String(p.name || '').trim() === s);
    return hit ? hit.id : s;
  }

  /** 配对键比较用的规范化：忽略首尾/重复空格与大小写 */
  function normItemKey(v) {
    return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function keyCandidates(panel) {
    return [panel && panel.primary, 'name', 'id', '名称', '姓名', 'title']
      .filter((k) => typeof k === 'string' && k);
  }

  /** 决定这个集合用哪个字段做配对键 */
  function pickKey(panel, list, item) {
    const cand = keyCandidates(panel);
    for (const k of cand) if (item && item[k] != null) return k;
    for (const k of cand) if ((list || []).some((x) => x && x[k] != null)) return k;
    return 'name';
  }

  function fieldTypeOf(panel, fieldKey) {
    const f = panel && Array.isArray(panel.fields) ? panel.fields.find((x) => x && x.key === fieldKey) : null;
    return f ? f.type : undefined;
  }

  function mergeCollection(panel, oldList, newList, errors, warnings, cid) {
    const list = Array.isArray(oldList) ? oldList.filter((x) => x && typeof x === 'object').slice() : [];
    if (!Array.isArray(newList)) {
      // AI 有时把单条写成对象（"collections":{"金手指":{"name":"万法签笺"}}）—— 少了对括号。
      // 这是能自动救回来的，别丢数据，也别弹错误。
      if (newList && typeof newList === 'object') {
        newList = [newList];
        warnings.push('collections.' + cid + ' 不是数组，已按单条处理');
      } else if (typeof newList === 'string' || typeof newList === 'number') {
        newList = [{ name: String(newList) }];
        warnings.push('collections.' + cid + ' 不是数组，已按单条名称处理');
      } else {
        errors.push('collections.' + cid + ' 不是数组，已忽略');
        return list;
      }
    }
    const key = pickKey(panel, list, newList.find((x) => x && typeof x === 'object'));

    for (const item of newList) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const k = item[key];
      if (k == null) { errors.push('collections.' + cid + ' 有条目缺少配对键 ' + key + '，已跳过'); continue; }

      if (item._del === true) {
        const i = list.findIndex((x) => normItemKey(x[key]) === normItemKey(k));
        if (i >= 0) list.splice(i, 1);
        continue;
      }

      // 比较时忽略首尾/重复空格与大小写：「仙豆」和「仙豆 」、「Potion」和「potion」算同一条
      const i = list.findIndex((x) => normItemKey(x[key]) === normItemKey(k));
      if (i >= 0) {
        const merged = Object.assign({}, list[i]);
        for (const fk of Object.keys(item)) {
          if (fk === '_del') continue;
          merged[fk] = mergeField(fieldTypeOf(panel, fk), list[i][fk], item[fk]);
        }
        list[i] = merged;
      } else {
        const copy = Object.assign({}, item);
        delete copy._del;
        list.push(copy);
      }
    }
    return list;
  }

  /* ==================================================================
     三、状态树合并
     ================================================================== */

  function mergeStateInto(target, src, panels, errors, warnings) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      if (src !== undefined) errors.push('state 不是对象，已忽略');
      return;
    }

    for (const k of Object.keys(src)) {
      const v = src[k];
      if (v === undefined || v === null) continue;

      /* --- 动态集合 --- */
      if (k === 'collections') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('state.collections 不是对象，已忽略'); continue; }
        if (!target.collections || typeof target.collections !== 'object') target.collections = {};
        for (const rawCid of Object.keys(v)) {
          const cid = resolveCollectionId(rawCid, panels);
          const panel = (panels || []).find((p) => p && p.id === cid);
          // 取值必须用【原始键】—— 归一化后的 cid 在 v 里可能不存在（AI 写的是中文名）
          target.collections[cid] = mergeCollection(panel, target.collections[cid], v[rawCid], errors, warnings, cid);
        }
        continue;
      }

      /* --- 玩家 --- */
      if (k === 'player') {
        if (!v || typeof v !== 'object') { errors.push('state.player 不是对象，已忽略'); continue; }
        if (!target.player || typeof target.player !== 'object') target.player = {};
        for (const pk of Object.keys(v)) {
          let pv = v[pk];
          if (pv === undefined || pv === null) continue;
          if (pk === 'stats' || pk === 'flags') {
            if (!pv || typeof pv !== 'object') {
              // AI 常把 flags 写成一句话（「穿越者·系统模式」）—— 包成对象收下，别丢整块
              if (pk === 'flags' && (typeof pv === 'string' || typeof pv === 'number')) {
                pv = { 状态: String(pv) };
                warnings.push('state.player.flags 写成了文本，已按「状态」收下');
              } else {
                errors.push('state.player.' + pk + ' 不是对象，已忽略');
                continue;
              }
            }
            if (!target.player[pk] || typeof target.player[pk] !== 'object') target.player[pk] = {};
            for (const fk of Object.keys(pv)) {
              const oldV = target.player[pk][fk];
              // 原本是数值（或数值对）的字段，来了非数值 → 跳过并记录，避免把血量写成“很多”
              if ((isNum(oldV) || Array.isArray(oldV)) && !validNumericInput(pv[fk])) {
                // 先试着抽出数字（「8岁」→8、「八年」→8）；抽得出就照常合并
                const cv = coerceNumericValue(pv[fk]);
                if (cv !== null) {
                  pv[fk] = cv;
                } else {
                  errors.push('state.player.' + pk + '.' + fk + ' 原为数值但新值不是数值，已跳过');
                  continue;
                }
              }
              // stats 天然是数值（含 [当前,上限] 对），按数值合并；flags 走通用规则（可能放标签数组）
              target.player[pk][fk] = mergeField(pk === 'stats' ? 'number' : undefined, oldV, pv[fk]);
            }
          } else if (Array.isArray(pv)) {
            target.player[pk] = pv.slice();          // tags 之类：整组替换
          } else {
            target.player[pk] = pv;
          }
        }
        continue;
      }

      /* --- 资源 / 计数（纯数值） --- */
      if (k === 'resources' || k === 'counters') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('state.' + k + ' 不是对象，已忽略'); continue; }
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        for (const fk of Object.keys(v)) {
          const nv = v[fk];
          if (nv === null || nv === undefined || nv === '') continue;
          if (typeof nv === 'object' && !Array.isArray(nv)) {
            warnings.push('state.' + k + '.' + fk + ' 是对象，没法显示，已跳过');
            continue;
          }
          if (!validNumericInput(nv)) {
            // 不是纯数值（例：灵石 = "3 块下品灵石"）→ 原样存下来按文本显示。
            // 以前这里直接丢弃 + 报错，结果灵石根本不进面板 —— 太严了。
            target[k][fk] = String(nv);
            continue;
          }
          target[k][fk] = mergeField('number', target[k][fk], nv);
        }
        continue;
      }

      /* --- meta：浅合并 --- */
      if (k === 'meta') {
        if (!v || typeof v !== 'object') { errors.push('state.meta 不是对象，已忽略'); continue; }
        target.meta = Object.assign({}, target.meta || {}, v);
        continue;
      }

      /* --- notes：兜底备注，尽量不丢数据 --- */
      if (k === 'notes') {
        if (typeof v === 'string') target.notes = v;
        else if (Array.isArray(v)) target.notes = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('；');
        else if (v && typeof v === 'object') target.notes = JSON.stringify(v);
        else { errors.push('state.notes 类型不支持，已忽略'); continue; }
        // notes 写成对象/数组是常态（实测 58 本书里 22 次），已经转成文本、数据没丢，
        // 不必每次都弹警告打断玩家。真转不了的上面已经记进 errors 了。
        continue;
      }

      /* --- 未知键：对象浅合并，其余覆盖 --- */
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        target[k] = Object.assign({}, target[k] || {}, v);
      } else {
        target[k] = Array.isArray(v) ? v.slice() : v;
      }
    }
  }

  /* ==================================================================
     四、面板清单校验
     ================================================================== */

  const LAYOUTS = ['list', 'grid', 'table', 'kv', 'text'];
  const FIELD_TYPES = ['text', 'number', 'bar', 'tag', 'money', 'enum', 'ref'];

  function sanitizePanels(raw, errors) {
    if (!Array.isArray(raw)) { errors.push('panels 不是数组，已忽略'); return []; }
    const seen = {};
    const out = [];
    for (const p of raw) {
      if (!p || typeof p !== 'object') continue;
      let id = String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (!id) { errors.push('面板缺少 id，已跳过：' + JSON.stringify(p.name || p)); continue; }
      if (seen[id]) { errors.push('面板 id 重复，已跳过：' + id); continue; }
      seen[id] = 1;
      const fields = Array.isArray(p.fields)
        ? p.fields.filter((f) => f && typeof f === 'object' && f.key).map((f) => ({
            key: String(f.key),
            label: String(f.label || f.key),
            type: FIELD_TYPES.includes(f.type) ? f.type : 'text',
            unit: f.unit ? String(f.unit) : undefined,
            options: Array.isArray(f.options) ? f.options.map(String) : undefined,
            target: f.target ? String(f.target) : undefined,
          }))
        : [];
      out.push({
        id,
        name: String(p.name || id),
        icon: p.icon ? String(p.icon) : '',
        sidebar: !!p.sidebar,
        layout: LAYOUTS.includes(p.layout) ? p.layout : 'list',
        primary: p.primary ? String(p.primary) : (fields[0] ? fields[0].key : 'name'),
        groupBy: p.groupBy ? String(p.groupBy) : undefined,
        fields,
      });
      if (out.length >= 16) { errors.push('面板超过 16 个，其余已忽略'); break; }
    }
    return out;
  }

  /* ==================================================================
     五、JSON 抽取 / 修复 / 抢救
     ================================================================== */

  /** 从整段回复里取出候选 JSON 文本（优先代码块，其次裸花括号） */
  function candidatesFrom(text) {
    const t = String(text || '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
    const out = [];
    const fence = /```[ \t]*([a-zA-Z]*)[ \t]*\n([\s\S]*?)(?:```|$)/g;   // 结尾 fence 缺失也收
    let m;
    while ((m = fence.exec(t)) !== null) {
      const lang = (m[1] || '').toLowerCase();
      const body = m[2];
      if (lang === 'json' || lang === '' || /[{[]/.test(body)) out.push(body.trim());
    }
    // 裸 JSON：找最后一个看起来像补丁的平衡块
    for (const key of ['"op"', '"state"', '"gw"']) {
      const idx = t.lastIndexOf(key);
      if (idx < 0) continue;
      const start = t.lastIndexOf('{', idx);
      if (start < 0) continue;
      const block = takeBalanced(t, start);
      if (block) out.push(block);
    }
    return out.filter((s) => s && s.length > 1);
  }

  /** 从 pos 起取一个括号平衡的块（感知字符串与转义）；不平衡就补全后返回 */
  function takeBalanced(t, pos) {
    const open = t[pos];
    if (open !== '{' && open !== '[') return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = pos; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) return t.slice(pos, i + 1); }
    }
    return repairText(t.slice(pos));    // 没闭合 → 补全
  }

  /** 常见格式错误的就地修复 */
  function repairText(s) {
    let t = String(s);
    t = t.replace(/^\uFEFF/, '');
    // 全角符号
    t = t.replace(/[｛]/g, '{').replace(/[｝]/g, '}').replace(/[［]/g, '[').replace(/[］]/g, ']')
         .replace(/[：]/g, ':').replace(/[，]/g, ',');
    // 中文/智能引号 → 直引号（只处理成对出现的情况，避免误伤正文）
    if (!/"/.test(t)) t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, '"');
    // 去除注释（JSON 标准不支持）
    t = t.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    // 非法字面量
    t = t.replace(/([:,\[]\s*)(NaN|undefined|None)\s*([,}\]])/g, '$1null$3');
    t = t.replace(/([:,\[]\s*)-?Infinity\s*([,}\]])/g, '$1null$2');
    // 单引号键：{'a':1} → {"a":1}（仅在完全没有双引号时尝试）
    if (!/"/.test(t)) t = t.replace(/'([^'\\]*)'/g, '"$1"');
    // 尾逗号
    t = t.replace(/,\s*([}\]])/g, '$1');
    // 补括号、补未闭合字符串
    return balanceText(t);
  }

  function balanceText(t) {
    let out = String(t);
    let depth = 0, inStr = false, esc = false;
    const stack = [];
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') stack.pop();
    }
    if (inStr) out += '"';
    out = out.replace(/[,\s]+$/, '');              // 截断在逗号上时去掉
    while (stack.length) out += (stack.pop() === '{' ? '}' : ']');
    return out;
  }

  /** 整体解析失败时：按顶层分节逐个抢救 */
  function salvageSections(text) {
    const t = repairText(text);
    const out = {};
    for (const key of SECTIONS) {
      const re = new RegExp('"' + key + '"\\s*:');
      const m = re.exec(t);
      if (!m) continue;
      let i = m.index + m[0].length;
      while (i < t.length && /\s/.test(t[i])) i++;
      const c = t[i];
      let raw;
      if (c === '{' || c === '[') {
        raw = takeBalanced(t, i);
      } else {
        const mm = /^(-?\d+(?:\.\d+)?|true|false|null|"[^"]*")/.exec(t.slice(i));
        raw = mm ? mm[1] : null;
      }
      if (raw == null) continue;
      try { out[key] = JSON.parse(raw); } catch (e) { /* 这一节救不回来就丢掉 */ }
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * 从 AI 回复里抽取补丁。
   * @returns {{patch:object, via:string, raw:string}|null}  null = 没找到可用 JSON
   */
  function extractPatch(text) {
    const cands = candidatesFrom(text);
    if (!cands.length) return null;

    // 1) 原样解析（只看最后一个候选，通常就是末尾的补丁块）
    for (let i = cands.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(cands[i]);
        if (j && typeof j === 'object' && !Array.isArray(j)) return { patch: j, via: 'direct', raw: cands[i] };
      } catch (e) { /* 继续 */ }
    }
    // 2) 修复后解析
    for (let i = cands.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(repairText(cands[i]));
        if (j && typeof j === 'object' && !Array.isArray(j)) return { patch: j, via: 'repaired', raw: cands[i] };
      } catch (e) { /* 继续 */ }
    }
    // 3) 按分节抢救
    for (let i = cands.length - 1; i >= 0; i--) {
      const s = salvageSections(cands[i]);
      if (s) return { patch: s, via: 'salvaged', raw: cands[i] };
    }
    return null;
  }

  /* ==================================================================
     六、对外主接口
     ================================================================== */

  function createStore() {
    return { gw: VERSION, panels: [], state: {}, journal: [], rolls: [], turn: 0 };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o || {})); }

  /**
   * 把补丁合并进 store，返回新 store（不改原对象）。
   * @returns {{store, ok, errors:string[], via:string, applied:boolean}}
   */
  function applyPatch(store, patch, via) {
    const errors = [], warnings = [];
    const next = clone(store) || createStore();
    if (!next.panels) next.panels = [];
    if (!next.state) next.state = {};
    if (!Array.isArray(next.journal)) next.journal = [];
    if (!Array.isArray(next.rolls)) next.rolls = [];

    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { store: next, ok: false, errors: ['补丁不是对象'], warnings: [], via: via || '', applied: false };
    }

    let mode = String(patch.op || 'patch').toLowerCase();
    const hasState = Object.keys(next.state).length > 0;

    // 已有状态时 AI 又发 init：**不能整包丢掉**。
    // 有些规则书的 AI 每回合都发 init；整包拒绝会导致它写的所有数据
    // 一条都进不来（玩家看到「6 面板 · 0 条」）。
    // 改成降级为普通补丁【合并】—— 只覆盖它写了的字段，面板结构仍不变。
    let downgradedInit = false;
    if (mode === 'init' && hasState) {
      mode = 'patch';
      downgradedInit = true;
      warnings.push('AI 又发了 op:"init"（本局已有状态）→ 已按普通补丁合并，面板结构保持不变');
    }
    if (mode === 'reset') {
      next.state = {};
      next.journal = [];
      next.rolls = [];
      next.turn = 0;
      if (patch.panels) next.panels = sanitizePanels(patch.panels, errors);
      mode = 'init';
    }
    if (mode === 'init' && patch.panels) {
      next.panels = sanitizePanels(patch.panels, errors);
    } else if (patch.panels) {
      // 面板结构不允许【改写】（防止覆盖玩家已有面板），但允许【追加】。
      // 这样 AI 事后想补一张「系统／金手指」面板随时可以；
      // 开局 init 忘了给 panels 的那一局也能靠这个救回来。
      const want = sanitizePanels(patch.panels, errors);
      const haveIds = {};
      next.panels.forEach((p) => { haveIds[p.id] = 1; });
      const added = want.filter((p) => !haveIds[p.id]);
      if (added.length) {
        next.panels = next.panels.concat(added);
        warnings.push('已追加 ' + added.length + ' 张新面板：' + added.map((p) => p.name || p.id).join('／'));
      } else if (!next.panels.length) {
        warnings.push('本回合的 panels 没能建起来（格式可能不对）');
      }
    }

    // 玩家自己取的名字不给改（协议里本来就要求 AI 绝不代命名）
    const keptName = (store.state && store.state.player && store.state.player.name) || '';

    mergeStateInto(next.state, patch.state, next.panels, errors, warnings);

    if (downgradedInit && keptName) {
      if (!next.state.player) next.state.player = {};
      next.state.player.name = keptName;
    }

    // 大事记：追加
    if (Array.isArray(patch.journal)) {
      for (const e of patch.journal) {
        if (!e) continue;
        const text = typeof e === 'string' ? e : e.text;
        if (!text) continue;
        // AI 有时会把整份大事记重发一遍 → 已经有的别再追加（否则整段翻倍）
        const jt = String(text).trim();
        if (next.journal.some((x) => String(x.text || '').trim() === jt)) continue;
        next.journal.push({
          date: (typeof e === 'object' && e.date) ? String(e.date) : String((next.state.meta && next.state.meta.date) || ''),
          text: String(text),
        });
      }
      if (next.journal.length > 500) next.journal = next.journal.slice(-500);
    } else if (patch.journal !== undefined) {
      errors.push('journal 不是数组，已忽略');
    }

    // 骰点：只保留最近一次（用于渲染徽章）
    if (Array.isArray(patch.rolls)) next.rolls = patch.rolls.filter((r) => r && typeof r === 'object');
    else if (patch.rolls !== undefined) errors.push('rolls 不是数组，已忽略');

    if (typeof patch.turn === 'number' && isFinite(patch.turn)) next.turn = patch.turn;
    else next.turn = (next.turn || 0) + 1;   // 应用成功即算一个回合（首回合为 1）

    return { store: next, ok: errors.length === 0, errors, warnings, via: via || '', applied: true };
  }

  /** 一步到位：从 AI 回复文本 -> 新 store */
  function applyFromText(store, text) {
    const got = extractPatch(text);
    if (!got) {
      return { store: clone(store) || createStore(), ok: false, applied: false, via: 'none', warnings: [],
               errors: ['回复里没找到可用的 JSON 状态块（本回合面板保持上一次）'] };
    }
    const r = applyPatch(store, got.patch, got.via);
    if (!Array.isArray(r.warnings)) r.warnings = [];
    // 自动修复/抢救属于「无害恢复」，记到 warnings，不当作错误弹给玩家
    if (got.via !== 'direct') r.warnings.unshift('JSON 有格式问题，已自动修复（' + got.via + '）');
    r.ok = r.errors.length === 0;
    return r;
  }

  /** 去掉 AI 回复里的 JSON 块，只留正文（用于聊天显示） */
  function stripJson(text) {
    return String(text || '')
      .replace(/```[ \t]*[a-zA-Z]*[ \t]*\n?[\s\S]*?(?:```|$)/g, (block) => (/[{[]\s*"(gw|op|state)"/.test(block) ? '' : block))
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 流式渲染专用：先砍掉「末尾未闭合的代码围栏」，再剥 JSON。
   * 流式过程中 JSON 块是边到边长的，不先砍围栏的话会看到半截 JSON。
   */
  function stripForDisplay(text) {
    let s = String(text || '');
    const fences = (s.match(/```/g) || []).length;
    if (fences % 2 === 1) s = s.slice(0, s.lastIndexOf('```'));   // 奇数个 = 有未闭合的围栏
    return stripJson(s);
  }

  return {
    VERSION, createStore, applyPatch, applyFromText, extractPatch, stripJson, stripForDisplay,
    repairText, balanceText, salvageSections, sanitizePanels,
    // 单独暴露给测试
    _internals: { toNumber, mergeNum, mergePair, mergeField, mergeCollection, mergeStateInto, takeBalanced, validNumericInput },
  };
});
