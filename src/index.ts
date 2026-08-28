#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { Command } from 'commander';
import { shutdownBrowser, findChrome, ensureHeadfulForLogin } from './core/browser';
import { withSessionPage, detachBrowserSession, getBrowserRef, trackExtraPage } from './core/sessionPage';
import { selectors } from './pages/selectors';
import { delay } from './core/throttle';
import { assertJobCliAvailable, JobAvailabilityError } from './core/availability';
import { createThrottle, parseThrottleEnv } from './core/throttle';
import { setFormat, getFormat, printTable, printJson, out, err, warn, fail, FatalCliError } from './utils/output';
import { openLoginPage, waitForLogin } from './pages/login';
import { readInbox, candidatesToRows } from './pages/inbox';
import { openChat, sendMessage, chatAction, previewResume } from './pages/chat';
import { searchTalents, readSearchResults, searchToRows, greetTalent, SearchFilters } from './pages/search';
import { navToRecommend, switchRecommendJob, readRecommendResults, greetRecommend, recommendToRows } from './pages/recommend';
import { hiOutcomeTag, HiOutcome } from './pages/hi-result';
import { detailToSummary, openDetailByIndex, openDetailByResumeId, hiChatOnDetail } from './pages/candidate-detail';
import { openTalentMgmtDetail, replyOnDetail, openCardDetail } from './pages/talent-insight';
import { readPositions, jobsToRows, fetchJd, readPositionCandidates, resolvePositionCard, detailToSearchFilters, mergeSearchFilters, type JobScope, type JobSource } from './pages/job';
import { probePage, printProbe } from './pages/probe';
import { ensureDirs, root as storeRoot } from './utils/store';
import { collectExpiredFiles } from './utils/clean';
import { version } from '../package.json';

// 环境变量加载（T205 收敛）：默认只读 ~/.51job-cli/.env（用户级持久配置）+ 系统环境变量。
// 项目级 ./.env 需显式开启（51JOB_PROJECT_ENV=1）——全局安装的 CLI 在任意目录执行时，
// 自动读取该目录 .env 存在注入风险（CHROME_PATH → spawn 任意可执行、OCR 密钥重定向、
// 关闭风控拦截等）。两者都不会覆盖已存在的系统环境变量（dotenv 默认行为）。
const userEnvPath = join(homedir(), '.51job-cli', '.env');
if (existsSync(userEnvPath)) loadEnv({ path: userEnvPath, quiet: true });
if (process.env['51JOB_PROJECT_ENV'] === '1' || process.env['51JOB_PROJECT_ENV'] === 'true') {
  const projectEnvPath = join(process.cwd(), '.env');
  if (existsSync(projectEnvPath)) {
    loadEnv({ path: projectEnvPath, quiet: true });
    err(`[info] 已加载项目级配置: ${projectEnvPath}`);
  }
}

const program = new Command();

/** 13 维筛选选项描述（search/greet 共享），返回各键对应的 opts 字段名 */
function addSearchFilterOptions(cmd: Command): void {
  cmd
    .option('--exp <值>', '工作年限: 不限|无经验|1-3年|3-5年|5-10年|10年及以上')
    .option('--age <值>', '年龄: 不限|22岁及以下|22-25岁|25-30岁|30-35岁|35-45岁|45岁及以上')
    .option('--gender <值>', '性别: 男|女')
    .option('--city <值>', '期望工作地（逗号分隔，如 广州,深圳）')
    .option('--residence <值>', '居住地（逗号分隔 省,市,区，如 广东省,广州市,天河区）')
    .option('--edu <值>', '学历要求: 不限|大专及以上|本科及以上|硕士及以上|博士')
    .option('--school <值>', '学校性质（逗号分隔多选）: 全日制|985|211|双一流|留学经历|在校生')
    .option('--status <值>', '求职状态: 离职-周内到岗|在职-月内到岗|在职-观望机会')
    .option('--industry <值>', '期望行业（逗号分隔多选）')
    .option('--func <值>', '期望职能（逗号分隔多选）')
    .option('--salary <值>', '期望月薪档位（页面枚举文本，如 8千|2万以上）')
    .option('--work-industry <值>', '从事行业（逗号分隔多选）')
    .option('--work-func <值>', '从事职能（逗号分隔多选）');
}

/** 从 commander opts 组装 SearchFilters（search/greet 共享） */
function filtersFromOpts(opts: Record<string, string | undefined>): SearchFilters {
  return {
    exp: opts.exp,
    age: opts.age,
    gender: opts.gender,
    city: opts.city,
    residence: opts.residence,
    edu: opts.edu,
    school: opts.school,
    status: opts.status,
    industry: opts.industry,
    func: opts.func,
    salary: opts.salary,
    workIndustry: opts.workIndustry,
    workFunc: opts.workFunc,
  };
}

program
  .name('51job')
  .description('前程无忧(51job)企业招聘端自动化 CLI：候选人管理、Hi聊、人才搜索、职位管理。\n供 AI Agent / 脚本编排：每个子命令独立可组合，退出码 0=成功 1=业务失败 2=可用性禁用；\n--json 单文档结构化输出；驱动本机 Chrome，登录态持久化，自带反检测与风控熔断。')
  .version(version);

/**
 * 统一命令入口：可用性校验 → 会话锁 → 浏览器复用 → 选页 → 守卫安装 → 熔断检查 → 回调。
 * 命令结束后断开连接（浏览器进程与登录态保留），供下一条命令复用。
 */
