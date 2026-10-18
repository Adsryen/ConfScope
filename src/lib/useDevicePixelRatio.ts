import { useEffect, useState } from "react";

/**
 * 全站唯一的 devicePixelRatio 订阅（轮32 F-32）。
 *
 * 缺陷长什么样：缩略图的画布在绘制 effect 里读一次 `window.devicePixelRatio` 就完事，
 * 依赖表里没有它，全库也没有任何 dpr 订阅。用户把窗口拖到另一台屏、改系统缩放、或 WebView2
 * 换缩放档位之后，`devicePixelRatio` 变了但没人重画：画布仍是按旧档位摆的物理像素，
 * 与新 CSS 尺寸失配 ⇒ 整条缩略图发糊/被拉伸。更糟的是它会「过一会儿自己好了」——
 * 正文变长、查找栏开合这些别的原因恰好触发重绘时才自愈，这种缺陷最难复现也最难查。
 *
 * 为什么用 matchMedia 而不是 resize：dpr 变化不一定会带来窗口尺寸变化（同一块屏改缩放档位、
 * 或 HiDPI/普通屏分辨率相同的情况），而 `(resolution: <dpr>dppx)` 这条 media 正好在跨过档位时翻转。
 * query 里写死的是**当前**档位，所以每次档位变了都要重新订阅一条新的——这就是依赖表里那个 dpr。
 */

/** 读一次当前档位；没有 window 或读到脏值（0 / NaN）都兜底成 1，别让画布尺寸乘成 0。 */
function readDevicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const ratio = window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** 当前 dpr；跨档时同步更新，并在没有 matchMedia 的宿主里退回「挂载时读一次」。 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState<number>(readDevicePixelRatio);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    // 老 Safari / 老 WebView 只有 addListener：没有标准通道就退回一次性读取，
    // 首帧照样按当前档位画，不许因为订阅不了就把绘制整条废掉。
    if (typeof mql.addEventListener !== "function") return;
    const onChange = () => setDpr(readDevicePixelRatio());
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [dpr]);

  return dpr;
}
