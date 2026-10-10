/* ==========================================================================
   文字游戏工坊 · 面板渲染器（render.js）
   --------------------------------------------------------------------------
   作用：把 state.js 维护的结构化状态，渲染成可以看的标签面板。
   对应《状态Schema设计.md》第 3、4 项。

   设计：
     · 纯函数，输入 store，输出 HTML 字符串（好测试、两个 App 共用）
     · 五种 layout：list / grid / table / kv / text
     · 七种 field.type：text / number / bar / tag / money / enum / ref
     · 内置三个标签：📌 总览（meta+player+资源+计数）、🤖 遗忘度…（无）、📜 大事记
     · AI 多给的、面板没声明的字段也会显示（避免数据「存了但看不见」）
     · 所有内容都转义，防注入

   浏览器：<script src="render.js"></script> → window.GWPanel
   Node：  module.exports = GWPanel
   ========================================================================== */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.GWPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- 基础 ---------------- */

  /* 把 AI 误用的 LaTeX 变成纯文本。
   有的规则书里有「面板美化（LaTeX）」这种选项，AI 选了就真去输出
   \textcolor{#FFD700}{胎穿} 这种东西 —— 网页不认，会直接显示成源码。
   这里做一次兜底转换：去掉颜色/字体命令、把装饰命令换成纯文本。 */
function deLatex(s) {
  let t = String(s == null ? '' : s);
  if (t.indexOf('\\') < 0) return t;
  t = t.replace(/\\[()\[\]]/g, '');                          // \( \) \[ \]
  t = t.replace(/\$\$?/g, '');                               // $ $$
  t = t.replace(/\\colorbox\{[^}]*\}\{/g, '');               // \colorbox{c}{X} → X
  t = t.replace(/\\fcolorbox\{[^}]*\}\{[^}]*\}\{/g, '');
  t = t.replace(/\\textcolor\{[^}]*\}\{/g, '');              // \textcolor{c}{X} → X
  t = t.replace(/\\(?:overline|underline|textbf|textit|emph|textsf|texttt|textrm|mbox|mathrm|mathbf|mathit)\b\s*/g, '');
  t = t.replace(/\\(?:qquad|quad|hspace|vspace)\*?(\{[^}]*\})?/g, '  ');
  t = t.replace(/\\(?:large|Large|LARGE|huge|Huge|small|footnotesize|scriptsize|tiny|normalsize|bfseries|itshape|ttfamily|sffamily|rmfamily|centering|noindent|hline|newline|par|bigskip|medskip|smallskip)\b\s*/g, '');
  t = t.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, '');         // 兜底：其它 \命令
  t = t.replace(/[{}\\]/g, '');                              // 剩下的花括号反斜杠
  return t;
}