async function runCommand(callback: (page: import('puppeteer-core').Page) => Promise<void>): Promise<void> {
  // 线上前端基线校验（结果缓存 6h）：51job 改前端时选择器/守卫可能失效，宁可禁用不可盲跑
  try {
    await assertJobCliAvailable();
  } catch (e) {
    if (e instanceof JobAvailabilityError) {
      fail(e.message, 2);
    }
    throw e;
  }
  try {
    await withSessionPage(callback);
  } finally {
    await detachBrowserSession();
  }
}

program
  .command('login')
  .description('打开 51job eHire 登录页（有头模式）后立即同步返回，不等待登录结果。\n登录完成与否由后续 wait-login 或首个业务命令自行检测。\n用法：先生成浏览器登录态，再进行其它操作。')
  .action(async () => {
    // 登录分离模式（对齐 boss-cli login 语义）：只开页、立即断开返回，
    // 不 sleep / 不 poll / 不校验登录结果——成功与否由后续命令自行体现。
    // login 必须可见：先确保常驻浏览器以有头模式运行（无头则关闭重启）。
    await ensureHeadfulForLogin();
    try {
      await withSessionPage(
        async (page) => {
          await openLoginPage(page);
        },
        { ensureEhireUrl: false },
      );
    } finally {
      await detachBrowserSession();
    }
    out('login 已同步返回，不等待登录结果。完成扫码/验证后运行 wait-login，或直接执行业务命令。');
  });

program
  .command('wait-login')
  .description('轮询等待登录完成（配合 login。超时非零退出，用于区分成功了/没成功：\n0=已登录 1=超时。默认 300s。')
  .option('--timeout <秒>', '等待登录超时秒数', '300')
  .action(async (opts) => {
    // 参数校验（T104）：非法值（abc → NaN、0、负数）会让轮询循环立即超时假结束，
    // 在进入浏览器会话前直接报错。
    const sec = parseInt(opts.timeout, 10);
    if (!Number.isFinite(sec) || sec <= 0) {
      fail(`--timeout 需为正整数秒，收到: "${opts.timeout}"（示例: 51job wait-login --timeout 300）`);
    }
    await runCommand(async (page) => {
      // 退出码契约（T104）：超时非零退出，编排层据此区分「登录成功」与「等待超时」
      const r = await waitForLogin(page, { timeoutSec: sec });
      if (!r.ok) {
        fail(`等待登录超时（${sec}s）。请在浏览器中完成登录后重试 wait-login，或直接运行业务命令检测登录态。`);
      }
    });
  });

program
  .command('list')
  .description('读取工作台【投递箱】候选人列表（全部职位聚合流，不区分职位）。\n返回每人 index/姓名/投递时间/画像/是否未读；序号与 chat --index 一一对应。\n按职位筛选投递候选人请用 positions --candidates（不是本命令）。\n--json 输出结构数组 [{index,name,time,profile,unread}]。')
  .option('--unread', '仅未读')
  .option('--json', 'JSON 输出')
  .action(async (opts) => {
    if (opts.json) setFormat('json');
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      const candidates = await readInbox(page, { unreadOnly: opts.unread, throttle });
      if (getFormat() === 'json') {
        printJson(candidates);
      } else {
        printTable(candidatesToRows(candidates));
        out(`共 ${candidates.length} 位候选人`);
      }
    });
  });

program
  .command('chat')
  .description('打开指定候选人的聊天会话（定位方式：姓名或 --index，序号与 list 输出 # 列一致）。\n供后续 send / action 命令使用。不发送任何消息。')
  .argument('[姓名]', '候选人姓名（优先用 --index 精确定位）')
  .option('--index <序号>', '列表序号（与 list 输出的 # 列一致）')
  .option('--unread', '使用未读列表序号（与 list --unread 输出一致）')
  .option('--strict', '精确匹配姓名')
  .action(async (name, opts) => {
    const throttle = createThrottle(parseThrottleEnv());
    // T110：序号参数校验——非法值/0 报错，不产生 NaN 传播
    let index: number | undefined;
    if (opts.index !== undefined) {
      index = parseInt(opts.index, 10);
      if (!Number.isFinite(index) || index <= 0) {
        fail(`--index 需为正整数序号（1-based），收到: "${opts.index}"`);
      }
    }
    await runCommand(async (page) => {
      const opened = await openChat(page, {
        name: name || undefined,
        // T105：--unread 真正生效；序号非法值已在上方校验
        index,
        unreadOnly: opts.unread,
        strict: opts.strict,
        throttle,
      });
      if (!opened) fail('未能打开会话');
    });
  });

program
  .command('send')
  .description('向【当前已打开】的聊天会话发送一条文本消息（须先运行 chat 打开目标会话）。\n含防重防抖：一次只发送一遍，不自动重试。发送人即当前登录账号。')
  .option('--text <内容>', '消息内容')
  .action(async (opts) => {
    if (!opts.text) fail('请用 --text 提供消息内容');
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      const ok = await sendMessage(page, opts.text, { throttle });
      if (!ok) fail('消息发送失败');
    });
  });

program
  .command('action')
  .description('对【当前已打开】的聊天会话执行业务动作（须先运行 chat）。\n可操作为：resume(索要简历) / unsuitable(标记不合适) / note(备注) / wechat(换微信) / phone(换电话) / interview(约面试)。\n写操作默认需人机确认；--no-confirm 跳过（谨慎）。')
  .argument('<操作>')
  .option('--no-confirm', '跳过不可逆动作确认（谨慎）')
  .action(async (action, opts) => {
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      const ok = await chatAction(page, action, { throttle, confirm: opts.confirm });
      if (!ok) fail(`操作失败: ${action}`);
    });
  });

