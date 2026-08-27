#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
import { detailToSummary, openDetailByIndex, hiChatOnDetail } from './pages/candidate-detail';
import { openTalentMgmtDetail, replyOnDetail, openCardDetail } from './pages/talent-insight';
import { readPositions, jobsToRows, fetchJd } from './pages/job';
import { probePage, printProbe } from './pages/probe';
import { ensureDirs, root as storeRoot } from './utils/store';
import { version } from '../package.json';

// 环境变量加载：先读 ~/.51job-cli/.env（用户级持久配置），再读 ./.env（项目级覆盖）。
// 不存在的文件静默跳过；两者都不会覆盖已存在的系统环境变量（dotenv 默认行为）。
const userEnvPath = join(homedir(), '.51job-cli', '.env');
if (existsSync(userEnvPath)) loadEnv({ path: userEnvPath, quiet: true });
loadEnv({ quiet: true });

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
  .description('前程无忧自动化 CLI：候选人管理、Hi聊、人才搜索、职位管理。基于 puppeteer-core/CDP 驱动本机 Chrome，自带反检测与风控熔断。')
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
  .description('打开 ehire 登录页后立即返回（不等待登录；由 wait-login 轮询等待）')
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
  .description('等待登录完成（轮询检测，配合 login 使用）')
  .option('--timeout <秒>', '等待登录超时秒数', '300')
  .action(async (opts) => {
    await runCommand(async (page) => {
      await waitForLogin(page, { timeoutSec: parseInt(opts.timeout, 10) });
    });
  });

program
  .command('list')
  .description('读取候选人/投递列表')
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
  .description('打开指定候选人会话')
  .argument('[姓名]', '候选人姓名（优先用 --index 精确定位）')
  .option('--index <序号>', '列表序号（对应 list 输出）')
  .option('--unread', '对应 list --unread 的序号')
  .option('--strict', '精确匹配姓名')
  .action(async (name, opts) => {
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      const opened = await openChat(page, {
        name: name || undefined,
        index: opts.index ? parseInt(opts.index, 10) : undefined,
        strict: opts.strict,
        throttle,
      });
      if (!opened) fail('未能打开会话');
    });
  });

program
  .command('send')
  .description('向当前会话发送消息')
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
  .description('会话操作: resume(索要简历) / unsuitable(不合适) / note(备注) / wechat(换微信) / phone(换电话) / interview(约面试)')
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
  .description('人才搜索：关键词 + 多维筛选（自动导航搜索页，设置筛选后搜索并读结果）')
  .argument('<关键词>')
  .option('--json', 'JSON 输出');
addSearchFilterOptions(searchCmd);
searchCmd.action(async (keyword, opts) => {
  if (opts.json) setFormat('json');
  const throttle = createThrottle(parseThrottleEnv());
  const filters = filtersFromOpts(opts);
  await runCommand(async (page) => {
    await searchTalents(page, keyword, { throttle, filters });
    const hits = await readSearchResults(page, { throttle });
    if (getFormat() === 'json') {
      printJson(hits);
    } else {
      printTable(searchToRows(hits));
      out(`共 ${hits.length} 条结果`);
    }
  });
});

program
  .command('recommend')
  .description('读取人才望远镜推荐候选人列表（可切岗位、打招呼、开详情）')
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
        const opened = await openCardDetail(bid, page, idx, selectors.recommend.resultItem, { throttle });
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
  .description('对候选人打招呼：搜索筛选 → 定位 → 打开详情 → 摘要 → 人机确认 → Hi')
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
      index: opts.byIndex ? parseInt(opts.byIndex, 10) : undefined,
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
  .description('查看候选人详情：搜索/定位 → 开详情 tab → 提取结构化 JSON（先看再 Hi）')
  .argument('<姓名>', '候选人姓名（从搜索结果中定位）')
  .option('--job <岗位>', '岗位关键字（兜底搜索用）')
  .option('--index <序号>', '搜索结果卡片序号（1-based，跳过姓名匹配）')
  .option('--hi', '提取后调用「立即Hi聊」')
  .option('--json', 'JSON 输出')
  .action(async (name, opts) => {
    if (opts.json) setFormat('json');
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
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
      if (opts.index) {
        cardIndex = parseInt(opts.index, 10);
      } else {
        const items = await page.$$(`${selectors.search.resultList} ${selectors.search.resultItem}`).catch(() => []);
        for (let i = 0; i < items.length; i++) {
          const t = (await items[i].evaluate((el) => el.textContent || '').catch(() => '')) || '';
          if (t.includes(name)) { cardIndex = i + 1; break; }
        }
        if (!cardIndex) {
          warn(`未在搜索结果中定位到「${name}」，请用 --index 指定卡片序号或换关键词`);
          return;
        }
      }

      // 打开详情，提取
      const bid = await getBrowserRef();
      if (!bid) { fail('浏览器未就绪'); return; }
      const opened = await openDetailByIndex(bid, page, cardIndex as number, { throttle });
      if (!opened) { fail('详情打开失败'); return; }
      trackExtraPage(opened.page);
      const d = opened.detail;

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
  .description('查看人才管理页候选人详情（覆盖投递/聊天双来源，非搜索池）：定位行 → 开详情 tab → 提取结构化 JSON。--hi 走「回复」免费动作（非Hi聊点数）')
  .argument('<姓名>', '候选人姓名（从人才管理页候选人行中定位）')
  .option('--strict', '姓名精确匹配（默认包含匹配）')
  .option('--hi', '提取后调用「回复」（人才管理来源免费，不耗点数；与搜索池Hi聊区分）')
  .option('--json', 'JSON 输出')
  .action(async (name, opts) => {
    if (opts.json) setFormat('json');
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      const bid = await getBrowserRef();
      if (!bid) { fail('浏览器未就绪'); return; }
      const opened = await openTalentMgmtDetail(bid, page, name, { strict: opts.strict, throttle });
      if (!opened) { fail(`详情打开失败: ${name}`); return; }
      trackExtraPage(opened.page);
      const d = opened.detail;

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
  .description('在线简历预览（每日次数有限）')
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
  .description('读取职位列表')
  .option('--json', 'JSON 输出')
  .action(async (opts) => {
    if (opts.json) setFormat('json');
    const throttle = createThrottle(parseThrottleEnv());
    await runCommand(async (page) => {
      const jobs = await readPositions(page, { throttle });
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
  .description('抓取职位 JD 缓存到本地 (~/.51job-cli/jd/)')
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
  .description('探查当前页面结构，输出选择器校准建议（保存到 ~/.51job-cli/probe/）')
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
  .description('关闭常驻浏览器实例（登录态保留，下次命令自动重启）')
  .action(async () => {
    await shutdownBrowser();
    out('常驻浏览器已关闭（登录态保留在 ~/.51job-cli/.cache/）');
  });

program
  .command('doctor')
  .description('环境自检：Chrome 路径、Node 版本、数据目录')
  .action(() => {
    ensureDirs();
    out(`Node: ${process.version}`);
    const chrome = findChrome();
    out(`Chrome: ${chrome || '未找到 (请设置 CHROME_PATH)'}`);
    out(`数据目录: ${storeRoot()}`);
    out(`反检测: 注入伪装 + CDP 网络拦截 + 风控熔断`);
    out(`默认浏览器模式: 有头 (可用 51JOB_BROWSER_HEADLESS=true 覆盖，但不建议)`);
  });

program
  .command('update')
  .description('通过 npm 更新 51job-cli')
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
