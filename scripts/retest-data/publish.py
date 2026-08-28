# -*- coding: utf-8 -*-
"""把生成的配置对发布到 A/B 两个 Nacos 容器。"""
import glob, os, urllib.parse, urllib.request

GEN = "generated"
ENDPOINTS = {
    "a": ("http://127.0.0.1:19848/nacos", "retest-dev"),
    "b": ("http://127.0.0.1:19849/nacos", "retest-qa"),
}
GROUP = "RETEST-PROD"

def publish(base, tenant, dataId, group, content, nacos_type):
    form = {
        "dataId": dataId,
        "group": group,
        "tenant": tenant,
        "content": content,
        "type": nacos_type,
    }
    data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(f"{base}/v1/cs/configs", data=data, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read().decode()
    assert body == "true", f"publish failed: {body}"

def list_configs(base, tenant):
    qs = urllib.parse.urlencode({"search":"blur","dataId":"","group":"","tenant":tenant,"pageNo":"1","pageSize":"200"})
    with urllib.request.urlopen(f"{base}/v1/cs/configs?{qs}", timeout=10) as r:
        import json
        d = json.load(r)
    return {i["dataId"]: i for i in d.get("pageItems", [])}

def delete_config(base, tenant, dataId, group):
    qs = urllib.parse.urlencode({"dataId":dataId,"group":group,"tenant":tenant})
    req = urllib.request.Request(f"{base}/v1/cs/configs?{qs}", method="DELETE")
    with urllib.request.urlopen(req, timeout=10) as r:
        body = r.read().decode()
    assert body == "true"

# 1) 删除旧的 8 个 retest-* 文件（两边）
old = ["retest-app.yaml","retest-app.json","retest-app.properties","retest-plain.txt","retest-only-a.yaml","retest-app.toml","retest-pair.toml","retest-edit-a.yaml","retest-only-b.yaml"]
for side,(base,tenant) in ENDPOINTS.items():
    existing = list_configs(base, tenant)
    for d in old:
        if d in existing:
            delete_config(base, tenant, d, existing[d]["group"])
            print(f"[{side}] deleted old {d}")

# 2) 发布 12 对新文件
results = []
for p in sorted(glob.glob(os.path.join(GEN, "*"))):
    name = os.path.basename(p)            # 00-svc-gateway.yaml.a
    dataId = name.rsplit(".",1)[0]       # 00-svc-gateway.yaml
    side = name[-1]                      # a/b
    realId = dataId.split("-",1)[1]      # svc-gateway.yaml
    ftype = realId.rsplit(".",1)[1]      # yaml
    nacos_type = {"yaml":"yaml","yml":"yaml","json":"json","properties":"properties","toml":"toml","env":"text"}.get(ftype, "text")
    base, tenant = ENDPOINTS[side]
    content = open(p).read()
    publish(base, tenant, realId, GROUP, content, nacos_type)
    print(f"[{side}] published {realId} ({nacos_type})")

# 3) 校验
for side,(base,tenant) in ENDPOINTS.items():
    items = list_configs(base, tenant)
    print(f"[{side}] total configs now: {len(items)} -> {sorted(items)}")