const searchCmd = program
  .command('search')
  .description(
    '人才搜索：关键词 + 多维筛选（自动导航到人才搜索页，设置筛选后搜索并读结果列表）。\n' +
      '支持十三维筛选参数（--exp/--age/--gender/--city/--residence/--edu/--school/--status/--industry/--func/--salary/--work-industry/--work-func）。\n' +
      '定位方式二选一（互斥）：<关键词> 或 --position <职位名>。--position 自动导航职位管理页读职位卡，\n' +
      '注入该职位的期望工作地/学历筛选并锁定搜索范围——零城市参数即可收敛（显式 --city 等参数覆盖注入值）。\n' +
      '返回候选人画像列表（期望职位/公司/年龄/经验/学历/薪资等）。\n' +
      'greet / inspect 也复用本搜索池。默认只读首屏 ~30 人；--all 边慢滚边收集全量（分钟级）。',
  )
  .argument('[关键词]', '搜索关键词（职位名/技能词/人名）；与 --position 二选一')
  .option('--position <职位名>', '按职位搜索：锁定范围为该职位并自动注入其城市/学历筛选（与关键词互斥）')
  .option('--scope <my|org>', '职位视图（--position 时生效）: my=我的职位(默认), org=组织下职位')
  .option('--all', '滚动收集全量候选人（⚠️ 易触发风控，非必要不使用；默认只读首屏 ~30 人即可）')
  .option('--json', 'JSON 输出（keyword/count/hits；--position 时含注入元数据）');
addSearchFilterOptions(searchCmd);
searchCmd.action(async (keyword, opts) => {
  if (opts.json) setFormat('json');
  // T112 grilling 决议：<关键词> 与 --position 互斥，同传即调用方语义不清 → fail
  if (keyword !== undefined && opts.position !== undefined) {
    fail(`关键词「${keyword}」与 --position 「${opts.position}」互斥，请二选一`);
  }
  let scope: JobScope | undefined;
  if (opts.scope !== undefined) {
    const s = String(opts.scope).toLowerCase();
    if (s !== 'my' && s !== 'org') fail(`--scope 只能为 my 或 org，收到: "${opts.scope}"`);
    scope = s as JobScope;
  }
  const kw = (opts.position ?? keyword ?? '').trim();
  if (!kw) fail('缺少搜索内容：请提供 <关键词> 或 --position <职位名>');
  const throttle = createThrottle(parseThrottleEnv());
  await runCommand(async (page) => {
    // ---- --position 注入链路（grilling 决议）----
    let injected: SearchFilters | null = null;
    // 显式职位（--position）时：职位卡已找到 → tag 必须锁定，匹配不到视为异常保留（不清池）
    let fallbackToUnlimited = true;
    if (opts.position) {
      const detail = await resolvePositionCard(page, String(opts.position), { throttle, scope });
      if (detail !== null) {
        injected = detailToSearchFilters(detail);
        const note = [
          injected.city && `期望工作地=${injected.city}`,
          injected.edu && `学历≥${injected.edu.replace('及以上', '')}`,
        ].filter(Boolean).join('、');
        if (note) out(`职位「${opts.position}」自动注入：${note}`);
        else out(`职位「${opts.position}」已定位，无可用筛选注入`);
        fallbackToUnlimited = false;
      } else {
        // Q8a：职位卡未找到 → 回退「不限职位」，但城市收敛必须是显式的，否则拒绝裸奔全池
        if (!opts.city && !opts.residence) {
          fail(`职位「${opts.position}」未在职位列表中找到，且未指定 --city/--residence，拒绝无收敛搜索（可加显式城市后重试）`);
        }
        out(`职位「${opts.position}」未在职位列表中找到，按「不限职位」+ 显式城市搜索`);
      }
    }
    // 显式筛选参数覆盖注入值（Q11a 决议：显式 > 注入；未传字段保留注入值）
    const merged = mergeSearchFilters(injected, filtersFromOpts(opts));

    const scopeResult = await searchTalents(page, kw, {
      throttle,
      filters: merged,
      position: opts.position,
      fallbackToUnlimited,
    });
    const hits = await readSearchResults(page, { throttle, all: !!opts.all });
    // T112 grilling 决议（用户拍板）：--json 统一对象化（与 positions --candidates 同构），
    // 注入/回退状态可观测——AI 编排从数组改读 .hits
    if (getFormat() === 'json') {
      printJson({
        keyword: kw,
        ...(opts.position
          ? {
              position: String(opts.position),
              positionScope: scope ?? 'my',
              injected:
                injected && (injected.city || injected.edu) ? { ...injected } : null,
              fallback: scopeResult === 'unlimited' ? 'unlimited' : null,
            }
          : {}),
        count: hits.length,
        hits,
      });
    } else {
      if (scopeResult === 'unlimited') out('搜索范围：不限职位（全池）');
      printTable(searchToRows(hits));
      out(`共 ${hits.length} 条结果`);
    }
  });
});

