/**
 * 对比度普查的「每档文本节点下限」（轮95 R5）。
 *
 * 缺陷长什么样：`99-s-contrast.spec.ts` 的判据是「真不达 AA 的分组必须为 0」。轮94 那次整页白屏
 * （wailsjs 同步取绑定抛穿 render ⇒ React 卸载 `#root`）拿到的读数是 `scanned = 0`、
 * `A = []` —— 一个文本节点都没量到，于是"没有不达标的文字"这句话是**真的**，用例是**绿的**。
 * 只要扫描器扫不到东西，任何"逐节点判据"都会自动通过：这就是假绿。
 *
 * 所以下限要按档钉，不能只钉一个总数：总数地板（> 1,500）挡不住"某一档塌了、其余档还在"的形态，
 * 而恰恰"某一档塌了"是真实故障的形状（某个页面崩了 / 某个容器被隐藏了 / 数据没加载出来）。
 *
 * 数值来源：轮88 全量复测的实测读数（19 档逐档 `CONTRAST <状态> 文本节点=N`），按下限 ≈ 实测的 55%
 * 留出余量——文案增删、命中数量随搜索词变化、保活页签的渲染顺序都会带来个位数到两位数的抖动
 * （轮87 与轮88 两次跑之间「配置矩阵」就从 37 落到 35），而真正的塌方是断崖式的（白屏 = 0）。
 * 抬下限必须连同新的实测读数一起改，不许为了过断言把下限压低（口径见
 * `.trellis/spec/frontend/visual-contrast-guidelines.md` §4 R-7）。
 */
export const MIN_TEXT_NODES: Record<string, number> = {
  // 11 个一级视图
  配置浏览: 36,
  配置对比: 293,
  配置矩阵: 19,
  操作历史: 13,
  备份快照: 12,
  任务中心: 13,
  审计日志: 23,
  连接管理: 47,
  "SSH 隧道": 27,
  设置: 86,
  关于: 22,
  // 8 个带数据的深状态
  "配置浏览+选中文件": 261,
  "配置浏览+代码查找命中": 266,
  "配置浏览+内容搜索命中列表": 119,
  "配置浏览+历史变更diff+命中": 300,
  "配置矩阵+详情": 505,
  "配置对比+展开来源面板": 292,
  "配置对比+匹配列表": 86,
  "配置对比+批量结果": 239,
};

/**
 * 逐档核对读数与下限，返回报红的档位说明（空数组 = 全部达标）。
 *
 * 为什么单独成函数：判据要在两处用 —— 普查末尾拿真实读数判一次，
 * 另一条快例（人为白屏注入）拿构造读数自证一次。收在这儿，两处共用同一条规则，
 * 不会出现"能抓到白屏的那份判据只存在于自证用例里"的自娱自乐。
 */
export function nodeFloorViolations(perState: Record<string, number>, expected: string[]): string[] {
  const violations: string[] = [];
  for (const state of expected) {
    const floor = MIN_TEXT_NODES[state];
    if (floor === undefined) {
      violations.push(`${state}：登记表里没有这一档的下限，先补 MIN_TEXT_NODES（新增普查档位必须连同下限一起登记）`);
      continue;
    }
    const n = perState[state];
    if (n === undefined) {
      violations.push(`${state}：这一档没有读数（take 没被调用，或调用时漏了 await）`);
      continue;
    }
    if (n < floor) {
      violations.push(`${state}：文本节点 ${n} < 下限 ${floor} ⇒ 这一档多半整块没渲染出来，"真不达组=0"是空转出来的绿`);
    }
  }
  return violations;
}
