# -*- coding: utf-8 -*-
"""确保 retest 双 Nacos 环境所需的命名空间存在（幂等）。

为什么需要这个脚本：持久容器（confscope-retest-nacos-a/b）的命名空间
retest-dev / retest-qa 当初是手工在控制台建的，仓库里没有任何地方能把它重建出来。
空容器上直接跑 publish.py 会写进一个「不存在的 tenant」，而应用侧看到的是半截现场
（真机读数 2026-10-27，A 容器 19848，临时命名空间 ghost-probe-1793045769 / ghost3-1793046186）：
POST /v1/cs/configs 返回 true；紧接着精确 GET 是 404，约 0.5s 后同一读法变成 200 且内容一致
（配置缓存还没来得及加载这套未注册租户，读法与时序都在骗人）；blur 列表 totalCount=1；
而 /v1/console/namespaces 到多久都列不出这个命名空间（读数 ['', 'retest-dev', 'x']）。
对照同一容器已注册的 retest-dev：精确读回 200、blur 列表 totalCount=16、并且列得出来。
失真点就在最后这一条：应用的浏览页以命名空间列表为作用域入口，租户列不出来，
里面的配置就在 UI 里不可达——写库看起来成功了，浏览/对比/搜索全部读不到它。
所以建库必须显式、幂等，并在创建后回读确认命名空间列得出来。

用法：
    python3 init-namespaces.py                 # 按 ENVS 幂等建齐（A: retest-dev；B: retest-qa），
                                             # 并复核 A 侧没有 retest-qa（用例前提）
    python3 init-namespaces.py --self-test     # 真建真删一枚临时命名空间，验证 API 通路
    # 谁该跑它：本机首次搭环境、以及 .github/workflows/retest.yml 的「Ensure namespaces
    # and seed retest data」步骤（空容器上 publish.py 之前必须先过这一关）。

退出码：0 成功（含「已存在」），1 失败（打印原因）。
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# 与 tests/retest/state.ts 的 DEFAULT_STATE 对齐（端口/基准命名空间的事实源在 state.ts，
# 这里镜像它的两个 Nacos 端点；改那边必须同步改这里）。
#
# 每侧要建哪些命名空间，来自用例的真实前提（不是容器里恰好残留了什么）：
#   A：retest-dev（来源侧）——**只有这一个**。
#   B：retest-qa（沙箱/目标侧）。
# A 侧必须没有 retest-qa。这条闸门原本是 98-remaining E4 与 99-s-promote-entry S31 的前提：
# 它们的晋级目标是 A/retest-qa，而 retest-qa 在 A 上是个「还不存在的租户」，
# 用例验的正是产品能力「沿用沙箱命名空间 → 提示晋级会新建它，而不是覆盖同名配置」。
# 写后晋级入口已撤除，两条用例改为只判「目标侧落库范围」与「入口缺席」，这条前提失去了用例级消费者。
# 闸门先留着守住「每侧一套租户」的环境基线：A 上一旦多出同名租户，命名空间候选与 dataId 取数
# 集合就和用例里写死的读数不同；要真删它，先按下面的反证办法跑一遍，别凭推理。
# 真机读数（/tmp/cs/r84-full-retest.log:12564，A 侧无 retest-qa，全批 168 passed）：
#   [E4] 命名空间提醒读数 = ["retest-qa 在 Retest Nacos A 上不是已有的命名空间：晋级会新建它……"]
# 反证（/tmp/cs/r87-full-retest.log:25467，本脚本曾把 retest-qa 建到 A 上，S31 红）：
#   Locator: .apply-promote-panel .apply-promote-namespace .apply-promote-namespace-note
#   Expected substring: "retest-qa 在 Retest Nacos A 上不是已有的命名空间"
#   Error: element(s) not found        ← 目标上租户已存在 ⇒ 产品如实不提示 ⇒ 用例必红
# 至于「A 缺 retest-qa 会让 E4 回读失败」：不成立，已被上面那条 168 passed 的读数证伪
# （E4 的 overrideAReQaGateway/publishAExtraMarker 直接 POST tenant=retest-qa，
# 未注册租户照样写进去并精确读回 200，见本文件开头 ghost-probe 的实测）。
# 结论：改 ENVS 前先跑一次反证——把它删掉，看相关用例是否还绿，别凭推理给测试环境补数据。
# 这条基线由 MUST_NOT_EXIST 把关：A 上一旦出现 retest-qa，脚本直接非 0 退出，
# 而不是让按命名空间列表取数的用例在批里红成「产品坏了」。
ENVS = {
    "a": ("http://127.0.0.1:19848/nacos", ["retest-dev"]),
    "b": ("http://127.0.0.1:19849/nacos", ["retest-qa"]),
}
DESC = "ConfScope retest"

# 断言「必须不存在」的命名空间：环境基线，每侧只一套租户（见上面那段来历）。
# 旧的晋级用例靠它验「目标上这套租户不存在 ⇒ 会新建它」的提醒，那套入口已撤除；
# 现在它的作用是拦住「有人往 A 的同名租户里写了数据」这类环境漂移。
# 与 ENVS 同为一处口径，改这里必须一起改上面那段实测。
MUST_NOT_EXIST = {"a": ["retest-qa"]}


def list_namespaces(base):
    with urllib.request.urlopen(f"{base}/v1/console/namespaces", timeout=10) as r:
        payload = json.load(r)
    return [n.get("namespace", "") for n in payload.get("data", [])]


def create_namespace(base, ns_id):
    form = urllib.parse.urlencode(
        {"customNamespaceId": ns_id, "namespaceName": ns_id, "namespaceDesc": DESC}
    ).encode()
    req = urllib.request.Request(f"{base}/v1/console/namespaces", data=form, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read().decode()
    if body != "true":
        raise RuntimeError(f"create namespace {ns_id} failed: {body}")


def delete_namespace(base, ns_id):
    req = urllib.request.Request(
        f"{base}/v1/console/namespaces?{urllib.parse.urlencode({'namespaceId': ns_id})}",
        method="DELETE",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read().decode()
    if body != "true":
        raise RuntimeError(f"delete namespace {ns_id} failed: {body}")


def wait_ready(base, timeout_s=180):
    """等 Nacos readiness。空容器冷启动 30~90s 是常态，不能靠 sleep 猜。"""
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base}/v1/console/health/readiness", timeout=5) as r:
                if r.status == 200:
                    return True
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
        except Exception as e:  # 连接被拒/超时都算「还没起来」
            last = repr(e)
        time.sleep(2)
    raise RuntimeError(f"nacos at {base} not ready within {timeout_s}s (last: {last})")


def ensure_all():
    for side, (base, namespaces) in ENVS.items():
        wait_ready(base)
        existing = list_namespaces(base)
        for ns in namespaces:
            if ns in existing:
                print(f"[{side}] namespace {ns} 已存在，跳过")
                continue
            create_namespace(base, ns)
            # 写完必须回读：v1 返回 true 不代表列得出来（这正是静默假成功的地方）
            after = list_namespaces(base)
            if ns not in after:
                raise RuntimeError(f"[{side}] 创建后回读不到 {ns}：{after}")
            print(f"[{side}] 已创建命名空间 {ns}（回读确认）")


def review():
    """复核两侧读数：该建的必须列得出来，该没有的一秒都不能有。"""
    for side, (base, namespaces) in ENVS.items():
        have = set(list_namespaces(base))
        missing = [ns for ns in namespaces if ns not in have]
        if missing:
            raise RuntimeError(f"[{side}] 收尾复核仍缺命名空间：{missing}（现有 {sorted(have)}）")
        banned = [ns for ns in MUST_NOT_EXIST.get(side, []) if ns in have]
        if banned:
            raise RuntimeError(
                f"[{side}] 出现了环境基线要求「不存在」的命名空间：{banned}（现有 {sorted(have)}）。"
                "每侧只一套租户是这批用例读数的地基；A 上的 retest-qa 是旧写后晋级用例的残留落点，"
                f"留着它，命名空间候选与 dataId 取数的集合就和用例写死的预期不一致。删掉它：DELETE {{base}}"
                "/v1/console/namespaces?namespaceId=" + banned[0] + "（先清里面的配置再删租户）"
            )
        print(f"[{side}] 复核通过：{sorted(have)}")


def self_test():
    """真建真删一枚临时命名空间，证明 API 通路在当前容器上可用。"""
    ns = f"ci-selftest-{int(time.time())}"
    for side, (base, _) in ENVS.items():  # 每侧建一枚同名命名空间再删掉
        wait_ready(base)
        create_namespace(base, ns)
        if ns not in list_namespaces(base):
            raise RuntimeError(f"[{side}] 自建自检失败：创建后列不到 {ns}")
        delete_namespace(base, ns)
        if ns in list_namespaces(base):
            raise RuntimeError(f"[{side}] 删除后仍列得到 {ns}")
        print(f"[{side}] self-test ok（建/删 {ns} 均回读确认）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true", help="真建真删一枚临时命名空间验证通路")
    args = ap.parse_args()
    try:
        if args.self_test:
            self_test()
        else:
            ensure_all()
            review()
    except Exception as e:
        print(f"init-namespaces failed: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