program
  .command('recommend')
  .description('读取人才望远镜推荐候选人列表（按岗位聚合的系统推荐池，不耗 Hi 点数）。\n可选 --greet 直接对推荐候选人打招呼、--inspect 打开简历详情提取；\n不耗时默认输出列表。')
  .argument('[岗位]', '推荐岗位关键字（可选，匹配左侧岗位菜单）')
  .option('--greet <姓名或序号>', '对推荐列表中的候选人打招呼（姓名或序号）')
  .option('--inspect <姓名或序号>', '打开推荐候选人的简历详情页并提取结构化 JSON（先看再 Hi）')
  .option('--json', 'JSON 输出')
  .action(async (job, opts) => {
    if (opts.json) setFormat('json');
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      await navToRecommend(page, { throttle });
      if (opts.inspect) {
        // 详情模式：按姓名或序号定位推荐卡 → 开详情 tab → 提取
        const bid = await getBrowserRef();
        if (!bid) { fail('浏览器未就绪'); return; }
        // 先读列表定位序号
        const hits = await readRecommendResults(page, { throttle });
        let idx = -1;
        const asNum = parseInt(opts.inspect, 10);
        if (!Number.isNaN(asNum)) {
          idx = asNum;
        } else {
          for (let i = 0; i < hits.length; i++) {
            if (hits[i].name.includes(opts.inspect)) { idx = i + 1; break; }
          }
        }
        if (idx < 1 || idx > hits.length) {
          fail(`未在推荐列表定位到「${opts.inspect}」（共 ${hits.length} 条）`);
          return;
        }
        // T107：把定位时的姓名传给详情打开器做交叉校验，防止「读列表定位」与
        // 「重新取卡片」两步之间列表重排导致打开错误候选人
        const opened = await openCardDetail(bid, page, idx, selectors.recommend.resultItem, {
          throttle,
          verifyName: hits[idx - 1]?.name,
        });
        if (!opened) { fail('详情打开失败'); return; }
        // 风控熔断：命中「简历查看受限」→ 输出限制说明 JSON，非零退出（编排层据此停手）
        if ('viewLimited' in opened && opened.viewLimited) {
          if (getFormat() === 'json') {
            printJson({
              status: 'view_limit',
              target: opts.inspect,
              recommendIndex: idx,
              recommendName: hits[idx - 1]?.name,
              forJob: hits[idx - 1]?.forJob,
              message: opened.viewLimited.summary,
              dialogText: opened.viewLimited.dialogText,
              error: `简历详情查看受限（${opened.viewLimited.summary}），已熔断停手不重试`,
            });
          }
          fail(`简历详情查看受限（${opened.viewLimited.summary}），已熔断停手不重试`);
          return;
        }
        trackExtraPage(opened.page!);
        const d = opened.detail!;
        // T107：详情缺姓名 = 提取不完整，视为失败（输出 {} + 退出 0 会误导编排层）
        if (!d.name) fail('详情提取结果缺少姓名（可能详情未渲染完整），请重试或人工核对');
        if (getFormat() === 'json') {
          printJson({ ...d, recommendIndex: idx, recommendName: hits[idx - 1]?.name, forJob: hits[idx - 1]?.forJob });
        } else {
          out(detailToSummary(d));
        }
        return;
      }
      if (opts.greet) {
        // 打招呼模式：定位 → 列表内 Hi → 校验真实结果
        // 退出码契约（T102）：success → 0；quota_exhausted/failed/unknown → 1（JSON 模式同样非零）
        const outcome = await greetRecommend(page, opts.greet, { throttle });
        if (outcome === 'quota_exhausted') {
          // 额度不足：JSON 也输出结果，但必须非零退出（AI 编排依赖退出码判断「该停」）
          if (getFormat() === 'json') {
            printJson({ hiResult: hiOutcomeTag(outcome), target: opts.greet, error: 'Hi聊点数不足' });
          }
          fail('Hi聊点数不足：本次未发出，请分配额度后再跑（已自动关闭弹窗，不重试）');
        }
        if (getFormat() === 'json') {
          printJson({
            hiResult: hiOutcomeTag(outcome),
            target: opts.greet,
            ...(outcome !== 'success' ? { error: `打招呼未确认成功（${hiOutcomeTag(outcome)}）` } : {}),
          });
          if (outcome !== 'success') {
            fail(`打招呼未确认成功（${hiOutcomeTag(outcome)}）: ${opts.greet}`);
          }
        } else if (outcome === 'success') {
          out(`已对「${opts.greet}」打招呼成功`);
        } else {
          fail(`打招呼未确认成功（${hiOutcomeTag(outcome)}）: ${opts.greet}`);
        }
        return;
      }
      if (job) await switchRecommendJob(page, job, { throttle });
      const hits = await readRecommendResults(page, { throttle });
      if (getFormat() === 'json') {
        printJson(hits);
      } else {
        printTable(recommendToRows(hits));
        out(`共 ${hits.length} 条推荐` + (hits[0]?.forJob ? `（岗位：${hits[0].forJob}）` : ''));
      }
    });
  });

const greetCmd = program
  .command('greet')
  .description('对候选人打招呼（Hi聊）：搜索筛选 → 定位 → 打开详情 → 摘要 → 人机确认 → 发出 Hi。\nHi 是写操作且消耗点数：默认需确认（--no-confirm 跳过）。\n--dry-run 只看详情摘要不发出。\n退出码：success/dry_run/cancelled→0；quota_exhausted(点数不足)/failed→1，编排层据此停手。')
  .argument('[姓名]', '候选人姓名（可省略，用 --by-index 定位）')
  .option('--job <岗位>', '岗位关键字（搜索关键词）')
  .option('--by-index <序号>', '搜索结果卡片序号（1-based，跳过姓名匹配）')
  .option('--dry-run', '只查看详情摘要，不实际打招呼')
  .option('--no-confirm', '跳过 Y/N 确认直接打招呼')
  .option('--json', 'JSON 输出');
