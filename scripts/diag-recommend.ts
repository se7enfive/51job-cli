/**
 * 诊断：推荐池卡片序号 ↔ 详情页简历身份的对应关系（2026-08-26）
 *
 * 背景：--inspect 按序号打开推荐卡详情时，发现返回简历的身份与列表显示不符
 * （列表第7叶女士 → 详情黄先生）。本脚本在同一运行内：
 *   1. 读列表（readRecommendResults）拿每张卡片姓名
 *   2. 逐个点开卡片详情 → 读详情页姓名（resumeId + name）
 *   3. 对比「卡片姓名 vs 详情姓名」，输出错位明细
 *
 * 用法：node dist/diag-recommend.js --job "三维扫描" --max 5
 * 只在已登录的 Chrome 上跑（有头），一次最多 --max 张。
 */
import { program } from 'commander';
import { getBrowserRef, withSessionPage, trackExtraPage } from '../src/core/sessionPage';
import { delay } from '../src/core/throttle';
import { selectors } from '../src/pages/selectors';
import { navToRecommend, readRecommendResults } from '../src/pages/recommend';
import { openCardDetail } from '../src/pages/talent-insight';

program
  .option('--job <岗位>', '推荐岗位关键字', '三维扫描')
  .option('--max <n>', '最多开多少张', '5')
  .parse(process.argv);
const opts = program.opts();
const max = parseInt(opts.max, 10);

async function main() {
  const browser = getBrowserRef();
  if (!browser) throw new Error('浏览器未就绪（可能未启动会话）');

  await withSessionPage(async (page) => {
    await navToRecommend(page, {});
    const hits = await readRecommendResults(page, {});
    console.log(`列表共 ${hits.length} 张卡片，本次诊断前 ${Math.min(max, hits.length)} 张`);

    for (let i = 0; i < Math.min(max, hits.length); i++) {
      const card = hits[i];
      const idx = i + 1;
      const opened = await openCardDetail(browser, page, idx, selectors.recommend.resultItem, {});
      if (!opened) {
        console.log(`[${idx}] ${card.name} -> 打开失败`);
        continue;
      }
      trackExtraPage(opened.page);
      const d = opened.detail;
      const resumeId = d?.resumeId || '?';
      const detName = d?.name || '(无名)';
      const match = detName === card.name ? '👌一致' : `❌不一致! 卡片=${card.name} 详情=${detName}`;
      console.log(`[${idx}] 卡片=${card.name} | 详情=${detName} | resumeId=${resumeId} | ${match}`);
      try {
        await opened.page.close();
      } catch {
        /* ignore */
      }
      await delay(900 + Math.random() * 600);
    }
  });
  console.log('--- 诊断完成 ---');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});