import type { Browser, CDPSession, Page, Target } from 'puppeteer-core';
import { EHIRE_HOME } from './browser.js';

/**
 * ============================================================================
 * 51job-cli 页面守卫：三段式反检测（注入层 + 网络拦截层）+ 风控熔断
 * ----------------------------------------------------------------------------
 * 移植自 boss-cli 的 boss_page_guards.ts，针对 ehire.51job.com 适配：
 * - 注入脚本（navigator.webdriver / asNative / console 时间差 / History / Location）
 *   站点无关，完全通用，照搬。
 * - 网络拦截 URL 模式：51job 未做过前端逆向，采用「环境变量可配 + 51job 域关键词
 *   默认值」，可用 51job probe 校准后通过环境变量收紧。
 * ============================================================================
 */

/** 设为 true/1 时恢复 console.clear 原始行为（默认对抗：替换为空函数）。 */
function shouldAllowConsoleClear(): boolean {
  return process.env['51JOB_BROWSER_ALLOW_CONSOLE_CLEAR'] === 'true' ||
         process.env['51JOB_BROWSER_ALLOW_CONSOLE_CLEAR'] === '1';
}

/**
 * 主包用 `console.log` / `console.table` 重复打印大对象，比对耗时差判断 DevTools 是否打开。
 * 默认开启对抗：把传入对象参数全部归一化为 `[object Type]` 字符串再交给原生方法。
 * 设为 `true` 可恢复完整 console 形态（保留对象树展开 UX，但会重新被时间差检测命中）。
 */
function shouldAllowVerboseConsole(): boolean {
  return process.env['51JOB_BROWSER_ALLOW_VERBOSE_CONSOLE'] === 'true' ||
         process.env['51JOB_BROWSER_ALLOW_VERBOSE_CONSOLE'] === '1';
}

/**
 * 设为 `true` / `1` 时完全不拦截风险页导航（403 / verify / security-check）：
 * 51job 真的要求人工验证时，让验证页正常渲染，用户手动完成后再跑命令。
 */
function shouldAllowRiskNav(): boolean {
  return process.env['51JOB_BROWSER_ALLOW_RISK_NAV'] === 'true' ||
         process.env['51JOB_BROWSER_ALLOW_RISK_NAV'] === '1';
}