addSearchFilterOptions(greetCmd);
greetCmd.action(async (name, opts) => {
  if (opts.json) setFormat('json');
  const throttle = createThrottle(parseThrottleEnv());
  // T110：序号参数校验——非法值/0 报错，不静默回退姓名匹配
  let byIndex: number | undefined;
  if (opts.byIndex !== undefined) {
    byIndex = parseInt(opts.byIndex, 10);
    if (!Number.isFinite(byIndex) || byIndex <= 0) {
      fail(`--by-index 需为正整数序号（1-based），收到: "${opts.byIndex}"`);
    }
  }
  await runCommand(async (page) => {
    const bid = await getBrowserRef();
    if (!bid) fail('浏览器未就绪');
    // 退出码契约（T102）：success/dry_run/cancelled → 0（dry_run/cancelled 是「正常未发出」，
    // 绝不能非零退出）；quota_exhausted/failed/unknown → 1。
    // JSON 单文档协议（T103）：详情 + hiResult（+ error）一次性输出。
    const { outcome, detail } = await greetTalent(page, name || '', {
      job: opts.job,
      throttle,
      filters: filtersFromOpts(opts),
      index: byIndex,
      dryRun: opts.dryRun,
      confirm: opts.confirm, // commander --no-confirm -> opts.confirm === false
      browser: bid,
    });
    const target = name || `第${opts.byIndex}位候选人`;
    if (outcome === 'quota_exhausted') {
      if (getFormat() === 'json') {
        printJson({ ...(detail ?? {}), hiResult: hiOutcomeTag(outcome), target, error: 'Hi聊点数不足' });
      }
      fail('Hi聊点数不足：本次未发出，请分配额度后再跑（已自动关闭弹窗，不重试）');
    }
    if (getFormat() === 'json') {
      printJson({ ...(detail ?? {}), hiResult: hiOutcomeTag(outcome), target });
      if (outcome !== 'success' && outcome !== 'dry_run' && outcome !== 'cancelled') {
        fail(`打招呼未确认成功（${hiOutcomeTag(outcome)}）: ${target}`);
      }
    } else if (outcome === 'success') {
      out(`已对「${target}」打招呼成功`);
    } else if (outcome === 'dry_run' || outcome === 'cancelled') {
      // 未发出提示已由 greetTalent 输出（text 模式），命令层正常结束
    } else {
      fail(`打招呼未确认成功（${hiOutcomeTag(outcome)}）: ${target}`);
    }
  });
});

