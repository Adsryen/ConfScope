/**
 * 「历史变更」的分段宿主：服务端历史与本机历史并列，不硬合并（轮67 R57-WP15 / R57 R7）。
 *
 * 为什么要这一层而不是把本机记录塞进 HistoryView 的那一列：
 * 两边说的根本不是同一件事。服务端那一列是「配置中心记下的那次发布」，
 * 本机这一列是「这台机器在什么时刻见过哪一版」。字段不同、覆盖范围不同，
 * 拼成一列就会造出「看着像历史、其实缺项」的假数据——这正是 R7 明确不要的东西。
 *
 * 分段控件只在两个源都可达时出现：只有一个选项的分段是噪音，
 * 还会让人以为另一档被自己关掉了（Apollo/Consul 没有服务端历史，本机一档就是全部）。
 */
import { useEffect, useState } from "react";
import { Connection } from "../store/connections";
import type { ApplyEntryPayload } from "../lib/applyEntry";
import { localRevisionStoreAvailable } from "../lib/configRevisions";
import { supportsConfigHistory } from "../lib/configCapabilities";
import type { Format } from "../lib/format";
import { useTranslation } from "../i18n";
import HistoryView from "./HistoryView";
import LocalRevisionPanel from "./LocalRevisionPanel";

/** 历史来源那一档：与两个子面板同名，分段与在屏内容必须同向（守卫钉这点）。 */
export type HistorySource = "server" | "local";

interface Props {
  conn: Connection;
  tenant: string;
  dataId: string;
  group: string;
  currentContent: string;
  format: Format;
  active?: boolean;
  searchTerm?: string;
  onStartApply?: (payload: ApplyEntryPayload) => void;
}

/** 历史变更面板：顶部分段（两个源都可用时才出）+ 服务端历史或本机历史。 */
export default function ConfigHistoryPanel({
  conn,
  tenant,
  dataId,
  group,
  currentContent,
  format,
  active = true,
  searchTerm,
  onStartApply,
}: Props) {
  const { t } = useTranslation();
  const serverCapable = supportsConfigHistory(conn);
  const localCapable = localRevisionStoreAvailable();
  // 服务端不可达（Apollo / Consul / 本地快照 / 纯浏览器 web 模式）时默认落本机那一档
  const [source, setSource] = useState<HistorySource>(serverCapable ? "server" : "local");

  useEffect(() => {
    // 连接在设置里被改过（Nacos → Apollo）后服务端这一档会消失，
    // 停留在 server 会让面板空着，所以只往回退、不抢用户已经选好的本机档。
    if (!serverCapable) setSource("local");
  }, [serverCapable]);

  const bothCapable = serverCapable && localCapable;
  const showLocal = !serverCapable || source === "local";

  return (
    <div className="history-source">
      {bothCapable && (
        <div className="history-source-bar">
          <div className="view-mode" role="group" aria-label={t("history.sourceGroup")}>
            <button
              type="button"
              className={`btn btn-ghost btn-sm${source === "server" ? " active" : ""}`}
              aria-pressed={source === "server"}
              onClick={() => setSource("server")}
            >
              {t("history.sourceServer")}
            </button>
            <button
              type="button"
              className={`btn btn-ghost btn-sm${source === "local" ? " active" : ""}`}
              aria-pressed={source === "local"}
              onClick={() => setSource("local")}
            >
              {t("history.sourceLocal")}
            </button>
          </div>
          <span className="history-hint">{t("history.sourceHint")}</span>
        </div>
      )}
      {showLocal ? (
        <LocalRevisionPanel
          conn={conn}
          tenant={tenant}
          active={active}
          dataId={dataId}
          group={group}
          currentContent={currentContent}
          format={format}
          searchTerm={searchTerm}
          onStartApply={onStartApply}
        />
      ) : (
        <HistoryView
          conn={conn}
          tenant={tenant}
          active={active}
          dataId={dataId}
          group={group}
          currentContent={currentContent}
          format={format}
          searchTerm={searchTerm}
          onStartApply={onStartApply}
        />
      )}
    </div>
  );
}
