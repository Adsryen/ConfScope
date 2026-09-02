# J1 SSH 真机测试密钥对

用于 J1（SSH 隧道建立/测试/停止）的 Node 侧 ssh2 真实握手断言。

- 容器：`confscope-retest-sshd2`（`lscr.io/linuxserver/openssh-server`，`-p 2223:22`）
- 用户：`retuser`（`USER_PASSWORD=ret-test`，密码认证被容器镜像禁用，仅密钥认证）
- 公钥已写入容器 `/config/.ssh/authorized_keys`

## 用法

```bash
# 手动验证
ssh -i tests/retest/ssh-keys/id_ed25519 -p 2223 -o StrictHostKeyChecking=no \
  retuser@127.0.0.1 "echo hello"

# Playwright 侧（Node ssh2）
const { Client } = require("ssh2");
const c = new Client();
c.connect({
  host: "127.0.0.1", port: 2223,
  username: "retuser",
  privateKey: fs.readFileSync("tests/retest/ssh-keys/id_ed25519"),
});
```

## 容器重建后

```bash
docker run -d --name confscope-retest-sshd2 -p 2223:22 \
  -e USER_NAME=retuser -e USER_PASSWORD=ret-test \
  lscr.io/linuxserver/openssh-server:latest
# 等待 10s 后写入公钥：
docker cp tests/retest/ssh-keys/id_ed25519.pub confscope-retest-sshd2:/config/.ssh/authorized_keys
docker exec confscope-retest-sshd2 chown retuser:retuser /config/.ssh/authorized_keys
```