program
  .command('inspect')
  .description('查看候选人详情：搜索/定位 → 开详情 tab → 提取结构化 JSON。\n只读操作不耗点数；--hi 提取后再调「立即Hi聊」（耗点数）。\n定位方式三选一：姓名文本匹配 / --index 卡片序号 / **--resume-id 简历ID直链**\n（不经搜索、不受排序与虚拟列表影响，适合已落台账的候选人；要 Hi 需再带 --job-id）。')
  .argument('[姓名]', '候选人姓名（从搜索结果中定位；用 --resume-id 时省略）')
  .option('--job <岗位>', '岗位关键字（兜底搜索用）')
  .option('--index <序号>', '搜索结果卡片序号（1-based，跳过姓名匹配）')
  .option('--resume-id <简历ID>', '简历ID直链打开详情页（跳过搜索定位；唯一稳定键，推荐用于已落台账的候选人）')
  .option('--job-id <职位ID>', '仅供 --resume-id：直链带搜索池上下文（详情页出现「立即Hi聊」按钮，--hi 才可用）')
  .option('--hi', '提取后调用「立即Hi聊」')
  .option('--json', 'JSON 输出')
  .action(async (name, opts) => {
    if (opts.json) setFormat('json');
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      // —— resumeId 直链分支（跳过搜索定位）——
      if (opts.resumeId) {
        const bid = await getBrowserRef();
        if (!bid) { fail('浏览器未就绪'); return; }
        const rid = String(opts.resumeId).trim();
        if (!/^\d+$/.test(rid)) fail(`--resume-id 需为数字简历ID，收到: "${rid}"`);
        const jobId = opts.jobId !== undefined ? String(opts.jobId).trim() : undefined;
        const opened = await openDetailByResumeId(bid, rid, { throttle, jobId });
        if (!opened) { fail('详情直链打开失败'); return; }
        trackExtraPage(opened.page);
        const d = opened.detail;
        if (!d.name) fail('详情提取结果缺少姓名(可能详情未渲染完整)，请重试或人工核对');

        let hiResult: string | undefined;
        let hiError: string | undefined;
        if (opts.hi) {
          if (!jobId) {
            hiError = '直链未带 --job-id，详情页无「立即Hi聊」按钮，--hi 已跳过（可加 --job-id <职位ID> 重试）';
          } else {
            const outcome = await hiChatOnDetail(opened.page, { throttle });
            hiResult = hiOutcomeTag(outcome);
            if (outcome === 'quota_exhausted') {
              hiError = 'Hi聊点数不足：本次未发出，请检查额度后再跑（已自动关闭弹窗，不重试）';
            } else if (outcome !== 'success') {
              hiError = `详情页打招呼未成功（${hiOutcomeTag(outcome)}）`;
            }
          }
        }
        if (getFormat() === 'json') {
          printJson({ ...d, resumeId: rid, ...(hiResult ? { hiResult } : {}), ...(hiError ? { error: hiError } : {}) });
        } else {
          out(detailToSummary(d));
          if (hiResult === 'success') out('详情页「立即Hi聊」已成功');
        }
        if (hiError) fail(hiError);
        return;
      }
      if (!name) fail('需要 <姓名> 或 --resume-id <简历ID> 之一');
      // 确保搜索页有结果列表（无则用姓名或 --job 搜索一次）
      const current = page.url();
      // 人才搜索页判定：只有「人才搜索」页才不导航；「人才望远镜」推荐页（search-recommend）也会
      // 命中 includes('/search')，必须排除，否则 goto 到推荐页而非搜索页。
      const isSearchPool = current.includes('/Revision/talent/search') && !current.includes('/Revision/talent/search-recommend');
      if (!isSearchPool) {
        out('导航到人才搜索页…');
        await page.goto(selectors.search.url, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(1500);
      }
      let got = await page.$(`${selectors.search.resultList} ${selectors.search.resultItem}`).catch(() => null);
      if (!got) {
        const kw = opts.job || name;
        out(`搜索「${kw}」建立候选池…`);
        await searchTalents(page, kw, { throttle });
      }

      // 定位卡片序号：优先 --index；否则按姓名文本匹配
      let cardIndex: number | undefined;
      if (opts.index !== undefined) {
        cardIndex = parseInt(opts.index, 10);
        // T110：序号参数校验——非法值/0 报错（0 的 falsy 问题一并消除）
        if (!Number.isFinite(cardIndex) || cardIndex <= 0) {
          fail(`--index 需为正整数序号（1-based），收到: "${opts.index}"`);
        }
      } else {
        const items = await page.$$(`${selectors.search.resultList} ${selectors.search.resultItem}`).catch(() => []);
        for (let i = 0; i < items.length; i++) {
          const t = (await items[i].evaluate((el) => el.textContent || '').catch(() => '')) || '';
          if (t.includes(name)) { cardIndex = i + 1; break; }
        }
        if (!cardIndex) {
          // T110：未命中改为失败退出（原 warn + return 0 会误导编排层「成功但无数据」）
          fail(`未在搜索结果中定位到「${name}」，请用 --index 指定卡片序号或换关键词`);
        }
      }

      // 打开详情，提取
      const bid = await getBrowserRef();
      if (!bid) { fail('浏览器未就绪'); return; }
      const opened = await openDetailByIndex(bid, page, cardIndex as number, { throttle });
      if (!opened) { fail('详情打开失败'); return; }
      trackExtraPage(opened.page);
      const d = opened.detail;
      // T107：详情缺姓名 = 提取不完整，视为失败（输出 {} + 退出 0 会误导编排层）
      if (!d.name) fail('详情提取结果缺少姓名（可能详情未渲染完整），请重试或人工核对');

      // --hi 结果并入最终单文档（T103）；error 字段与 stderr ✖ 消息同源。
      // 退出码契约（T102）：failed/unknown 在 JSON 模式同样非零退出。
      let hiResult: string | undefined;
      let hiError: string | undefined;
      if (opts.hi) {
        const outcome = await hiChatOnDetail(opened.page, { throttle });
        hiResult = hiOutcomeTag(outcome);
        if (outcome === 'quota_exhausted') {
          hiError = 'Hi聊点数不足：本次未发出，请检查额度后再跑（已自动关闭弹窗，不重试）';
        } else if (outcome !== 'success') {
          hiError = `详情页打招呼未成功（${hiOutcomeTag(outcome)}）`;
        }
      }

      if (getFormat() === 'json') {
        printJson({ ...d, ...(hiResult ? { hiResult } : {}), ...(hiError ? { error: hiError } : {}) });
      } else {
        out(detailToSummary(d));
        if (hiResult === 'success') out('详情页「立即Hi聊」已成功');
      }
      if (hiError) fail(hiError);
    });
  });