/** 从环境变量读取逗号分隔的 URL pattern 列表（空白则用默认值） */
function parsePatternList(envKey: string, defaults: readonly string[]): string[] {
  const raw = process.env[envKey]?.trim();
  if (!raw) return [...defaults];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 51job 安全/风控脚本：尚未逆向确认具体路径，默认不拦截（避免误伤业务）。
 * 通过 `51JOB_BLOCK_SCRIPT_PATTERNS` 环境变量（逗号分隔 URL pattern）显式启用，
 * 例如：`51JOB_BLOCK_SCRIPT_PATTERNS='*51job.com/*risk-detection*,*51job.com/*safeguard*'`
 */
const BLOCKED_SECURITY_SCRIPT_PATTERNS = parsePatternList('51JOB_BLOCK_SCRIPT_PATTERNS', []).map(
  (urlPattern) => ({ urlPattern, requestStage: 'Request' as const }),
);

/**
 * 51job 埋点/上报信标关键词（T308 收敛）：
 * - 默认只「观察」：命中请求记入页面 DevTools console 后放行（observe 模式），
 *   便于 probe 校准时发现真实埋点路径；
 * - 经 `51JOB_BLOCK_REPORT_PATTERNS`（逗号分隔 URL pattern）显式配置后才 204 吞掉。
 * 不再默认拦截——collect/monitor 等宽泛关键词可能误杀业务接口，被 204 吞掉的
 * 请求让「操作没生效但不报错」，是自动化工具最危险的故障形态。
 */
const REPORT_CANDIDATE_KEYWORDS = ['dap', 'collect', 'tracker', 'monitor'] as const;
/** 观察模式 pattern：默认生效（命中 → 页面 console 记录后放行） */
const REPORT_OBSERVE_PATTERNS = REPORT_CANDIDATE_KEYWORDS.map((k) => ({
  urlPattern: `*51job.com/*${k}*`,
  requestStage: 'Request' as const,
}));
/** 显式配置后真正拦截（204）的 pattern：默认空（与安全脚本拦截同一策略） */
const REPORT_REQUEST_PATTERNS = parsePatternList('51JOB_BLOCK_REPORT_PATTERNS', []).map(
  (urlPattern) => ({ urlPattern, requestStage: 'Request' as const }),
);

/** 51job 验证/风控页关键词：出现在 URL 路径段或 query 参数名时视为风险导航 */
const RISK_NAV_KEYWORDS = ['verify', 'captcha', 'risk', 'security', 'checkcode', 'safeguard', 'blocked'] as const;
const RISK_NAVIGATION_PATTERNS = RISK_NAV_KEYWORDS.map((k) => ({
  urlPattern: `*51job.com/*${k}*`,
  requestStage: 'Request' as const,
}));

const REPORT_REQUEST_RE = new RegExp(
  `51job\\.com/(?:.*/)?(?:${REPORT_CANDIDATE_KEYWORDS.join('|')})(?:/|\\?|$)`,
  'i',
);

const RISK_NAVIGATION_RE = new RegExp(
  `about:blank|/(?:${RISK_NAV_KEYWORDS.join('|')})(?:/|\\.|$)|[?&](?:${RISK_NAV_KEYWORDS.join('|')})=`,
  'i',
);

type RequestHeaders = Record<string, string | undefined>;

type PausedKind = 'report' | 'security_script' | 'risk_navigation';

const PAUSED_LABEL: Record<PausedKind, string> = {
  report: 'report:204',
  security_script: 'block:script',
  risk_navigation: 'block:nav',
};

const POST_DATA_PREVIEW_LIMIT = 200;

function isReportRequestUrl(url: string): boolean {
  return REPORT_REQUEST_RE.test(url);
}

/** 导出供调试/测试与 probe 校准使用 */
export function isRiskNavigationUrl(url: string): boolean {
  return RISK_NAVIGATION_RE.test(url);
}

function classifyPausedRequest(url: string): PausedKind {
  if (REPORT_REQUEST_RE.test(url)) return 'report';
  if (RISK_NAVIGATION_RE.test(url)) return 'risk_navigation';
  // 落到这里的都是命中 BLOCKED_SECURITY_SCRIPT_PATTERNS 的请求；不再做 fallback 判定，
  // 一旦后续新增 patterns 但忘记同步分类正则，调用方能立刻发现而不是被静默归错类。
  return 'security_script';
}

function previewPostData(raw: string | undefined): string {
  if (!raw) return '';
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > POST_DATA_PREVIEW_LIMIT
    ? `${compact.slice(0, POST_DATA_PREVIEW_LIMIT)}…`
    : compact;
}

/**
 * 把一行诊断信息打到 **页面 DevTools Console**（不进 Node stderr / stdout）。
 * 终端输出保持干净；只有用户主动打开 DevTools Console 才能看到。
 */
function logToPageConsole(cdp: CDPSession, message: string): void {
  void cdp
    .send('Runtime.evaluate', {
      expression: `console.info(${JSON.stringify(message)})`,
      awaitPromise: false,
      returnByValue: true,
    })
    .catch(() => {
      /* 页面无可用执行上下文（极早期 / 卸载中）时丢弃此条日志即可 */
    });
}

function readRequestHeader(headers: RequestHeaders, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
}

function buildNoContentResponseHeaders(headers: RequestHeaders) {
  const origin = readRequestHeader(headers, 'origin') ?? 'https://ehire.51job.com';
  const requestedHeaders =
    readRequestHeader(headers, 'access-control-request-headers') ??
    'content-type,x-requested-with,traceid';
  return [
    { name: 'access-control-allow-origin', value: origin },
    { name: 'access-control-allow-credentials', value: 'true' },
    { name: 'access-control-allow-methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
    { name: 'access-control-allow-headers', value: requestedHeaders },
    { name: 'cache-control', value: 'no-store' },
  ];
}

/**
 * 守卫脚本设计要点（照搬 boss-cli 的经验结论）：
 * - 不在 `window` 上挂任何 Symbol/字符串自描述属性，避免成为指纹。
 * - 替换的方法保留 `name`，并通过包装后的 `Function.prototype.toString` 让 `fn.toString()` 返回原生形态。
 * - 改写的 accessor / 方法尽量落在 prototype 上，descriptor 形态对齐原生（`configurable: true`）。
 * - 对 `Location.prototype.href` 的 setter 也加拦截，覆盖 `location.href = ...` 直接赋值场景。
 * - 不再伪造 `navigator.plugins` 与 `window.chrome.*`：现代 Chrome 默认值已经合理，伪造反而会被识破。
 */
const EHIRE_PAGE_GUARD_SCRIPT_TEMPLATE = `(function() {
  'use strict';

  var _Object = Object;
  var _defineProperty = _Object.defineProperty;
  var _getOwnPropertyDescriptor = _Object.getOwnPropertyDescriptor;
  var _Function = Function;
  var _origFunctionToString = _Function.prototype.toString;
  var _String = String;
  var _Map = Map;

  /** 让我们包装的函数对 fn.toString() 返回 "function NAME() { [native code] }"。 */
  var nativeSourceMap = new _Map();
  var fakeToString = function toString() {
    if (this != null) {
      var mapped = nativeSourceMap.get(this);
      if (typeof mapped === 'string') return mapped;
    }
    return _origFunctionToString.call(this);
  };
  nativeSourceMap.set(fakeToString, 'function toString() { [native code] }');
  try {
    _defineProperty(_Function.prototype, 'toString', {
      value: fakeToString,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch (e) {}

  /** 包装替身函数：把它伪装成 "function NAME() { [native code] }"。 */
  var asNative = function(replacement, nativeName) {
    var src = 'function ' + nativeName + '() { [native code] }';
    nativeSourceMap.set(replacement, src);
    try {
      _defineProperty(replacement, 'name', {
        value: nativeName,
        writable: false,
        configurable: true,
        enumerable: false,
      });
    } catch (e) {}
    return replacement;
  };

  /** 替换 prototype 上的方法（保持原 descriptor 形态：默认 configurable+writable）。 */
  var replaceProtoMethod = function(proto, key, replacement) {
    try {
      var desc = _getOwnPropertyDescriptor(proto, key);
      if (!desc) return null;
      if (!desc.configurable) return null;
      _defineProperty(proto, key, {
        value: replacement,
        writable: 'writable' in desc ? !!desc.writable : true,
        configurable: true,
        enumerable: !!desc.enumerable,
      });
      return desc.value;
    } catch (e) {
      return null;
    }
  };

  /** 改写 prototype 上的 accessor：仅替换 getter/setter，保留 configurable/enumerable 形态。 */
  var replaceProtoAccessor = function(proto, key, options) {
    try {
      var desc = _getOwnPropertyDescriptor(proto, key);
      if (!desc || !desc.configurable) return null;
      var nextDesc = {
        configurable: true,
        enumerable: !!desc.enumerable,
      };
      if (options.get || desc.get) nextDesc.get = options.get || desc.get;
      if (options.set || desc.set) nextDesc.set = options.set || desc.set;
      _defineProperty(proto, key, nextDesc);
      return desc;
    } catch (e) {
      return null;
    }
  };

  // ===== navigator.webdriver：在 Navigator.prototype 上覆盖 getter，保持 accessor 形态 =====
  try {
    var navProto = Object.getPrototypeOf(navigator);
    if (navProto) {
      replaceProtoAccessor(navProto, 'webdriver', {
        get: asNative(function() { return false; }, 'get webdriver'),
      });
    }
  } catch (e) {}

  // ===== navigator.languages：仅在为空时回填，使用 prototype getter =====
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      var navProto2 = Object.getPrototypeOf(navigator);
      if (navProto2) {
        var langs = ['zh-CN', 'zh', 'en'];
        replaceProtoAccessor(navProto2, 'languages', {
          get: asNative(function() { return langs; }, 'get languages'),
        });
      }
    }
  } catch (e) {}

  // ===== window.close：改为空函数（保留 native 形态）=====
  try {
    var winProto = Object.getPrototypeOf(window);
    if (winProto) {
      replaceProtoMethod(winProto, 'close', asNative(function close() {}, 'close'));
    }
  } catch (e) {}

  // ===== history.back / forward / go =====
  try {
    var historyProto = Object.getPrototypeOf(history);
    if (historyProto) {
      var origGo = historyProto.go;
      replaceProtoMethod(historyProto, 'back', asNative(function back() {}, 'back'));
      replaceProtoMethod(historyProto, 'forward', asNative(function forward() {}, 'forward'));
      replaceProtoMethod(historyProto, 'go', asNative(function go(n) {
        if (typeof n === 'number' && n < 0) return undefined;
        return origGo.call(this, n);
      }, 'go'));
    }
  } catch (e) {}

  // ===== Location.assign / replace / href setter =====
  var BLOCK_PATH = /(?:^|\\/)(?:verify|captcha|risk|security|checkcode|safeguard|blocked)(?:\\/|\\.|$)|[?&](?:verify|captcha|risk|security|checkcode|safeguard|blocked)=/i;
  var isBlockedTarget = function(value) {
    var s = _String(value);
    if (s === 'about:blank') return true;
    return BLOCK_PATH.test(s);
  };
  try {
    var locProto = Location.prototype;
    var origAssign = locProto.assign;
    var origReplace = locProto.replace;
    replaceProtoMethod(locProto, 'assign', asNative(function assign(url) {
      if (isBlockedTarget(url)) return undefined;
      return origAssign.call(this, url);
    }, 'assign'));
    replaceProtoMethod(locProto, 'replace', asNative(function replace(url) {
      if (isBlockedTarget(url)) return undefined;
      return origReplace.call(this, url);
    }, 'replace'));

    var hrefDesc = _getOwnPropertyDescriptor(locProto, 'href');
    if (hrefDesc && hrefDesc.configurable && hrefDesc.set) {
      var origHrefSet = hrefDesc.set;
      _defineProperty(locProto, 'href', {
        get: hrefDesc.get,
        set: asNative(function(value) {
          if (isBlockedTarget(value)) return undefined;
          return origHrefSet.call(this, value);
        }, 'set href'),
        configurable: true,
        enumerable: !!hrefDesc.enumerable,
      });
    }
  } catch (e) {}

  // ===== console.clear：可选替身，原生形态空函数 =====
  if (!__SHOULD_ALLOW_CONSOLE_CLEAR__) {
    try {
      var consoleProtoForClear = Object.getPrototypeOf(console);
      var ownClearDesc = Object.getOwnPropertyDescriptor(console, 'clear');
      var protoClearDesc = consoleProtoForClear
        ? _getOwnPropertyDescriptor(consoleProtoForClear, 'clear')
        : null;
      var clearSrcDesc = ownClearDesc || protoClearDesc;
      if (clearSrcDesc && typeof clearSrcDesc.value === 'function') {
        try {
          _defineProperty(console, 'clear', {
            value: asNative(function clear() {}, 'clear'),
            writable: 'writable' in clearSrcDesc ? clearSrcDesc.writable !== false : true,
            configurable: true,
            enumerable: !!clearSrcDesc.enumerable,
          });
        } catch (_) {}
      }
    } catch (e) {}
  }

  // ===== console 时间差探测对抗 =====
  // 主包用 \`console.log\` / \`console.table\` 重复打印大对象，比较前后 \`performance.now()\`，
  // DevTools 打开时 V8 inspector 会把对象逐一序列化送去，耗时显著上升即判定 DevTools 打开。
  // 对抗手段：把所有对象参数在我们这层先归一化为 \`[object Type]\` O(1) 字符串再交给原生方法，
  // 耗时不再随 DevTools 状态变化。代价：DevTools 控制台中对象显示为 \`[object Type]\`。
  if (!__SHOULD_ALLOW_VERBOSE_CONSOLE__) {
    try {
      var _objToString = Object.prototype.toString;
      var sanitizeArgs = function(rawArgs) {
        var len = rawArgs.length;
        var out = new Array(len);
        for (var i = 0; i < len; i++) {
          var a = rawArgs[i];
          if (a !== null && typeof a === 'object') {
            try {
              out[i] = _objToString.call(a);
            } catch (_) {
              out[i] = '[object Object]';
            }
          } else if (typeof a === 'function') {
            out[i] = '[Function: ' + (a.name || 'anonymous') + ']';
          } else {
            out[i] = a;
          }
        }
        return out;
      };
      var consoleProtoForLog = Object.getPrototypeOf(console);
      var consoleMethodNames = [
        'log', 'info', 'debug', 'warn', 'error',
        'table', 'dir', 'dirxml', 'trace',
        'group', 'groupCollapsed',
      ];
      for (var ci = 0; ci < consoleMethodNames.length; ci++) {
        (function(method) {
          var ownDesc = Object.getOwnPropertyDescriptor(console, method);
          var protoDesc = consoleProtoForLog
            ? _getOwnPropertyDescriptor(consoleProtoForLog, method)
            : null;
          var srcDesc = ownDesc || protoDesc;
          if (!srcDesc || typeof srcDesc.value !== 'function') return;
          var orig = srcDesc.value;
          var wrapped = asNative(function() {
            return orig.apply(this, sanitizeArgs(arguments));
          }, method);
          try {
            _defineProperty(console, method, {
              value: wrapped,
              writable: 'writable' in srcDesc ? srcDesc.writable !== false : true,
              configurable: true,
              enumerable: !!srcDesc.enumerable,
            });
          } catch (_) {}
        })(consoleMethodNames[ci]);
      }
    } catch (e) {}
  }
})();`;

function buildPageGuardScript(): string {
  return EHIRE_PAGE_GUARD_SCRIPT_TEMPLATE
    .replace('__SHOULD_ALLOW_CONSOLE_CLEAR__', shouldAllowConsoleClear() ? 'true' : 'false')
    .replace('__SHOULD_ALLOW_VERBOSE_CONSOLE__', shouldAllowVerboseConsole() ? 'true' : 'false');
}

const browsersWithTargetGuard = new WeakSet<Browser>();
const pagesWithInitGuard = new WeakSet<Page>();
const pagesWithNavigationGuard = new WeakSet<Page>();
const pagesWithRequestGuard = new WeakSet<Page>();

/**
 * 风控页反弹熔断：51job 判定风控后会反复把主 frame 推向验证/风控页，
 * 而拦截 + 跳回首页会把「一次风控」放大成「无限刷新」。
 * 窗口期内反弹超过阈值即熔断：停止反弹、放行验证页、由命令层报错停下来。
 */
const RISK_BOUNCE_WINDOW_MS = 60_000;
const RISK_BOUNCE_LIMIT = 3;

/** 同一 URL 在窗口期内反复 commit（站点自身 reload 循环，常见于安全脚本被拦后 SPA 自救）。 */
const RELOAD_LOOP_WINDOW_MS = 15_000;
const RELOAD_LOOP_LIMIT = 5;

export type PageRiskKind = 'risk_navigation' | 'reload_loop';

export type PageRiskState = {
  kind: PageRiskKind;
  url: string;
  message: string;
};

const riskStateByPage = new WeakMap<Page, PageRiskState>();
const cdpSessionByPage = new WeakMap<Page, CDPSession>();

/** 当前页是否已熔断（风控页反弹 / 刷新循环）；命令层据此明确报错而不是继续空转。 */
export function getPageRiskState(page: Page): PageRiskState | null {
  return riskStateByPage.get(page) ?? null;
}

/** 用户手动处理完验证后，可清掉熔断状态继续跑。 */
export function clearPageRiskState(page: Page): void {
  riskStateByPage.delete(page);
}

/** 熔断后放开风险页拦截，让 verify / security-check 正常渲染，用户才能手动过验证。 */
async function relaxRiskNavigationBlocking(page: Page): Promise<void> {
  const cdp = cdpSessionByPage.get(page);
  if (!cdp) return;
  await cdp
    .send('Fetch.enable', {
      patterns: [...BLOCKED_SECURITY_SCRIPT_PATTERNS, ...REPORT_REQUEST_PATTERNS],
    })
    .catch(() => {
      /* 页面/会话已销毁时忽略：熔断状态本身已足够让命令层停下 */
    });
}

function tripPageRisk(page: Page, state: PageRiskState): void {
  if (riskStateByPage.has(page)) return;
  riskStateByPage.set(page, state);
  console.error(`[51job-cli] ${state.message}`);
}

async function ensurePageInitGuard(page: Page): Promise<void> {
  if (pagesWithInitGuard.has(page)) return;
  const script = buildPageGuardScript();
  // puppeteer 的 evaluateOnNewDocument：同步注册到主 frame CDP session，
  // 并在 OOPIF/iframe target 通过 onAttachedToTarget attach 时再次 addScript，
  // 覆盖隐藏 iframe 反检测对照场景。
  await page.evaluateOnNewDocument(script);
  // 当前文档已在加载中或已加载完成时，evaluateOnNewDocument 不会回溯执行；
  // 对当前主 frame 直接注入一次，让幂等的 try/catch 守卫立即生效。
  await page.evaluate(script).catch(() => {
    /* 当前文档可能还没创建执行上下文，由后续 navigation 触发 evaluateOnNewDocument 即可 */
  });
  pagesWithInitGuard.add(page);
}

function ensurePageNavigationGuard(page: Page): void {
  if (pagesWithNavigationGuard.has(page)) return;

  const bounceAt: number[] = [];
  const commitAt = new Map<string, number[]>();
  // T306：反弹导航串行化——fire-and-forget 的并发 goto 顺序未定义（恢复跳转与
  // 验证页放行互相踩），上一次守卫导航未完成时丢弃新触发并记日志。
  let navBusy = false;
  const guardNavigate = (url: string, purpose: string, logFailure: boolean): void => {
    if (navBusy) {
      console.error(`[51job-cli] 上一次守卫导航未完成，丢弃${purpose}导航: ${url}`);
      return;
    }
    navBusy = true;
    void page
      .goto(url, { waitUntil: 'load', timeout: 60_000 })
      .catch(() => {
        if (logFailure) console.error(`[51job-cli] 守卫导航失败：${purpose} ${url}`);
      })
      .finally(() => {
        navBusy = false;
      });
  };

  const withinWindow = (stamps: number[], now: number, windowMs: number): number[] => {
    const kept = stamps.filter((t) => now - t <= windowMs);
    stamps.length = 0;
    stamps.push(...kept);
    return stamps;
  };

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    const now = Date.now();

    if (!isRiskNavigationUrl(url)) {
      // 非风险页也可能陷入循环：安全脚本被拦后 51job SPA 会自己反复 reload。
      const stamps = commitAt.get(url) ?? [];
      stamps.push(now);
      commitAt.set(url, withinWindow(stamps, now, RELOAD_LOOP_WINDOW_MS));
      if (stamps.length >= RELOAD_LOOP_LIMIT) {
        tripPageRisk(page, {
          kind: 'reload_loop',
          url,
          message: `页面在 ${RELOAD_LOOP_WINDOW_MS / 1000}s 内重复加载 ${stamps.length} 次（${url}），疑似 51job 侧风控或安全脚本被拦导致自刷新。已停止自动干预，请在浏览器中确认页面状态。`,
        });
      }
      return;
    }

    if (riskStateByPage.has(page) || shouldAllowRiskNav()) return;

    bounceAt.push(now);
    withinWindow(bounceAt, now, RISK_BOUNCE_WINDOW_MS);
    if (bounceAt.length > RISK_BOUNCE_LIMIT) {
      tripPageRisk(page, {
        kind: 'risk_navigation',
        url,
        message: `检测到 51job 反复跳转风控/验证页（${url}），${RISK_BOUNCE_WINDOW_MS / 1000}s 内已 ${bounceAt.length} 次。已停止跳回首页并放行该页面：请在浏览器中完成验证/登录后重试；继续自动操作可能触发封号。`,
      });
      void relaxRiskNavigationBlocking(page).then(() => {
        // 验证页本身加载失败不再重试，熔断状态已让命令层停下
        guardNavigate(url, '验证页放行', false);
      });
      return;
    }

    guardNavigate(EHIRE_HOME, '风险页恢复', true);
  });
  pagesWithNavigationGuard.add(page);
}

