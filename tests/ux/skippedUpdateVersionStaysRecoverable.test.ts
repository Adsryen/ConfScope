/**
 * 「忽略此版本」必须看得见、也撤销得了（轮67 / R67-WP2）。
 *
 * 缺陷长什么样：About 页的「忽略此版本」把 `settings.update.skipVersion` 写盘后，
 * 界面只把状态切成「当前已是最新版本」。之后全站再没有任何地方显示这条记录，
 * 也没有任何入口能撤销——用户以为真的没有新版本，而新版本其实一直被这条记录挡着。
 * 实测：settings 108 条文案里没有一条与 skipVersion 相关，写点之外没有读点。
 *
 * 口径：
 * 1. 同一个事实源（`settings.update.skipVersion`）两处显示：About 说「被谁挡住」、设置页把值摆出来并可清空；
 * 2. 清空点只允许设置在「应用更新」小节，别处再冒一份「悄悄改写 skipVersion」即红；
 * 3. 设置页的索引项与小节一一对应，且小节里真的有那颗恢复按钮；
 * 4. zh/en 两套文案都得有这几条键（漏一边就是切语言时掉字）。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const ABOUT = "src/components/About.tsx";
const SETTINGS_VIEW = "src/components/SettingsView.tsx";
const STORE = "src/store/settings.ts";

const LOCALE_KEYS = [
  "settings.update",
  "settings.updateDescription",
  "settings.lastUpdateCheck",
  "settings.updateNeverChecked",
  "settings.lastSeenUpdateVersion",
  "settings.skippedUpdateVersion",
  "settings.updateSkipHint",
  "settings.restoreUpdateReminder",
  "about.noUpdate",
  "about.noUpdateIgnored",
];

/*
 * 轮73 改形状：update() 从「整段展开 ...settings.update」换成「只给要改的字段 + 落盘节 id」
 * （SettingsPatch，合并基准改为从盘上读，见 R73-P2 注释）。
 * 守卫钉的仍是那条口径——清空必须走 update() 这唯一的落盘出口，只是正则跟着换成新形状。
 */
describe("被忽略的更新版本可恢复（轮67 R67-WP2）", () => {
  const about = readScannedSource(ABOUT);
  const settingsView = readScannedSource(SETTINGS_VIEW);

  it('About 的「已是最新」按有没有忽略过分流', () => {
    expect(about, "About 读回了被忽略的版本，却没进渲染").toMatch(/useState\(\(\) => loadSettings\(\)\.update\.skipVersion\)/);
    expect(about, "忽略后仍说「当前已是最新版本」就是在骗人").toContain('t("about.noUpdateIgnored"');
    expect(about, "没忽略过时那条说法要留着").toContain('t("about.noUpdate")');
    expect(about.match(/skippedVersion/g), "分流只该有一处，散落着抄说明收得不够").toHaveLength(3);
  });

  it("设置页的应用更新小节把值摆出来并可清空", () => {
    expect(settingsView, "索引里少了「应用更新」这一项").toContain('{ id: "settings-update", labelKey: "settings.update" }');
    expect(settingsView, "没有对应小节，索引点了只会停在原处").toContain('id="settings-update"');
    expect(settingsView, "小节里没把被忽略的版本显示出来").toContain('t("settings.skippedUpdateVersion")');
    expect(
      settingsView,
      "清空必须走 update()（同一份 settings 落盘出口），别另开一条写盘路径"
    ).toMatch(/update\(\{ update: \{ skipVersion: "" \} \}, "settings-update"\)/);
    expect(settingsView, "没有忽略记录时按钮要停用，别让人点一颗空按钮").toMatch(/disabled=\{!settings\.update\.skipVersion\}/);
  });

  it("只有 About 能写版本号、只有设置页能清空", () => {
    // 写侧：About 只许写「刚发现的那个版本号」
    expect(about, "忽略的该是刚发现的版本，不是别的值").toMatch(/updateUpdateSettings\(\{ skipVersion: updateResult\.latestVersion \}\)/);
    expect(about, "About 不许自己清空——清空是设置页恢复提醒的动作").not.toMatch(/skipVersion: ""/);
    // 清空侧：空串字面量只允许出现在设置页与 store 的默认值里
    const clearSites = [ABOUT, SETTINGS_VIEW, STORE].filter((file) => /skipVersion: ""/.test(readScannedSource(file)));
    expect(clearSites.sort(), "又长出一个悄悄清空 skipVersion 的地方").toEqual([STORE, SETTINGS_VIEW].sort());
  });

  it("zh / en 两套文案都有这些键", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      const missing = LOCALE_KEYS.filter((key) => !(key in flat));
      expect(missing, `${file} 缺键`).toEqual([]);
    }
  });
});