program
  .command('talent-detail')
  .description('查看候选人详情（投递/聊天双来源，非搜索池）：定位行 → 开详情 tab → 提取结构化 JSON。\n--hi 走「回复」动作（人才管理来源免费，不耗 Hi 点数；与搜索池的 Hi聊区分）。\n定位：姓名（默认包含匹配，--strict 精确匹配）或 **--resume-id 简历ID直链**（已落台账的候选人推荐）。')
  .argument('[姓名]', '候选人姓名（从人才管理页候选人行中定位；用 --resume-id 时省略）')
  .option('--strict', '姓名精确匹配（默认包含匹配）')
  .option('--resume-id <简历ID>', '简历ID直链打开详情页（跳过列表定位；--hi 需要 --job-id 才有「回复/立即Hi聊」按钮）')
  .option('--job-id <职位ID>', '仅供 --resume-id：直链带搜索池上下文（出现操作按钮）')
  .option('--hi', '提取后调用「回复」（人才管理来源免费，不耗点数；与搜索池Hi聊区分）')
  .option('--json', 'JSON 输出')
  .action(async (name, opts) => {
    if (opts.json) setFormat('json');
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      // —— resumeId 直链分支 ——
      if (opts.resumeId) {
        const bid = await getBrowserRef();
        if (!bid) { fail('浏览器未就绪'); return; }
        const rid = String(opts.resumeId).trim();
        if (!/^\d+$/.test(rid)) fail(`--resume-id 需为数字简历ID，收到: "${rid}"`);
        const jobId = opts.jobId !== undefined ? String(opts.jobId).trim() : undefined;
        const opened = await openDetailByResumeId(bid, rid, { throttle, jobId });
        if (!opened) { fail('详情直链打开失败'); return; }
        trackExtraPage(opened.page);
        const d = opened.detail;
        if (!d.name) fail('详情提取结果缺少姓名（可能详情未渲染完整），请重试或人工核对');

        let hiResult: string | undefined;
        let hiError: string | undefined;
        if (opts.hi) {
          if (!jobId) {
            hiError = '直链未带 --job-id，无操作按钮，--hi 已跳过（可加 --job-id <职位ID> 重试）';
          } else {
            const outcome = await replyOnDetail(opened.page, { throttle });
            hiResult = outcome === 'success' ? 'reply_ok' : outcome;
            if (outcome === 'failed') hiError = `详情页「回复」未确认成功（${outcome}），请人工检查`;
          }
        }
        if (getFormat() === 'json') {
          printJson({ ...d, resumeId: rid, ...(hiResult ? { hiResult, chanSource: 'delivery' } : {}), ...(hiError ? { error: hiError } : {}) });
        } else {
          out(detailToSummary(d));
          if (hiResult === 'reply_ok') out('详情页「回复」已成功（免费，不耗点数）');
          else if (hiResult === 'none') out('无「回复」按钮（可能已回复过），详情已提取');
        }
        if (hiError) fail(hiError);
        return;
      }
      if (!name) fail('需要 <姓名> 或 --resume-id <简历ID> 之一');
      const bid = await getBrowserRef();
      if (!bid) { fail('浏览器未就绪'); return; }
      const opened = await openTalentMgmtDetail(bid, page, name, { strict: opts.strict, throttle });
      if (!opened) { fail(`详情打开失败: ${name}`); return; }
      trackExtraPage(opened.page);
      const d = opened.detail;
      // T107：详情缺姓名 = 提取不完整，视为失败（输出 {} + 退出 0 会误导编排层）
      if (!d.name) fail('详情提取结果缺少姓名（可能详情未渲染完整），请重试或人工核对');

      // --hi（人才管理来源 = 「回复」，免费不耗点数）结果并入最终单文档（T103）。
      // 退出码契约：success → 0；none → 0（无按钮=可能已回复过，非失败）；failed → 1（JSON 模式同样）
      let hiResult: string | undefined;
      let hiError: string | undefined;
      if (opts.hi) {
        const outcome = await replyOnDetail(opened.page, { throttle });
        hiResult = outcome === 'success' ? 'reply_ok' : outcome;
        if (outcome === 'failed') hiError = `详情页「回复」未确认成功（${outcome}），请人工检查`;
      }

      if (getFormat() === 'json') {
        printJson({
          ...d,
          ...(hiResult ? { hiResult, chanSource: 'delivery' } : {}),
          ...(hiError ? { error: hiError } : {}),
        });
      } else {
        out(detailToSummary(d));
        if (hiResult === 'reply_ok') out('详情页「回复」已成功（免费，不耗点数）');
        else if (hiResult === 'none') out('无「回复」按钮（可能已回复过），详情已提取');
      }
      if (hiError) fail(hiError);
    });
  });

program
  .command('preview')
  .description('在线简历预览（每日次数有限）：打开预览截图/OCR 存档到本地。\n默认只存本地图片；设置 51JOB_RESUME_OCR=1 才上传云端 OCR（opt-in）。')
  .argument('<姓名>')
  .action(async (name) => {
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      const ok = await previewResume(page, name, { throttle });
      if (!ok) fail(`简历预览失败: ${name}`);
    });
  });

program
  .command('positions')
  .description(
    '读取职位列表（职位管理页）。加 --candidates <职位名> 拉取该职位候选人：\n' +
      '来源由 --source 决定：auto(默认)=有投递走投递列表、无投递走人才搜索；delivery=仅投递；\n' +
      'search=强制人才池搜索（投递少时扩充候选，自动注入该职位的城市/学历筛选）。\n' +
      '投递候选人 output: {position, source: delivery|search, portal, count, candidates[]}；\n' +
      'candidates 含每人 index/name/age/years/edu/city/snippet。',
  )
  .option('--candidates <职位名>', '按职位拉取候选人列表（替代默认职位列表输出）')
  .option('--scope <my|org>', '职位视图：my=我的职位，org=组织下职位（默认不切，保持页面当前视图）')
  .option('--source <auto|delivery|search>', '候选人来源: auto=按有无投递分派(默认) / delivery=仅投递 / search=人才池搜索')
  .option('--all', 'source=search 时滚动收集全量候选人（⚠️ 滚动采集易触发风控，非必要不使用；默认只读首屏 ~30 人即可）')
  .option('--json', 'JSON 输出')
  .action(async (opts) => {
    if (opts.json) setFormat('json');
    // scope 校验：只允许 my / org
    let scope: JobScope | undefined;
    if (opts.scope !== undefined) {
      const s = String(opts.scope).toLowerCase();
      if (s !== 'my' && s !== 'org') fail(`--scope 只能为 my 或 org，收到: "${opts.scope}"`);
      scope = s as JobScope;
    }
    // source 校验：只允许 auto / delivery / search
    let source: JobSource | undefined;
    if (opts.source !== undefined) {
      const v = String(opts.source).toLowerCase();
      if (v !== 'auto' && v !== 'delivery' && v !== 'search') fail(`--source 只能为 auto/delivery/search，收到: "${opts.source}"`);
      source = v === 'auto' ? undefined : (v as JobSource);
    }
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      if (opts.candidates) {
        const bid = await getBrowserRef();
        if (!bid) { fail('浏览器未就绪'); return; }
        const r = await readPositionCandidates(bid, page, String(opts.candidates), { throttle, scope, source, all: !!opts.all });
        if (!r) { fail(`未能读取职位「${opts.candidates}」候选人`); return; }
        if (getFormat() === 'json') {
          printJson(r);
        } else {
          out(`职位「${r.position}」: ${r.count} 位候选人（来源: ${r.source === 'delivery' ? '投递' : '搜索'}）`);
          printTable(
            r.candidates.map((c) => ({
              '#': c.index,
              姓名: c.name,
              画像: [c.age, c.years, c.edu, c.city].filter(Boolean).join('·') || '',
              摘要: c.snippet || '',
            })),
          );
        }
        return;
      }
      const jobs = await readPositions(page, { throttle, scope });
      if (getFormat() === 'json') {
        printJson(jobs);
      } else {
        printTable(jobsToRows(jobs));
        out(`共 ${jobs.length} 个职位`);
      }
    });
  });