async function ensurePageRequestGuard(page: Page): Promise<void> {
  if (pagesWithRequestGuard.has(page)) return;
  const cdp = await page.createCDPSession();
  cdpSessionByPage.set(page, cdp);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Fetch.enable', {
    patterns: [
      ...BLOCKED_SECURITY_SCRIPT_PATTERNS,
      ...REPORT_REQUEST_PATTERNS,
      ...REPORT_OBSERVE_PATTERNS,
      ...(shouldAllowRiskNav() ? [] : RISK_NAVIGATION_PATTERNS),
    ],
  });
  cdp.on('Fetch.requestPaused', (params) => {
    const url = params.request.url;
    const method = params.request.method;

    // 风控关键词拦截只针对文档导航（真正的验证页跳转）。
    // 实测（2026-08-25）：Hi聊 IM 发消息前会调用
    // cupid.51job.com/imbc/open/common/risk/associate_ai 风控预检 API（XHR），
    // URL 含 "risk" 命中拦截模式；误杀会导致消息永远发不出去。
    // 非文档请求命中 risk 关键词时一律放行。
    if (params.resourceType !== 'Document' && RISK_NAVIGATION_RE.test(url)) {
      void cdp
        .send('Fetch.continueRequest', { requestId: params.requestId })
        .catch(() => {
          /* 会话销毁时忽略 */
        });
      return;
    }

    const kind = classifyPausedRequest(url);
    const label = PAUSED_LABEL[kind];

    // 命中即记录到 **页面 DevTools Console**（不污染终端输出）。
    if (kind === 'report') {
      const body = previewPostData(params.request.postData);
      logToPageConsole(
        cdp,
        body
          ? `[51job-cli][${label}] ${method} ${url} body=${body}`
          : `[51job-cli][${label}] ${method} ${url}`,
      );
      // T308：默认观察模式（未配置 51JOB_BLOCK_REPORT_PATTERNS）→ 记录后放行；
      // 显式配置后才 204 吞掉
      if (REPORT_REQUEST_PATTERNS.length > 0) {
        void cdp
          .send('Fetch.fulfillRequest', {
            requestId: params.requestId,
            responseCode: 204,
            responsePhrase: 'No Content',
            responseHeaders: buildNoContentResponseHeaders(params.request.headers),
          })
          .catch(() => {
            console.error(`[51job-cli] 日志上报请求拦截响应失败：${url}`);
          });
      } else {
        void cdp
          .send('Fetch.continueRequest', { requestId: params.requestId })
          .catch(() => {
            /* 会话销毁时忽略 */
          });
      }
      return;
    }

    logToPageConsole(cdp, `[51job-cli][${label}] ${method} ${url}`);
    void cdp
      .send('Fetch.failRequest', {
        requestId: params.requestId,
        errorReason: 'BlockedByClient',
      })
      .catch(() => {
        console.error(`[51job-cli] 风险请求阻断失败：${url}`);
      });
  });
  pagesWithRequestGuard.add(page);
}