function esc(s) {
    s = deLatex(s);
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const isBlank = (v) => v === null || v === undefined || v === '' ||
                        (Array.isArray(v) && v.length === 0) ||
                        (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

  function num(v) {
    if (isNum(v)) return v;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return parseFloat(v);
    return null;
  }

  /* ---------------- 英文键 → 中文 ---------------- */
  // AI 有时会用英文写状态字段名（zenny / luck / hp…），面板直接显示会一串英文。
  // 这里做一份常用译名表；字典里没有的英文键原样保留，不会乱翻。
  const ALIAS = {
    zenny: '金钱', gold: '金币', money: '金钱', cash: '现金', coin: '金币', coins: '金币', credit: '信用点',
    luck: '幸运', fate: '气运', fortune: '机缘', karma: '因果', destiny: '命数',
    hp: '生命', health: '生命', maxhp: '生命上限', mp: '内力', sp: '气力', ep: '能量', ap: '行动力',
    stamina: '体力', energy: '能量', mana: '法力', qi: '气', ki: '气', chakra: '查克拉', nen: '念',
    exp: '经验', xp: '经验', level: '等级', lv: '等级', lvl: '等级', rank: '阶位',
    str: '力量', strength: '力量', agi: '敏捷', agility: '敏捷', dex: '灵巧', int: '智力',
    con: '体质', vit: '体质', atk: '攻击', attack: '攻击', def: '防御', defense: '防御',
    spd: '速度', speed: '速度', crit: '暴击', dodge: '闪避', hit: '命中',
    reputation: '声望', renown: '声望', fame: '名望', infamy: '恶名', honor: '荣誉',
    sanity: '理智', corruption: '堕落', merit: '功德', infamy_point: '恶名',
    party: '队伍', role: '身份', timeline: '时间线', difficulty: '难度',
    progress: '进度', stage: '阶段', chapter: '章节', turn: '回合', day: '天数',
    age: '年龄', gender: '性别', race: '种族', class: '职业', title: '称号',
    // 面板条目里高频出现、但以前没登记的键（玩家实测：qty / desc 直接显示了英文）
    qty: '数量', quantity: '数量', count: '数量', num: '数量', amount: '数量', total: '总计',
    desc: '说明', description: '说明', detail: '详情', details: '详情', info: '信息',
    note: '备注', notes: '备注', remark: '备注', comment: '评价', summary: '摘要',
    effect: '效果', effects: '效果', func: '功能', function: '功能', ability: '能力',
    cost: '消耗', price: '价格', fee: '费用', req: '要求', require: '要求', requirement: '要求',
    condition: '条件', unlock: '解锁', unlocked: '已解锁', locked: '未解锁',
    status: '状态', state: '状态', phase: '阶段', mode: '模式', form: '形态',
    type: '类型', kind: '类型', category: '类别', tag: '标签', tags: '标签',
    grade: '品阶', quality: '品质', tier: '阶位', star: '星级', rarity: '稀有度',
    owner: '持有者', source: '来源', target: '目标', from: '来自',
    time: '时间', date: '日期', place: '地点', location: '地点', where: '位置',
    rel: '关系', relation: '关系', affinity: '好感', favor: '好感',
    faction: '势力', sect: '门派', org: '组织', guild: '公会',
    objective: '目标', reward: '奖励', rewards: '奖励', goal: '目标',
    slot: '部位', equip: '装备', weapon: '武器', armor: '护甲',
    usage: '用途', uses: '可用次数', remaining: '剩余', limit: '上限',
    hidden: '隐藏', visible: '可见', active: '是否启用', enabled: '是否启用',
    player: '玩家', gm: '主持', world: '世界', scene: '场景', event: '事件',
  };

  /** 英文键尽量译成中文；已是中文或字典里没有就原样返回 */
  function zhKey(k) {
    const s = String(k == null ? '' : k);
    if (!s) return s;
    if (/[\u4e00-\u9fa5]/.test(s)) return s;                 // 本来就是中文
    const key = s.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (ALIAS[key]) return ALIAS[key];
    if (key.indexOf('max_') === 0 && ALIAS[key.slice(4)]) return ALIAS[key.slice(4)] + '上限';   // max_hp
    if (key.slice(-4) === '_max' && ALIAS[key.slice(0, -4)]) return ALIAS[key.slice(0, -4)] + '上限'; // hp_max
    if (key.indexOf('cur_') === 0 && ALIAS[key.slice(4)]) return '当前' + ALIAS[key.slice(4)];   // cur_hp
    if (key.slice(-4) === '_cur' && ALIAS[key.slice(0, -4)]) return '当前' + ALIAS[key.slice(0, -4)];
    const parts = key.split('_').filter(Boolean);              // 其余多段：每段都认得才拼
    if (parts.length > 1 && parts.every((p) => ALIAS[p])) return parts.map((p) => ALIAS[p]).join('');
    return s;                                                  // 不认识的原样显示
  }

  /* ---------------- 字段渲染 ---------------- */

  function barHtml(cur, max) {
    const c = num(cur), m = num(max);
    if (c === null) return esc(cur);
    if (m === null || m <= 0) return esc(String(c));
    const pct = Math.max(0, Math.min(100, Math.round((c / m) * 100)));
    const cls = pct <= 25 ? 'lo' : pct <= 60 ? 'mid' : 'hi';
    return '<span class="pv-bar"><i class="pv-bar-in ' + cls + '" style="width:' + pct + '%"></i></span>' +
           '<span class="pv-bart">' + esc(String(c)) + ' / ' + esc(String(m)) + '</span>';
  }

  /** 单个字段值 → HTML */
  function fmt(field, v) {
    if (isBlank(v)) return '<span class="pv-mute">—</span>';
    const t = field && field.type;
    const unit = (field && field.unit) ? '<span class="pv-unit">' + esc(field.unit) + '</span>' : '';

    if (t === 'bar' || (Array.isArray(v) && v.length === 2 && num(v[0]) !== null && num(v[1]) !== null)) {
      return barHtml(v[0], v[1]);
    }
    if (t === 'tag') {
      const arr = Array.isArray(v) ? v : String(v).split(/[、,，]/).filter(Boolean);
      return arr.map((x) => '<span class="pv-tag">' + esc(x) + '</span>').join('');
    }
    if (t === 'enum') {
      return '<span class="pv-enum" data-v="' + esc(v) + '">' + esc(v) + '</span>';
    }
    if (t === 'money' || t === 'number') {
      const n = num(v);
      return '<span class="pv-num">' + esc(n === null ? v : String(n)) + '</span>' + unit;
    }
    if (t === 'ref') return '<span class="pv-ref">' + esc(v) + '</span>';
    if (Array.isArray(v)) {
      return v.map((x) => '<span class="pv-tag">' + esc(typeof x === 'object' ? JSON.stringify(x) : x) + '</span>').join('');
    }
    if (typeof v === 'object') return '<span class="pv-json">' + esc(JSON.stringify(v)) + '</span>';
    return esc(v);
  }

  /** 取一条记录要显示的字段：面板声明的 + 数据里多出来的 */
  function fieldsOf(panel, item, skipKey) {
    const out = [];
    const declared = Array.isArray(panel.fields) ? panel.fields : [];
    for (const f of declared) {
      if (f.key === skipKey) continue;
      if (isBlank(item[f.key])) continue;
      out.push({ label: f.label || f.key, html: fmt(f, item[f.key]) });
    }
    for (const k of Object.keys(item)) {
      if (k === skipKey || k === '_del') continue;
      if (declared.some((f) => f.key === k)) continue;
      if (isBlank(item[k])) continue;
      out.push({ label: zhKey(k), html: fmt({ key: k, type: 'text' }, item[k]) });
    }
    return out;
  }

  function primaryOf(panel, item) {
    const keys = [panel.primary, 'name', 'id', '名称', '姓名', 'title'].filter(Boolean);
    for (const k of keys) if (!isBlank(item[k])) return { key: k, val: item[k] };
    return { key: null, val: '' };
  }

  /* ---------------- 五种 layout ---------------- */

  function renderList(panel, items) {
    return '<div class="pv-list">' + items.map((it) => {
      const p = primaryOf(panel, it);
      const rest = fieldsOf(panel, it, p.key);
      return '<div class="pv-item">' +
        (p.key ? '<div class="pv-main">' + esc(p.val) + '</div>' : '') +
        (rest.length ? '<div class="pv-sub">' + rest.map((f) =>
          '<span class="pv-f"><b>' + esc(f.label) + '</b>' + f.html + '</span>').join('') + '</div>' : '') +
        '</div>';
    }).join('') + '</div>';
  }

  function renderGrid(panel, items) {
    return '<div class="pv-grid">' + items.map((it) => {
      const p = primaryOf(panel, it);
      const rest = fieldsOf(panel, it, p.key);
      return '<div class="pv-card">' +
        (p.key ? '<div class="pv-main">' + esc(p.val) + '</div>' : '') +
        (rest.length ? '<div class="pv-sub">' + rest.map((f) =>
          '<span class="pv-f"><b>' + esc(f.label) + '</b>' + f.html + '</span>').join('') + '</div>' : '') +
        '</div>';
    }).join('') + '</div>';
  }

  function renderTable(panel, items) {
    const cols = (Array.isArray(panel.fields) ? panel.fields : []).slice();
    // 补上数据里多出来的列
    for (const it of items) {
      for (const k of Object.keys(it)) {
        if (k === '_del') continue;
        if (!cols.some((c) => c.key === k)) cols.push({ key: k, label: zhKey(k), type: 'text' });
      }
    }
    if (!cols.length) return renderList(panel, items);
    return '<div class="pv-tw"><table class="pv-table"><thead><tr>' +
      cols.map((c) => '<th>' + esc(c.label || c.key) + '</th>').join('') +
      '</tr></thead><tbody>' + items.map((it) =>
        '<tr>' + cols.map((c) => '<td>' + fmt(c, it[c.key]) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }

  function renderKv(panel, items) {
    return items.map((it) => {
      const rest = fieldsOf(panel, it, null);
      const p = primaryOf(panel, it);
      return (p.key ? '<div class="pv-h">' + esc(p.val) + '</div>' : '') +
        '<div class="pv-kv">' + rest.map((f) =>
          '<div class="pv-k">' + esc(f.label) + '</div><div class="pv-v">' + f.html + '</div>').join('') + '</div>';
    }).join('');
  }

  function renderText(panel, items) {
    return '<div class="pv-text">' + items.map((it) => {
      const p = primaryOf(panel, it);
      const rest = fieldsOf(panel, it, p.key);
      return '<div class="pv-line">' + (p.key ? '<b>' + esc(p.val) + '</b>' : '') +
        (rest.length ? '　' + rest.map((f) => esc(f.label) + '：' + f.html.replace(/<[^>]+>/g, '')).join('　') : '') +
        '</div>';
    }).join('') + '</div>';
  }

  const LAYOUTS = { list: renderList, grid: renderGrid, table: renderTable, kv: renderKv, text: renderText };

  /* ---------------- 内置标签 ---------------- */

  /** notes 可能是 AI 塞进来的 JSON 字符串，转成可读的多行文本 */
  function readableNotes(v) {
    if (typeof v !== 'string') return String(v == null ? '' : v);
    const t = v.trim();
    if (!/^[{[]/.test(t)) return v;
    try {
      const o = JSON.parse(t);
      if (Array.isArray(o)) return o.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n');
      if (o && typeof o === 'object') {
        return Object.keys(o).map((k) => k + '：' + (o[k] && typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k])).join('\n');
      }
    } catch (e) { /* 不是 JSON 就原样显示 */ }
    return v;
  }

  /** 把 player 的 tags + flags 拆成「给人看的」和「内部变量」两组，并去掉重复值 */
  function splitFlags(pl, seen) {
    const human = [], machine = [];
    const isMachineKey = (k) => /^[A-Za-z][A-Za-z0-9_]*$/.test(k);
    // 判定规则：只要【键是英文】（snake_case 那类）就当成内部变量收起来，不管值是中文还是数字。
    // 标签行只留中文键的短语（形态／状态／负面…），这样「孙悟空」下面干干净净。
    const looksInternal = (k, txt) =>
      isMachineKey(k) ||                                   // 英文键 → 一律收起
      /^(true|false)$/i.test(txt) ||                       // 布尔开关
      /^-?\d+(\.\d+)?$/.test(txt) ||                       // 纯数字
      /不可见|秘密|隐藏|仅主持人|GM 备注/.test(txt);          // 玩家不该看到的

    const add = (k, v, forceHuman) => {
      const txt = Array.isArray(v) ? v.join('、')
                : (v && typeof v === 'object' ? JSON.stringify(v) : (v == null ? '' : String(v)));
      const clean = txt.trim();
      if (!clean) return;
      if (k && clean === String(k)) return;                 // 值与键相同，没信息量

      if (!forceHuman && looksInternal(k, clean)) {
        // 内部变量按「键」去重 —— 否则两个不同的开关（都 = true）会被当成重复
        const dk = '@' + k;
        if (seen.has(dk)) return;
        seen.add(dk);
        machine.push({ k, txt });
        return;
      }
      if (seen.has(clean)) return;                          // 人话按「值」去重（与角色名/世界信息比对）
      seen.add(clean);
      human.push({ k, txt });
    };

    (Array.isArray(pl.tags) ? pl.tags : []).forEach((t) => add('', t, true));
    const flags = pl.flags || {};
    Object.keys(flags).forEach((k) => add(k, flags[k], false));
    return { human, machine };
  }

  function renderOverview(store) {
    const s = store.state || {};
    const out = [];

    const meta = s.meta || {};
    const metaRows = [['世界', meta.world], ['日期', meta.date], ['地点', meta.place]]
      .filter(([, v]) => !isBlank(v));
    if (metaRows.length) {
      out.push('<div class="pv-sec"><h4>🌍 世界</h4><div class="pv-kv">' +
        metaRows.map(([k, v]) => '<div class="pv-k">' + esc(k) + '</div><div class="pv-v">' + esc(v) + '</div>').join('') +
        '</div></div>');
    }

    const pl = s.player;
    if (pl && Object.keys(pl).length) {
      const bits = [];
      const seen = new Set();
      // 世界信息里的值先占位，避免下面重复显示（如 timeline = 日期）
      Object.keys(s.meta || {}).forEach((k) => { const v = String(s.meta[k] || '').trim(); if (v) seen.add(v); });

      if (!isBlank(pl.name)) {
        bits.push('<div class="pv-main">' + esc(pl.name) + '</div>');
        seen.add(String(pl.name).trim());
      }

      const stats = pl.stats || {};
      const statKeys = Object.keys(stats).filter((k) => !isBlank(stats[k]));
      if (statKeys.length) {
        bits.push('<div class="pv-kv">' + statKeys.map((k) =>
          '<div class="pv-k">' + esc(zhKey(k)) + '</div><div class="pv-v">' +
          fmt({ key: k, type: Array.isArray(stats[k]) ? 'bar' : 'number' }, stats[k]) + '</div>').join('') + '</div>');
      }

      // 标签 + 状态合并成一排；机器键/布尔/纯数字/GM 隐藏信息收进折叠区
      const { human, machine } = splitFlags(pl, seen);
      if (human.length) {
        bits.push('<div class="pv-sub">' + human.map((it) =>
          '<span class="pv-f">' + (it.k ? '<b>' + esc(it.k) + '</b>' : '') + fmt({ type: 'tag' }, it.txt) + '</span>').join('') + '</div>');
      }
      // machine（英文键/布尔/GM 隐藏信息）不渲染 —— 玩家面板里彻底不出现。
      // splitFlags 仍然要做这个分类：它的作用是保证这些键不会被混进上面的标签行。
      out.push('<div class="pv-sec"><h4>🧍 角色</h4>' + bits.join('') + '</div>');
    }

    const res = s.resources || {}, cnt = s.counters || {};
    // 去重：同一字段可能同时出现在 resources 和 counters 里，不能显示两次
    const nums = [];
    const numSeen = {};
    for (const k of Object.keys(res)) { if (!numSeen[k]) { numSeen[k] = 1; nums.push([k, res[k]]); } }
    for (const k of Object.keys(cnt)) { if (!numSeen[k]) { numSeen[k] = 1; nums.push([k, cnt[k]]); } }
    if (nums.length) {
      out.push('<div class="pv-sec"><h4>💰 资源与计数</h4><div class="pv-kv">' +
        nums.map(([k, v]) => '<div class="pv-k">' + esc(zhKey(k)) + '</div><div class="pv-v">' + fmt({ type: 'number' }, v) + '</div>').join('') +
        '</div></div>');
    }

    // 不再渲染 state.notes —— 它是 AI 自己的兜底记账（如 {"progress":"序章推进"}），
    // 对玩家没有意义。数据仍保留在 store 里，存档与导出不受影响。

    if (Array.isArray(store.rolls) && store.rolls.length) {
      out.push('<div class="pv-sec"><h4>🎲 本回合骰点</h4><div class="pv-list">' + store.rolls.map((r) => {
        const ok = r.ok === true ? 'ok' : r.ok === false ? 'no' : '';
        return '<div class="pv-item"><div class="pv-main">' + esc(r.what || r.kind || '判定') +
          '<span class="pv-roll ' + ok + '">' + esc(r.expr || '') + ' = ' + esc(r.roll) +
          (r.dc !== undefined ? (r.ok ? ' ≥ ' : ' < ') + esc(r.dc) : '') + '</span></div>' +
          (r.note ? '<div class="pv-sub">' + esc(r.note) + '</div>' : '') + '</div>';
      }).join('') + '</div></div>');
    }

    if (!out.length) return '<div class="pv-empty">还没有状态数据。<br/>开局后 AI 会在回复末尾附带状态块，程序自动填到这里。</div>';
    return out.join('');
  }

  function renderJournal(store) {
    const j = Array.isArray(store.journal) ? store.journal : [];
    if (!j.length) return '<div class="pv-empty">还没有大事记。</div>';
    return '<div class="pv-tl">' + j.map((e) =>
      '<div class="pv-tl-i">' +
      (e.date ? '<div class="pv-tl-d">' + esc(e.date) + '</div>' : '') +
      '<div class="pv-tl-t">' + esc(e.text) + '</div></div>').join('') + '</div>';
  }

  /* ---------------- 对外接口 ---------------- */

  /** 配对键规范化：忽略首尾/重复空格与大小写（「仙豆」和「仙豆 」算同一条） */
  function normKey(v) {
    return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** store → 标签数组 */
  function buildTabs(store) {
    store = store || {};
    const tabs = [];
    tabs.push({ id: '__overview', name: '总览', icon: '📌', html: renderOverview(store) });

    const colls = (store.state && store.state.collections) || {};
    const rawPanels = Array.isArray(store.panels) ? store.panels : [];

    // 面板先整理：
    //   · 与内建标签（总览/大事记）同名的丢掉 —— 否则会多出一个一模一样的标签
    //   · 不同 id 但同名的合并成一个标签（AI 有时会声明两个同名面板）
    const BUILTIN_NAMES = { '总览': 1, '大事记': 1 };
    const byName = {};
    const panels = [];
    for (const p of rawPanels) {
      const nm = String(p.name || p.id).trim();
      if (BUILTIN_NAMES[nm]) continue;
      const hit = byName[nm];
      if (hit) { hit.aliasIds.push(p.id); continue; }
      const cp = Object.assign({}, p, { aliasIds: [] });
      byName[nm] = cp;
      panels.push(cp);
    }

    /** 面板空着时，从总览的同类数据里取点东西显示（角色／属性／资源三类） */
    function autoItemsOfPanel(s, p) {
      const label = String((p.name || '') + ' ' + (p.id || ''));
      const pl = (s.player && typeof s.player === 'object') ? s.player : {};
      const rows = [];
      const push = (k, v) => {
        if (isBlank(v) || typeof v === 'object') return;
        rows.push([zhKey(k), v === true ? '是' : v === false ? '否' : String(v)]);
      };
      if (/角色|人物卡|主角|char|role|avatar/i.test(label)) {
        if (!isBlank(pl.name)) rows.push(['姓名', String(pl.name)]);
        Object.keys(pl).forEach((k) => { if (k !== 'name' && k !== 'stats' && k !== 'flags') push(k, pl[k]); });
        const fl = (pl.flags && typeof pl.flags === 'object') ? pl.flags : {};
        Object.keys(fl).forEach((k) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) push(k, fl[k]); });
      }
      if (/属性|数值|能力值|资质|天资|根骨|悟性|灵根|修为|境界|天赋|stat|attr/i.test(label)) {
        const st = (pl.stats && typeof pl.stats === 'object') ? pl.stats : (s.stats || {});
        Object.keys(st).forEach((k) => push(k, st[k]));
      }
      if (/资源|货币|金钱|财富|金锭|res|money|currency/i.test(label)) {
        Object.keys(s.resources || {}).forEach((k) => push(k, s.resources[k]));
        Object.keys(s.counters || {}).forEach((k) => push(k, s.counters[k]));
      }
      return rows;
    }

    // 面板没有中文名时，尽量从 id 猜一个中文名 —— 玩家看到的标签不该是 system
    const PANEL_ZH = {
      system: '系统', sys: '系统', cheats: '金手指', cheat: '金手指', goldenfinger: '金手指',
      bag: '背包', inventory: '背包', items: '道具', item: '道具', gear: '装备', equipment: '装备',
      char: '角色', character: '角色', player: '角色', stats: '属性', attrs: '属性', attributes: '属性',
      skills: '技能', skill: '技能', abilities: '能力', spells: '法术', martial: '武学', arts: '功法',
      npc: '人物', npcs: '人物', people: '人物', relations: '关系', relation: '关系', contacts: '人脉',
      quest: '任务', quests: '任务', task: '任务', tasks: '任务', missions: '任务', objective: '目标',
      faction: '势力', factions: '势力', sect: '门派', org: '组织', guild: '公会', clan: '家族',
      pets: '宠物', pet: '宠物', mounts: '坐骑', beasts: '异兽',
      journal: '大事记', log: '记录', history: '履历',
      titles: '称号', achievements: '成就', buffs: '状态', debuffs: '负面',
      resources: '资源', money: '金钱', currency: '货币', wallet: '钱包',
    };
    function panelName(p) {
      const raw = String((p && p.name) || '').trim();
      if (raw && /[\u4e00-\u9fa5]/.test(raw)) return raw;    // 已经有中文名，用它
      const id = String((p && p.id) || '').trim().toLowerCase();
      if (PANEL_ZH[id]) return PANEL_ZH[id];                  // 按 id 猜
      if (PANEL_ZH[raw.toLowerCase()]) return PANEL_ZH[raw.toLowerCase()];
      return raw || id || '面板';
    }

    // 哪些集合键已经被某个面板吃掉了（别名 id / 拿面板名当键）
    const consumed = {};
    const extrasOf = (p) => {
      const out = [];
      for (const id of (p.aliasIds || [])) out.push(id);
      for (const k of Object.keys(colls)) {
        if (k === p.id) continue;
        if (String(k).trim() === String(p.name || '').trim()) out.push(k);
      }
      return out;
    };

    for (const p of panels) {
      const pk = p.primary || 'name';
      const ids = [p.id].concat(extrasOf(p));
      const items = [];
      const seen = {};
      for (const id of ids) {
        consumed[id] = 1;
        for (const it of (Array.isArray(colls[id]) ? colls[id] : [])) {
          if (!it || typeof it !== 'object') continue;
          const kk = normKey(it[pk]);
          if (kk && seen[kk]) continue;
          if (kk) seen[kk] = 1;
          items.push(it);
        }
      }
      const fn = LAYOUTS[p.layout] || renderList;
      let html;
      let empty = items.length === 0;
      let autoCount = 0;
      if (items.length) {
        html = fn(p, items);
      } else {
        // 回退：AI 常把「角色／属性／资源」写进 player／stats／resources，
        // 而不是 collections.<面板id> —— 这时面板会空着。搬总览里的同类数据过来。
        const auto = autoItemsOfPanel(store.state || {}, p);
        if (auto.length) {
          empty = false;
          autoCount = auto.length;
          html = '<div class="pv-sec"><h4>' + esc(p.icon || '') + ' ' + esc(p.name || p.id) + '</h4>' +
            '<div class="pv-kv">' + auto.map((it) =>
              '<div class="pv-k">' + esc(it[0]) + '</div><div class="pv-v">' + esc(it[1]) + '</div>').join('') +
            '</div></div>' +
            '<div class="pv-empty" style="opacity:.5;font-size:12px;padding-top:6px">数据来自「总览」（AI 还没往 collections.' +
            esc(p.id) + ' 里写过）</div>';
        } else {
        html = '<div class="pv-empty">「' + esc(p.name || p.id) + '」还没有记录。<br/>' +
          '<span style="font-size:12px;opacity:.7">AI 还没往 <code>collections.' + esc(p.id) +
          '</code> 写过数据。</span><br/>' +
          '<button class="tiny pv-fill" data-fill-name="' + esc(p.name || p.id) +
          '" data-fill-id="' + esc(p.id) + '" style="margin-top:8px">🤖 让 AI 补上</button></div>';
        }
      }
      tabs.push({
        id: p.id,
        name: panelName(p),
        icon: p.icon || '',
        count: items.length || autoCount,
        empty: empty,
        hideIfEmpty: true,
        html: html,
      });
    }

    // 有数据但 AI 没声明成面板的集合，也要能看见
    for (const k of Object.keys(colls)) {
      if (consumed[k]) continue;
      const items = Array.isArray(colls[k]) ? colls[k] : [];
      tabs.push({
        id: k, name: k, icon: '', count: items.length, empty: items.length === 0, hideIfEmpty: true,
        html: items.length
          ? renderList({ id: k, primary: 'name', fields: [] }, items)
          : '<div class="pv-empty">暂无记录。</div>',
      });
    }

    if ((store.journal || []).length) {
      tabs.push({ id: '__journal', name: '大事记', icon: '📜', count: store.journal.length, html: renderJournal(store) });
    }
    
    // 空面板【保留】但变暗 —— 整个藏起来等于把 AI 的遗漏一起藏了，
    // 玩家反而发现不了「势力」「任务」没被填。
    tabs.forEach((t) => { if (t.hideIfEmpty) t.dim = !!t.empty; });
    return tabs;
  }

  /** 标签栏 HTML */
  function tabBar(tabs, active) {
    return tabs.map((t) =>
      '<button class="pv-tab' + (t.id === active ? ' on' : '') + (t.dim ? ' dim' : '') +
      '" data-pvtab="' + esc(t.id) + '"' + (t.dim ? ' title="这个面板还没有数据"' : '') + '>' +
      (t.icon ? esc(t.icon) + ' ' : '') + esc(t.name) +
      (t.count ? ' <span class="pv-n">' + t.count + '</span>' : '') +
      '</button>').join('');
  }

  /** 取某个标签的正文 */
  function bodyOf(tabs, active) {
    const t = tabs.find((x) => x.id === active) || tabs[0];
    return t ? t.html : '';
  }

  /** 一句话摘要（给状态栏用） */
  function summary(store) {
    store = store || {};
    const panels = (store.panels || []).length;
    const colls = (store.state && store.state.collections) || {};
    const n = Object.values(colls).reduce((a, b) => a + (Array.isArray(b) ? b.length : 0), 0);
    const turns = store.turn || 0;
    if (!panels && !n) return '';
    return '状态 第' + turns + ' 回合 · ' + panels + ' 面板 · ' + n + ' 条';
  }

  return { esc, fmt, fieldsOf, buildTabs, tabBar, bodyOf, summary,
           renderOverview, renderJournal, barHtml, zhKey, ALIAS };
});
