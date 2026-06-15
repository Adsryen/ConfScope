interface Props {
  page: number;
  pages: number;
  onPage: (p: number) => void;
  loading?: boolean;
}

/** 简单分页条：上一页 / 当前页 / 总页数 / 下一页。只有一页时不显示。 */
export default function Pager({ page, pages, onPage, loading }: Props) {
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button
        className="btn btn-ghost btn-sm"
        disabled={loading || page <= 1}
        onClick={() => onPage(page - 1)}
        title="上一页"
      >
        ‹
      </button>
      <span className="pager-info">
        {page} / {pages}
      </span>
      <button
        className="btn btn-ghost btn-sm"
        disabled={loading || page >= pages}
        onClick={() => onPage(page + 1)}
        title="下一页"
      >
        ›
      </button>
    </div>
  );
}