/**
 * 上一条命令（另一个进程）已经把页面留在验证/风控页时，直接熔断：
 * 这种状态下再跳回首页只会重复被弹走，不如立刻让调用方报错。
 * `about:blank` 属于新标签的正常初始态，不计入。
 */
function tripIfAlreadyOnRiskPage(page: Page): void {
  if (shouldAllowRiskNav()) return;
  let url = '';
  try {
    url = page.url();
  } catch {
    return;
  }
  if (!url || url === 'about:blank' || !isRiskNavigationUrl(url)) return;
  tripPageRisk(page, {
    kind: 'risk_navigation',
    url,
    message: `当前页面停留在 51job 验证/风控页（${url}）。已停止自动操作：请在浏览器中完成验证或重新登录后重试。`,
  });
}

export async function installPageGuards(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await ensurePageInitGuard(page);
  ensurePageNavigationGuard(page);
  await ensurePageRequestGuard(page);
  tripIfAlreadyOnRiskPage(page);
}

async function installTargetPageGuards(target: Target): Promise<void> {
  if (target.type() !== 'page') return;
  const page = await target.page();
  if (!page || page.isClosed()) return;
  await installPageGuards(page);
}

/** 给浏览器实例挂 targetcreated 全局守卫：任何新开的标签页自动获得守卫。 */
export async function installBrowserPageGuards(browser: Browser): Promise<void> {
  if (!browsersWithTargetGuard.has(browser)) {
    browser.on('targetcreated', (target) => {
      void installTargetPageGuards(target).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[51job-cli] 新页面防护安装失败：${msg}`);
      });
    });
    browsersWithTargetGuard.add(browser);
  }

  const pages = (await browser.pages()).filter((p) => !p.isClosed());
  for (const page of pages) {
    await installPageGuards(page);
  }
}
