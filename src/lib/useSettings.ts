// 设置的读取入口：一次读 + 写后订阅（轮47 R47-04）。
//
// 动机：DiffView 原来在渲染体里 `loadSettings()`。今天它不出错，纯粹依赖两个隐含前提——
// 全站没有 memo、App 任何动作都全量重渲染。给保活页加上 memo 的那一天，它读到的就是陈旧值，
// 而且「什么时候读到新值」由渲染时序决定，不由数据决定。渲染期读存储还有个更糟的性质：
// 读回来的到底是用户现场还是本应用上一帧写的回声，代码上无法判定（轮45/轮46 的根因）。
//
// 为什么不用 useSyncExternalStore：它要求 getSnapshot 返回稳定引用，得给 settings 再加一层
// raw→object 缓存；这里的写入是同步 localStorage、没有并发撕裂，useState + 订阅更直白。
// 为什么不 props 下发：App 并不拥有 settings，下发要先把它变成读盘方，
// 再补一条 SettingsView→App 的通知链，等于把旁路搬到别处，还多一根线穿过保活页树。
import { useEffect, useState } from "react";
import { loadSettings, subscribeSettings, type AppSettings } from "../store/settings";

/** 当前设置：挂载时读一次，此后由 saveSettings（和水合后的显式通知）推动更新。 */
export function useSettings(): AppSettings {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  useEffect(() => {
    // 通知里重读一次磁盘：写入方 saveSettings 已经落盘，这里读到的一定是写完的值。
    // 订阅后立刻补读一次，覆盖「订阅前一刻刚写完」的窗口。
    setSettings(loadSettings());
    return subscribeSettings(() => setSettings(loadSettings()));
  }, []);

  return settings;
}
