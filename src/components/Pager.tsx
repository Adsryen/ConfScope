import { useTranslation } from "../i18n";

interface Props {
  page: number;
  pages: number;
  onPage: (p: number) => void;
  loading?: boolean;
}

/** 简单分页条：上一页 / 页码 / 下一页。只有一页时不显示。 */
export default function Pager({ page, pages, onPage, loading }: Props) {
  const { t } = useTranslation();
  if (pages <= 1) return null;
  return (
    <div className="pager" role="group" aria-label={t("common.pagerLabel")}>
      <button
        className="btn btn-ghost btn-sm"
        disabled={loading || page <= 1}
        onClick={() => onPage(page - 1)}
        title={t("common.previousPage")}
        aria-label={t("common.previousPage")}
      >
        ‹
      </button>
      {/* 「1 / 5」读出来是「一 斜杠 五」，听不出是页码（R33）：可见文本与读屏文本用同一句，免得两套说法漂移。 */}
      <span className="pager-info">{t("common.pagerInfo", { page, pages })}</span>
      <button
        className="btn btn-ghost btn-sm"
        disabled={loading || page >= pages}
        onClick={() => onPage(page + 1)}
        title={t("common.nextPage")}
        aria-label={t("common.nextPage")}
      >
        ›
      </button>
    </div>
  );
}