program
  .command('jd')
  .description('抓取职位 JD 长文本缓存到本地 (~/.51job-cli/jd/<名称>.md)，供后续比对使用。\n--cat 直接输出正文；--json 返回 {file, name, content}。')
  .argument('<名称>')
  .option('--cat', '抓取后直接输出 JD 正文')
  .option('--json', 'JSON 输出（含文件路径）')
  .action(async (name, opts) => {
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      const file = await fetchJd(page, name, { throttle });
      if (!file) fail(`JD 抓取失败: ${name}`);
      if (opts.json) {
        const fs = await import('fs');
        const content = fs.readFileSync(file!, 'utf-8');
        printJson({ file, name, content });
      } else if (opts.cat) {
        const fs = await import('fs');
        out(fs.readFileSync(file!, 'utf-8'));
      }
    });
  });

program
  .command('probe')
  .description('调试工具：探查当前页面结构，输出选择器校准建议（保存到 ~/.51job-cli/probe/）。\n仅供开发校准，普通使用无需运行。')
  .option('--json', 'JSON 输出')
  .action(async (opts) => {
    if (opts.json) setFormat('json');
    await runCommand(async (page) => {
      const result = await probePage(page);
      if (getFormat() === 'json') {
        printJson(result);
      } else {
        printProbe(result);
      }
    });
  });

program
  .command('shutdown')
  .description('关闭常驻浏览器实例（登录态保留在 ~/.51job-cli/.cache/，下次命令自动重启）。\n本机浏览器资源紧张时使用。')
  .action(async () => {
    await shutdownBrowser();
    out('常驻浏览器已关闭（登录态保留在 ~/.51job-cli/.cache/）');
  });

program
  .command('clean')
  .description('清理本地生成物（ocr 简历截图/识别文本、probe 页面快照、jd 职位缓存），不触碰登录态与 state.json。\n只清超保留期(默认 30 天，51JOB_RETENTION_DAYS 可配)的文件；--all 清全部。\n先 --dry-run 查看将删除的文件，再实际清理。')
  .option('--dry-run', '只列出将删除的文件，不实际删除')
  .option('--jd', '连同 jd/ 职位 JD 缓存一起清理')
  .option('--all', '忽略保留期，清理全部')
  .action(async (opts) => {
    // 不走 runCommand：清理不需要浏览器，也不做可用性校验（离线可用）
    const daysRaw = parseInt(process.env['51JOB_RETENTION_DAYS'] ?? '', 10);
    const retentionDays = opts.all ? 0 : Number.isFinite(daysRaw) && daysRaw >= 0 ? daysRaw : 30;
    const files = collectExpiredFiles(retentionDays, !!opts.jd);
    if (files.length === 0) {
      out(`没有超过保留期（${retentionDays} 天）的可清理文件`);
      return;
    }
    if (opts.dryRun) {
      for (const f of files) out(`[dry-run] ${f.dirLabel}/${basename(f.file)}（${f.ageDays} 天前）`);
      out(`共 ${files.length} 个文件将被清理（保留期 ${retentionDays} 天）`);
      return;
    }
    let removed = 0;
    for (const f of files) {
      try {
        unlinkSync(f.file);
        removed++;
      } catch (e) {
        warn(`删除失败（跳过）: ${f.file}（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
    out(`已清理 ${removed}/${files.length} 个文件（保留期 ${retentionDays} 天；登录态与 state.json 未触碰）`);
  });

program
  .command('doctor')
  .description('环境自检：Chrome 路径、Node 版本、数据目录、反检测与浏览器模式配置。\n启动前排障用，只读不修改任何内容。')
  .action(() => {
    ensureDirs();
    out(`Node: ${process.version}`);
    const chrome = findChrome();
    out(`Chrome: ${chrome || '未找到 (请设置 CHROME_PATH)'}`);
    out(`数据目录: ${storeRoot()}`);
    out(`反检测: 注入伪装 + CDP 网络拦截 + 风控熔断`);
    out(`浏览器模式: 有头（默认；51JOB_BROWSER_HEADLESS / RECRUIT_BROWSER_HEADLESS=true 可覆盖为无头，不建议）`);
  });

program
  .command('update')
  .description('升级 51job-cli 到最新版（提示命令，实际执行 npm install -g 51job-cli@latest）')
  .action(async () => {
    warn('更新请执行: npm install -g 51job-cli@latest');
  });

// 无参数时打印帮助（置 exitCode 而非 process.exit，避免管道下帮助文本被截断）
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exitCode = 0;
}

// fail() 抛出的 FatalCliError 在此统一收口：消息已由 fail 写入 stderr，
// 只置退出码并让进程自然退出——上游 finally 清理（断开浏览器/释放会话锁）已执行，
// stdout 缓冲（--json 结果）完整落盘。
program.parseAsync(process.argv).catch((e) => {
  if (e instanceof FatalCliError) {
    process.exitCode = e.exitCode;
    return;
  }
  err(`执行出错: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
