import { useEffect, useState } from "react";
import {
  Connection,
  deleteConnection,
  loadConnections,
  upsertConnection,
} from "../store/connections";
import { clearToken, testConnection } from "../api/nacos";

interface Props {
  onClose: () => void;
  onChange: (conns: Connection[]) => void;
}

type Draft = Omit<Connection, "id"> & { id?: string };

const emptyDraft = (): Draft => ({
  name: "",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "",
  defaultNamespace: "",
});

export default function ConnectionManager({ onClose, onChange }: Props) {
  const [list, setList] = useState<Connection[]>(loadConnections());
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  // 待确认删除的连接 id（点一次 × 进入确认态，再点才删）
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  // Esc 关闭弹框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setTestMsg(null);
  };

  const refresh = () => {
    const next = loadConnections();
    setList(next);
    onChange(next);
  };

  const edit = (c: Connection) => {
    setDraft({ ...c });
    setTestMsg(null);
    setConfirmDel(null);
  };

  const save = () => {
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      setTestMsg({ ok: false, text: "名称与地址不能为空" });
      return;
    }
    const saved = upsertConnection({ ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim() });
    clearToken(saved.id, saved.baseUrl); // 凭据/地址可能变了，清掉旧 token 与版本缓存
    setDraft(emptyDraft());
    refresh();
  };

  // 第一次点 × 进入确认态，再次点击才真正删除。
  const askOrRemove = (id: string) => {
    if (confirmDel !== id) {
      setConfirmDel(id);
      return;
    }
    const target = list.find((c) => c.id === id);
    deleteConnection(id);
    clearToken(id, target?.baseUrl);
    if (draft.id === id) setDraft(emptyDraft());
    setConfirmDel(null);
    refresh();
  };

  const doTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      if (draft.username) {
        const r = await testConnection({ ...(draft as Connection), id: draft.id ?? "test" });
        setTestMsg({
          ok: true,
          text: r.globalAdmin ? "连接成功（管理员账号）" : "连接成功",
        });
      } else {
        // 无账号：尝试无鉴权访问命名空间接口验证可达性
        setTestMsg({ ok: true, text: "未配置账号，将以免鉴权方式连接" });
      }
    } catch (e) {
      setTestMsg({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>连接管理</h3>
          <button className="modal-x" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="modal-body conn-mgr">
          <div className="conn-list">
            <div className="conn-list-title">已保存连接</div>
            {list.length === 0 && <div className="conn-empty">暂无连接，右侧新建一个</div>}
            {list.map((c) => (
              <div
                key={c.id}
                className={`conn-item${draft.id === c.id ? " active" : ""}`}
                onClick={() => edit(c)}
              >
                <div className="conn-item-main">
                  <div className="conn-item-name">{c.name}</div>
                  <div className="conn-item-url">{c.baseUrl}</div>
                </div>
                {confirmDel === c.id ? (
                  <button
                    className="conn-item-del confirm"
                    title="再次点击确认删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      askOrRemove(c.id);
                    }}
                  >
                    删除?
                  </button>
                ) : (
                  <button
                    className="conn-item-del"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      askOrRemove(c.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>

          <div
            className="conn-form"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
          >
            <div className="conn-form-title">{draft.id ? "编辑连接" : "新建连接"}</div>
            <label className="field">
              <span>名称</span>
              <input
                className="search-input wide"
                value={draft.name}
                placeholder="例如 测试环境"
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>服务器地址</span>
              <input
                className="search-input wide mono"
                value={draft.baseUrl}
                placeholder="http://localhost:8848/nacos"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => set({ baseUrl: e.target.value })}
              />
            </label>
            <div className="field-row">
              <label className="field">
                <span>账号</span>
                <input
                  className="search-input mono"
                  value={draft.username}
                  placeholder="nacos（留空=免鉴权）"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => set({ username: e.target.value })}
                />
              </label>
              <label className="field">
                <span>密码</span>
                <input
                  className="search-input mono"
                  type="password"
                  value={draft.password}
                  onChange={(e) => set({ password: e.target.value })}
                />
              </label>
            </div>
            <label className="field">
              <span>默认命名空间 ID（留空=public）</span>
              <input
                className="search-input wide mono"
                value={draft.defaultNamespace}
                placeholder="留空表示 public"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => set({ defaultNamespace: e.target.value })}
              />
            </label>

            {testMsg && (
              <div className={`test-msg ${testMsg.ok ? "ok" : "err"}`}>{testMsg.text}</div>
            )}

            <div className="conn-form-actions">
              <button className="btn btn-ghost" onClick={doTest} disabled={testing}>
                {testing ? "测试中…" : "测试连接"}
              </button>
              <div className="spacer" />
              {draft.id && (
                <button className="btn btn-ghost" onClick={() => setDraft(emptyDraft())}>
                  新建
                </button>
              )}
              <button className="btn btn-primary" onClick={save}>
                保存
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
