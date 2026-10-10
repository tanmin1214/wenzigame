/*!
 * docx-browser.js —— 纯浏览器端 .docx / .txt / .md 解析模块（零依赖）
 *
 * 浏览器：<script src="docx-browser.js"></script>  →  window.extractDocxBuffer
 * Node  ：const { extractDocxBuffer } = require('./docx-browser.js')
 *
 * 只使用浏览器原生 / Web 标准 API：
 *   - DecompressionStream('deflate-raw')  解 deflate（Chrome/Edge 103+、Safari 16.4+、Node 18+）
 *   - TextDecoder('utf-8')
 *   - ArrayBuffer / Uint8Array / DataView
 * 不依赖 Blob / Response / fetch（降低兼容门槛，Node 里也能直接跑）。
 *
 * 设计要点：
 *   - 从文件末尾向前搜 EOCD(0x06054b50) → 中央目录偏移与条目数
 *   - 遍历中央目录条目(0x02014b50)，取 name/method/compressedSize/localHeaderOffset
 *   - 使用中央目录里的 compressedSize（Word 常用 data descriptor，本地头 size 可能为 0）
 *   - 数据起点 = localHeaderOffset + 30 + 本地文件名长 + 本地扩展区长
 *   - method 8 → deflate-raw 解压；method 0 → 直接切片
 *   - XML → 文本：保留段落/换行/表格结构，解码命名实体与十进制/十六进制数字实体
 *   - 任何异常都被捕获，返回 { ok:false, error }，绝不抛错
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node
  }
  if (typeof window !== 'undefined') {
    window.extractDocxBuffer = api.extractDocxBuffer;   // 浏览器
  }
  if (root && typeof root === 'object' && !root.extractDocxBuffer) {
    try { root.extractDocxBuffer = api.extractDocxBuffer; } catch (e) { /* ignore */ }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 常量
   * ------------------------------------------------------------------ */

  var SIG_EOCD = 0x06054b50;
  var SIG_CENTRAL = 0x02014b50;
  var SIG_LOCAL = 0x04034b50;
  var SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;
  var SIG_ZIP64_EOCD = 0x06064b50;

  var EOCD_MIN_SIZE = 22;
  var ZIP64_EXTRA_ID = 0x0001;

  var DOCUMENT_PATHS = [
    'word/document.xml',
    'word/document2.xml',
    'word/document.XML'
  ];

  var ERR_UNSUPPORTED_DEFLATE =
    '当前浏览器不支持解压（缺少 DecompressionStream），请换用较新版本的 Chrome / Edge / Safari 再试';

  var ERR_DEFLATE_FAILED =
    '解压失败：deflate 数据损坏，或该文件不是标准 docx（可能是被截断/加密/改名的文件）';

  var ERR_NOT_ZIP_BUT_BINARY =
    '文件不是有效的 docx（缺少 ZIP 头 PK\\x03\\x04），内容也不是可读的 UTF-8 文本（可能是损坏或改名的文件）';

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function isArrayBufferLike(v) {
    if (!v) return false;
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return true;
    if (v.buffer && typeof v.byteLength === 'number' && v.byteLength !== undefined) {
      // TypedArray / DataView
      return (typeof ArrayBuffer !== 'undefined' && v.buffer instanceof ArrayBuffer) ||
        Object.prototype.toString.call(v.buffer) === '[object ArrayBuffer]';
    }
    return false;
  }

  function toUint8Array(input) {
    if (input == null) throw new Error('输入为空：没有拿到文件数据');
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    if (ArrayBuffer.isView && ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (typeof Uint8Array !== 'undefined' && input instanceof Uint8Array) {
      return input;
    }
    if (input && typeof input.byteLength === 'number' && input.buffer) {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    // 兜底：当作普通数组
    if (Array.isArray(input) || typeof input.length === 'number') {
      return new Uint8Array(input);
    }
    throw new Error('无法识别的输入类型，请传入 ArrayBuffer / Uint8Array');
  }

  function hasDecompressionStream() {
    return typeof DecompressionStream !== 'undefined' && DecompressionStream !== null;
  }

  /** 从文件名推断 source：docx | txt | md */
  function sourceFromFilename(filename) {
    var name = String(filename == null ? '' : filename);
    var dot = name.lastIndexOf('.');
    var ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
    if (ext === 'txt') return 'txt';
    if (ext === 'md' || ext === 'markdown') return 'md';
    return 'docx';
  }

  /** 去掉 UTF-8 BOM */
  function stripBOM(text) {
    if (text && text.charCodeAt(0) === 0xfeff) return text.slice(1);
    return text;
  }

  function utf8Decode(bytes) {
    if (typeof TextDecoder === 'undefined') {
      throw new Error('当前环境不支持 TextDecoder，无法解码文本');
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  /* ------------------------------------------------------------------ *
   * deflate-raw 解压
   * ------------------------------------------------------------------ */

  async function inflateRaw(bytes) {
    if (!hasDecompressionStream()) {
      throw new Error(ERR_UNSUPPORTED_DEFLATE);
    }
    try {
      var ds = new DecompressionStream('deflate-raw');
      var writer = ds.writable.getWriter();
      // 不 await write，避免大文件时写入端与读取端互相等待导致死锁
      var writePromise = writer.write(bytes).then(function () {
        return writer.close();
      });
      var readPromise = new Response(ds.readable).arrayBuffer().then(function (buf) {
        return new Uint8Array(buf);
      });
      // 吞掉写入侧的 rejection，防止 UnhandledPromiseRejection
      writePromise.catch(function () { /* 由 readPromise 抛出真实错误 */ });
      return await readPromise;
    } catch (e) {
      // 浏览器抛出的可能是 TypeError（message 为空）等情况，统一成可读信息；
      // 这里只拼一次，且外层 describeError 会原样透传本模块的中文信息
      throw new Error(ERR_DEFLATE_FAILED + rawErrorDetail(e));
    }
  }

  /** 提取底层异常的简短描述（浏览器常常抛出 message 为空的 TypeError） */
  function rawErrorDetail(e) {
    var detail = '';
    if (e) {
      if (typeof e === 'string') detail = e;
      else if (typeof e.message === 'string' && e.message) detail = e.message;
      else if (e.name) detail = String(e.name);
    }
    if (detail && detail !== 'TypeError' && detail !== 'Error') {
      return '（' + detail + '）';
    }
    return '';
  }

  function concatChunks(chunks, total) {
    var out = new Uint8Array(total);
    var off = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].length;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * ZIP 解析
   * ------------------------------------------------------------------ */

  /** 从末尾向前搜 EOCD，返回其在 buffer 中的偏移；找不到返回 -1 */
  function findEOCD(u8) {
    var len = u8.length;
    if (len < EOCD_MIN_SIZE) return -1;
    // 注释最长 65535 字节，加 22 字节 EOCD
    var start = Math.max(0, len - (65535 + EOCD_MIN_SIZE));
    for (var i = len - EOCD_MIN_SIZE; i >= start; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        return i;
      }
    }
    return -1;
  }

  function readU16(dv, off, what) {
    if (off < 0 || off + 2 > dv.byteLength) throw new Error('ZIP 结构损坏：读取 ' + what + ' 越界');
    return dv.getUint16(off, true);
  }

  function readU32(dv, off, what) {
    if (off < 0 || off + 4 > dv.byteLength) throw new Error('ZIP 结构损坏：读取 ' + what + ' 越界');
    return dv.getUint32(off, true);
  }

  function readU64(dv, off, what) {
    if (off < 0 || off + 8 > dv.byteLength) throw new Error('ZIP 结构损坏：读取 ' + what + ' 越界');
    var lo = dv.getUint32(off, true);
    var hi = dv.getUint32(off + 4, true);
    if (hi > 0x1fffff) throw new Error('ZIP64 条目过大，超出可安全处理的范围（' + what + '）');
    return hi * 4294967296 + lo;
  }

  /** 解析中央目录里的 extra field，取 ZIP64 的 uncompressedSize / compressedSize */
  function parseZip64Extra(dv, extraOff, extraLen, entry) {
    var end = extraOff + extraLen;
    var p = extraOff;
    while (p + 4 <= end) {
      var id = dv.getUint16(p, true);
      var size = dv.getUint16(p + 2, true);
      var body = p + 4;
      if (id === ZIP64_EXTRA_ID) {
        var q = body;
        // 只有对应字段为 0xFFFFFFFF 时才存在
        if (entry.compressedSize === 0xffffffff) {
          entry.compressedSize = readU64(dv, q, 'ZIP64 compressedSize'); q += 8;
        }
        if (entry.uncompressedSize === 0xffffffff) {
          entry.uncompressedSize = readU64(dv, q, 'ZIP64 uncompressedSize'); q += 8;
        }
        if (entry.localHeaderOffset === 0xffffffff) {
          entry.localHeaderOffset = readU64(dv, q, 'ZIP64 localHeaderOffset'); q += 8;
        }
        return;
      }
      p = body + size;
    }
  }

  /**
   * 解析 zip 中央目录。
   * @returns {{entries: Array, dataStart: number, comment: string}}
   */
  function parseCentralDirectory(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = findEOCD(u8);
    if (eocd < 0) {
      throw new Error('不是有效的 ZIP/docx 文件：未找到 EOCD 结束记录（文件可能已损坏或被截断）');
    }

    var totalEntries = readU16(dv, eocd + 10, '条目数');
    var cdSize = readU32(dv, eocd + 12, '中央目录大小');
    var cdOffset = readU32(dv, eocd + 16, '中央目录偏移');
    var commentLen = readU16(dv, eocd + 20, '注释长度');

    var comment = '';
    if (commentLen > 0 && eocd + EOCD_MIN_SIZE + commentLen <= u8.length) {
      try {
        comment = utf8Decode(u8.subarray(eocd + EOCD_MIN_SIZE, eocd + EOCD_MIN_SIZE + commentLen));
      } catch (e) { comment = ''; }
    }

    // ZIP64：EOCD 字段为哨兵值时，从 ZIP64 EOCD Locator 里取真实值
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
      var locOff = eocd - 20;
      if (locOff >= 0 && readU32(dv, locOff, 'ZIP64 locator 签名') === SIG_ZIP64_EOCD_LOCATOR) {
        var z64Off = readU64(dv, locOff + 8, 'ZIP64 EOCD 偏移');
        if (z64Off >= 0 && z64Off + 56 <= u8.length &&
            readU32(dv, z64Off, 'ZIP64 EOCD 签名') === SIG_ZIP64_EOCD) {
          totalEntries = readU64(dv, z64Off + 32, 'ZIP64 条目数');
          cdSize = readU64(dv, z64Off + 40, 'ZIP64 中央目录大小');
          cdOffset = readU64(dv, z64Off + 48, 'ZIP64 中央目录偏移');
        }
      }
    }

    if (totalEntries === 0) {
      throw new Error('ZIP 中没有条目：文件可能为空或已损坏');
    }
    if (cdOffset < 0 || cdOffset + 4 > u8.length) {
      throw new Error('ZIP 结构损坏：中央目录偏移超出文件范围（文件可能被截断）');
    }
    if (cdSize > 0 && cdOffset + cdSize > u8.length) {
      throw new Error('ZIP 结构损坏：中央目录被截断（期望 ' + cdSize +
        ' 字节，实际只剩 ' + (u8.length - cdOffset) + ' 字节）');
    }

    var entries = [];
    var p = cdOffset;
    for (var i = 0; i < totalEntries; i++) {
      if (p + 46 > u8.length) {
        throw new Error('ZIP 结构损坏：中央目录条目被截断（第 ' + (i + 1) + ' / ' + totalEntries + ' 条）');
      }
      if (readU32(dv, p, '中央目录签名') !== SIG_CENTRAL) {
        throw new Error('ZIP 结构损坏：第 ' + (i + 1) + ' 个中央目录条目签名非法');
      }
      var method = readU16(dv, p + 10, '压缩方法');
      var compSize = readU32(dv, p + 20, 'compressedSize');
      var uncompSize = readU32(dv, p + 24, 'uncompressedSize');
      var nameLen = readU16(dv, p + 28, '文件名长度');
      var extraLen = readU16(dv, p + 30, '扩展区长度');
      var cmtLen = readU16(dv, p + 32, '条目注释长度');
      var localOff = readU32(dv, p + 42, 'localHeaderOffset');

      if (p + 46 + nameLen + extraLen + cmtLen > u8.length) {
        throw new Error('ZIP 结构损坏：中央目录条目内容被截断（第 ' + (i + 1) + ' 条）');
      }
      var name = utf8Decode(u8.subarray(p + 46, p + 46 + nameLen));

      var entry = {
        name: name,
        method: method,
        compressedSize: compSize,
        uncompressedSize: uncompSize,
        localHeaderOffset: localOff,
        extraOffset: p + 46 + nameLen,
        extraLength: extraLen
      };
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOff === 0xffffffff) {
        parseZip64Extra(dv, entry.extraOffset, entry.extraLength, entry);
      }
      entries.push(entry);
      p = p + 46 + nameLen + extraLen + cmtLen;
    }
    return { entries: entries, dataStart: cdOffset, comment: comment };
  }

  function normalizePath(name) {
    return String(name || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
  }

  function findDocumentEntry(entries) {
    var i, j, want;
    // 1) 精确匹配已知路径
    for (i = 0; i < DOCUMENT_PATHS.length; i++) {
      want = DOCUMENT_PATHS[i].toLowerCase();
      for (j = 0; j < entries.length; j++) {
        if (normalizePath(entries[j].name) === want) return entries[j];
      }
    }
    // 2) word/ 下的 document*.xml（忽略大小写、反斜杠）
    for (j = 0; j < entries.length; j++) {
      var n = normalizePath(entries[j].name);
      if (n.indexOf('word/') === 0 && /^word\/document[^/]*\.xml$/.test(n)) return entries[j];
    }
    // 3) 任意 document*.xml
    for (j = 0; j < entries.length; j++) {
      if (/document[^/]*\.xml$/.test(normalizePath(entries[j].name))) return entries[j];
    }
    // 4) 退一步：第一个 .xml
    for (j = 0; j < entries.length; j++) {
      if (/\.xml$/.test(normalizePath(entries[j].name))) return entries[j];
    }
    return null;
  }

  /** 取出某条目解压后的原始字节 */
  async function readEntryData(u8, dv, entry) {
    var lo = entry.localHeaderOffset;
    if (lo < 0 || lo + 30 > u8.length) {
      throw new Error('ZIP 结构损坏：本地文件头偏移越界（' + entry.name + '）');
    }
    if (readU32(dv, lo, '本地文件头签名') !== SIG_LOCAL) {
      throw new Error('ZIP 结构损坏：本地文件头签名非法（' + entry.name + '）');
    }
    var localNameLen = readU16(dv, lo + 26, '本地文件名长度');
    var localExtraLen = readU16(dv, lo + 28, '本地扩展区长度');
    var dataStart = lo + 30 + localNameLen + localExtraLen;

    // 关键：用中央目录里的 compressedSize（Word 常用 data descriptor，本地头 size 可能为 0）
    var size = entry.compressedSize;
    if (!size || size === 0xffffffff) {
      var localSize = readU32(dv, lo + 18, '本地 compressedSize');
      size = localSize;
    }
    if (!size) {
      throw new Error('ZIP 条目压缩大小为 0，无法解析（' + entry.name + '）');
    }
    if (dataStart + size > u8.length) {
      throw new Error('ZIP 数据被截断：' + entry.name + ' 需要 ' + size +
        ' 字节，实际只剩 ' + (u8.length - dataStart) + ' 字节');
    }
    var raw = u8.subarray(dataStart, dataStart + size);

    if (entry.method === 0) {
      return raw;                       // 存储：直接读
    }
    if (entry.method === 8) {
      return await inflateRaw(raw);     // deflate
    }
    throw new Error('不支持的 ZIP 压缩方法 method=' + entry.method + '（' + entry.name +
      '，仅支持 0=存储 / 8=deflate）');
  }

  /* ------------------------------------------------------------------ *
   * XML → 文本
   * ------------------------------------------------------------------ */

  /** 解码 XML 实体；&amp; 最后处理，避免 &amp;lt; 被误解成 '<' */
  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    var out = s;
    out = out.replace(/&#x([0-9a-fA-F]+);/g, function (m, hex) {
      try {
        var cp = parseInt(hex, 16);
        if (!isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
        return String.fromCodePoint(cp);
      } catch (e) { return m; }
    });
    out = out.replace(/&#([0-9]+);/g, function (m, dec) {
      try {
        var cp = parseInt(dec, 10);
        if (!isFinite(cp) || cp < 0 || cp > 0x10ffff) return m;
        return String.fromCodePoint(cp);
      } catch (e) { return m; }
    });
    out = out.replace(/&lt;/g, '<');
    out = out.replace(/&gt;/g, '>');
    out = out.replace(/&quot;/g, '"');
    out = out.replace(/&apos;/g, "'");
    out = out.replace(/&nbsp;/g, '\u00a0');
    out = out.replace(/&amp;/g, '&');   // 必须最后
    return out;
  }

  /** 压缩连续空行，最多留一个（这里直接丢弃纯空行，保持与参照解析器一致） */
  function condenseBlankLines(text) {
    var lines = text.split('\n');
    var out = [];
    var pushLastNonEmpty = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/[ \t\u00a0]+$/g, '');
      var trimmed = line.replace(/[\s\u00a0]+/g, '');
      if (trimmed === '') {
        if (pushLastNonEmpty) {
          out.push('');      // 最多一个空行
          pushLastNonEmpty = false;
        }
        continue;
      }
      out.push(line);
      pushLastNonEmpty = true;
    }
    return out.join('\n');
  }

  function xmlToText(xml, htmlMode) {
    var s = String(xml);

    // 去掉 XML 声明、注释、CDATA、DOCTYPE，避免残留内容与误判标签
    s = s.replace(/<\?[\s\S]*?\?>/g, '');
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    s = s.replace(/<!DOCTYPE[^>]*>/gi, '');

    // 段落 / 表格结构 → 换行与分隔符
    s = s.replace(/<\/(?:w:)?p>/g, '\n');
    s = s.replace(/<\/(?:w:)?tr>/g, '\n');
    s = s.replace(/<\/(?:w:)?tc>/g, ' | ');
    // 换行符（含自闭合与带属性形式）
    s = s.replace(/<(?:w:)?br\b[^>]*\/?>/g, '\n');
    // 制表符
    s = s.replace(/<(?:w:)?tab\b[^>]*\/?>/g, '\t');
    // 单元格内段落结束不应把 " | " 顶掉（前面已插 \n，去掉紧邻分隔符前的换行）
    s = s.replace(/\n[ \t]*\|/g, ' |');

    // HTML 模式专属：只在解析 Word 另存的网页时启用。
    // OOXML 与 HTML 有同名不同义的标签，无条件加会改变 .docx 的解析结果。
    if (htmlMode) {
      // 样式表和脚本整段丢掉（Word 另存的网页里 CSS 特别多）
      s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
      // HTML 的块级标签 → 换行
      s = s.replace(/<\/(?:div|li|h[1-6]|blockquote|pre|section|article|header|footer|figure|figcaption)>/gi, '\n');
      // HTML 的单元格 → 分隔符
      s = s.replace(/<\/(?:td|th)>/gi, ' | ');
    }

    // 去掉所有剩余标签（含 mc:AlternateContent 等的标签名）
    s = s.replace(/<[^>]*>/g, '');

    // 实体解码
    s = decodeEntities(s);

    // 统一换行、去行尾空白、压缩空行
    s = s.replace(/\r\n?/g, '\n');
    s = condenseBlankLines(s);
    return s.replace(/^\n+/, '').replace(/\n+$/, '');
  }

  /* ------------------------------------------------------------------ *
   * 统计
   * ------------------------------------------------------------------ */

  function computeStats(text, source, xml) {
    var trimmed = String(text == null ? '' : text).trim();
    var paragraphs = 0;
    if (trimmed !== '') {
      var lines = trimmed.split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].replace(/[\s\u00a0]+/g, '') !== '') paragraphs++;
      }
    }
    var tables = 0;
    if (xml) {
      var m = String(xml).match(/<w:tbl[ >]/g);
      tables = m ? m.length : 0;
    }
    return {
      paragraphs: paragraphs,
      chars: String(text == null ? '' : text).length,
      tables: tables,
      source: source
    };
  }

  /* ------------------------------------------------------------------ *
   * 主入口
   * ------------------------------------------------------------------ */

  function looksLikeZip(u8) {
    return u8.length >= 4 &&
      u8[0] === 0x50 && u8[1] === 0x4b &&
      (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07) &&
      (u8[3] === 0x04 || u8[3] === 0x06 || u8[3] === 0x08);
  }

  /** 粗略判断解码后的内容是不是二进制乱码（NUL 或大量控制字符） */
  function looksBinary(text) {
    var n = Math.min(text.length, 65536);
    if (n === 0) return false;
    var bad = 0;
    for (var i = 0; i < n; i++) {
      var c = text.charCodeAt(i);
      if (c === 0) return true;                                  // NUL 字节：一定是二进制
      if (c < 32 && c !== 9 && c !== 10 && c !== 13) bad++;
      else if (c === 0xfffd) bad++;                              // UTF-8 替换字符
    }
    return bad / n > 0.05;
  }

  async function extractDocxBuffer(arrayBuffer, filename) {
    try {
      // 支持 Blob / File（浏览器里便捷路径）
      if (arrayBuffer && typeof arrayBuffer.arrayBuffer === 'function' &&
          typeof arrayBuffer.size === 'number') {
        arrayBuffer = await arrayBuffer.arrayBuffer();
      }

      if (arrayBuffer == null) {
        return { ok: false, text: '', error: '没有拿到文件数据（输入为空）', stats: null };
      }
      if (typeof arrayBuffer === 'string') {
        return { ok: false, text: '', error: '输入类型错误：需要 ArrayBuffer，而不是字符串', stats: null };
      }

      var u8 = toUint8Array(arrayBuffer);
      if (u8.length === 0) {
        return { ok: false, text: '', error: '文件内容为空（0 字节）', stats: null };
      }

      var source = sourceFromFilename(filename);
      var isZip = looksLikeZip(u8);

      // ---- 非 ZIP：先看是不是 HTML 存成的「.doc / .htm」----
      // Word「另存为网页」得到的就是这种文件（后缀 .doc，内容其实是 HTML）。
      if (!isZip) {
        var sniff = '';
        for (var si = 0; si < Math.min(u8.length, 4096); si++) sniff += String.fromCharCode(u8[si]);
        if (/<html[\s>]|<!doctype\s+html|<meta[^>]+charset|<meta[^>]+content-type|<body[\s>]/i.test(sniff)) {
          var cs = (sniff.match(/charset\s*=\s*["']?\s*([\w-]+)/i) || [])[1] || 'utf-8';
          cs = cs.toLowerCase();
          if (cs === 'gb2312' || cs === 'gbk') cs = 'gb18030';   // 超集，更稳
          var htmlText;
          try {
            htmlText = new TextDecoder(cs).decode(u8);
          } catch (eCs) {
            htmlText = utf8Decode(u8);
          }
          htmlText = stripBOM(htmlText).replace(/<head\b[\s\S]*?<\/head\s*>/gi, '');
          var ht = xmlToText(htmlText, true);
          if (ht && ht.replace(/[\s\u00a0]+/g, '') !== '') {
            return { ok: true, text: ht, error: '', stats: computeStats(ht, 'html', null) };
          }
        }
      }

      // ---- 非 ZIP：按纯文本（UTF-8）处理 ----
      if (!isZip) {
        if (source === 'docx') {
          // 后缀说是 docx 但没有 ZIP 头：先按文本兜底，但如果明显是二进制就报错
          var asText = stripBOM(utf8Decode(u8));
          if (asText.replace(/[\s\u00a0]+/g, '') === '') {
            return { ok: false, text: '', error: '文件不是有效的 docx（缺少 ZIP 头），且内容为空', stats: null };
          }
          if (looksBinary(asText)) {
            return { ok: false, text: '', error: ERR_NOT_ZIP_BUT_BINARY, stats: null };
          }
          return {
            ok: true,
            text: asText,
            error: '',
            stats: computeStats(asText, 'docx', null)
          };
        }
        var plain = stripBOM(utf8Decode(u8));
        return {
          ok: true,
          text: plain,
          error: '',
          stats: computeStats(plain, source, null)
        };
      }

      // ---- ZIP：解析中央目录，找 word/document.xml ----
      if (!hasDecompressionStream()) {
        // 只有全部条目都是 method 0 时才可能不需要解压，但 Word 生成的必然是 method 8
        return { ok: false, text: '', error: ERR_UNSUPPORTED_DEFLATE, stats: null };
      }

      var u8view = u8;
      var dv = new DataView(u8view.buffer, u8view.byteOffset, u8view.byteLength);
      var cd = parseCentralDirectory(u8view);

      var entry = findDocumentEntry(cd.entries);
      if (!entry) {
        var names = cd.entries.slice(0, 12).map(function (e) { return e.name; }).join(', ');
        return {
          ok: false,
          text: '',
          error: '这是 ZIP 文件，但里面找不到 word/document.xml（不是 docx？条目示例：' +
            names + (cd.entries.length > 12 ? ' …' : '') + '）',
          stats: null
        };
      }

      var xmlBytes = await readEntryData(u8view, dv, entry);
      var xml = utf8Decode(xmlBytes);
      var text = xmlToText(xml);
      var isDocxSource = source === 'docx';
      var stats = computeStats(text, isDocxSource ? 'docx' : source, xml);

      if (text.replace(/[\s\u00a0]+/g, '') === '') {
        return { ok: false, text: '', error: 'docx 解析成功，但正文为空（' + entry.name + '）', stats: stats };
      }

      return { ok: true, text: text, error: '', stats: stats };
    } catch (err) {
      return { ok: false, text: '', error: describeError(err), stats: null };
    }
  }

  /** 把任意异常变成「永远非空、可读」的中文错误信息 */
  function describeError(err) {
    var name = (err && err.name) ? String(err.name) : '';
    var msg = '';

    if (typeof err === 'string') {
      msg = err;
      name = '';
    } else if (err && typeof err.message === 'string' && err.message) {
      msg = err.message;
    } else if (err != null) {
      try { msg = String(err); } catch (e) { msg = ''; }
      if (msg === '[object Object]' || msg === 'TypeError' || msg === 'Error') msg = '';
    }

    // 已经是本模块生成的、可读的中文信息：原样返回，避免二次包装
    if (/^(解压失败|当前浏览器不支持解压|文件不是有效|不是有效的 ZIP|ZIP |不支持的 ZIP|这是 ZIP)/.test(msg)) {
      return msg;
    }
    if (/Unsupported|not supported|deflate-raw.*(support|compress)/i.test(msg) && !hasDecompressionStream()) {
      return ERR_UNSUPPORTED_DEFLATE;
    }
    if (msg && /deflate|inflate|decompress|incorrect header|unexpected end|invalid/i.test(msg)) {
      return ERR_DEFLATE_FAILED + '（' + msg + '）';
    }
    if (msg) {
      return name && name !== 'Error' ? (msg + '（' + name + '）') : msg;
    }
    return '解析失败：' +
      (name && name !== 'Error' && name !== 'TypeError' ? name + '，' : '') +
      '文件可能已损坏或被截断，请确认这是有效的 .docx / .txt / .md 文件';
  }

  return {
    extractDocxBuffer: extractDocxBuffer,
    // 便于测试/复用的内部工具（不影响主接口）
    _internal: {
      findEOCD: findEOCD,
      parseCentralDirectory: parseCentralDirectory,
      xmlToText: xmlToText,
      decodeEntities: decodeEntities,
      condenseBlankLines: condenseBlankLines
    }
  };
});
