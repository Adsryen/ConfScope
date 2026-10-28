//go:build linux

package securestore

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"math/big"
	"os"

	"github.com/godbus/dbus/v5"
	"golang.org/x/crypto/hkdf"
)

// Linux 系统凭据库 = Secret Service（libsecret 的 D-Bus 规范），纯 Go D-Bus 客户端，
// 不依赖 cgo。协议按 gnome-keyring 46 的 introspection 实测：
//   - OpenSession 用 dh-ietf1024-sha256-aes128-cbc-pkcs7（RFC 2409 Oakley Group 2，
//     DH 共享密钥经 HKDF-SHA256 派生 AES-128 会话密钥，密文为 AES-CBC + PKCS7）；
//   - secret 元组为 (o session, ay param, ay content, s content_type)；
//   - CreateItem 的 properties 用全限定键 org.freedesktop.Secret.Item.Label / .Attributes。
// 不支持 DH 会话的实现回退 plain 会话（明文 content，由密钥环守护进程自行保护内存与文件）；
// 两者都不可用时报 ErrSecretServiceUnavailable，绝不把明文写进数据目录冒充已加密。

const (
	storageKindSecretService = "secret-service"

	secretServiceName     = "org.freedesktop.secrets"
	secretServicePath     = "/org/freedesktop/secrets"
	secretServiceIface    = "org.freedesktop.Secret.Service"
	secretCollectionIface = "org.freedesktop.Secret.Collection"
	secretItemIface       = "org.freedesktop.Secret.Item"

	secretSessionAlgorithmAES   = "dh-ietf1024-sha256-aes128-cbc-pkcs7"
	secretSessionAlgorithmPlain = "plain"

	// secretServiceAttributeTarget 是我们写入 Item.Attributes 的唯一检索键，
	// 值就是 TargetName()：目标名全局唯一，检索不用拼多键。
	secretServiceAttributeTarget = "confscope-target"
)

// RFC 2409 / Oakley Group 2（ietf-ike-grp-modp-1024）素数，与 libsecret egg-dh.c 一致。
var dhPrime = new(big.Int).SetBytes([]byte{
	0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xC9, 0x0F, 0xDA, 0xA2, 0x21, 0x68, 0xC2, 0x34,
	0xC4, 0xC6, 0x62, 0x8B, 0x80, 0xDC, 0x1C, 0xD1, 0x29, 0x02, 0x4E, 0x08, 0x8A, 0x67, 0xCC, 0x74,
	0x02, 0x0B, 0xBE, 0xA6, 0x3B, 0x13, 0x9B, 0x22, 0x51, 0x4A, 0x08, 0x79, 0x8E, 0x34, 0x04, 0xDD,
	0xEF, 0x95, 0x19, 0xB3, 0xCD, 0x3A, 0x43, 0x1B, 0x30, 0x2B, 0x0A, 0x6D, 0xF2, 0x5F, 0x14, 0x37,
	0x4F, 0xE1, 0x35, 0x6D, 0x6D, 0x51, 0xC2, 0x45, 0xE4, 0x85, 0xB5, 0x76, 0x62, 0x5E, 0x7E, 0xC6,
	0xF4, 0x4C, 0x42, 0xE9, 0xA6, 0x37, 0xED, 0x6B, 0x0B, 0xFF, 0x5C, 0xB6, 0xF4, 0x06, 0xB7, 0xED,
	0xEE, 0x38, 0x6B, 0xFB, 0x5A, 0x89, 0x9F, 0xA5, 0xAE, 0x9F, 0x24, 0x11, 0x7C, 0x4B, 0x1F, 0xE6,
	0x49, 0x28, 0x66, 0x51, 0xEC, 0xE6, 0x53, 0x81, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
})

var dhGenerator = big.NewInt(2)

// secretServiceClient 是一个进程内一次操作的 D-Bus 客户端。
// 每次 Put/Get/Delete 独立连接、用后即关，与 secret-tool 等命令行工具同口径，
// 避免长期持有连接带来的会话/守护进程状态问题。
type secretServiceClient struct {
	conn *dbus.Conn
}

func newSecretServiceClient() (*secretServiceClient, error) {
	// SessionBusPrivate 每次新建连接（SessionBus 会全局缓存，
	// 缓存会在「有服务→无服务」的环境变化后给出过期结果）。
	// 不用 SessionBusPrivate：它只做 Dial，Auth/Hello 握手没完成，第一个方法
	// 调用的消息会被总线守护丢弃，等回包必然死锁。Connect 走完整的
	// Dial+Auth+Hello，且每次新建连接、不经 SessionBus 的全局缓存
	// （缓存在「有服务→无服务」的环境变化后给出过期连接，破坏
	// 不可用路径测试的确定性）。
	addr := os.Getenv("DBUS_SESSION_BUS_ADDRESS")
	if addr == "" || addr == "autolaunch:" {
		return nil, fmt.Errorf("%w：未设置 DBUS_SESSION_BUS_ADDRESS", ErrSecretServiceUnavailable)
	}
	conn, err := dbus.Connect(addr)
	if err != nil {
		return nil, fmt.Errorf("%w：无法连接 D-Bus 会话总线（%v）", ErrSecretServiceUnavailable, err)
	}
	if err := conn.BusObject().Call("org.freedesktop.DBus.GetNameOwner", 0, secretServiceName).Err; err != nil {
		_ = conn.Close()
		return nil, ErrSecretServiceUnavailable
	}
	return &secretServiceClient{conn: conn}, nil
}

func (c *secretServiceClient) close() {
	if c != nil && c.conn != nil {
		_ = c.conn.Close()
	}
}

func (c *secretServiceClient) service() dbus.BusObject {
	return c.conn.Object(secretServiceName, secretServicePath)
}

// secretSession 是一次 OpenSession 的结果；key 为空表示 plain 会话。
type secretSession struct {
	path dbus.ObjectPath
	key  []byte
}

func (c *secretServiceClient) openSession() (*secretSession, error) {
	if session, err := c.openAESSession(); err == nil {
		return session, nil
	} else {
		aesErr := err
		if session, err := c.openPlainSession(); err == nil {
			return session, nil
		} else {
			return nil, fmt.Errorf("secret service 会话打开失败（AES 会话: %v；plain 会话: %v）", aesErr, err)
		}
	}
}

func (c *secretServiceClient) openAESSession() (*secretSession, error) {
	priv, pub := dhKeyPair()
	reply := c.service().Call(secretServiceIface+".OpenSession", 0, secretSessionAlgorithmAES, dbus.MakeVariant(pub.Bytes()))
	if reply.Err != nil {
		return nil, reply.Err
	}
	var outVariant dbus.Variant
	var path dbus.ObjectPath
	if err := dbus.Store(reply.Body, &outVariant, &path); err != nil {
		return nil, err
	}
	peerPub, ok := outVariant.Value().([]byte)
	if !ok {
		return nil, fmt.Errorf("OpenSession 返回的对方公钥类型不符: %T", outVariant.Value())
	}
	shared := new(big.Int).Exp(new(big.Int).SetBytes(peerPub), priv, dhPrime)
	// 会话密钥 = HKDF-SHA256(ikm=共享密钥, salt=空, info=空, L=16)，与 libsecret 一致。
	key := make([]byte, 16)
	if _, err := hkdf.New(sha256.New, shared.Bytes(), nil, nil).Read(key); err != nil {
		return nil, err
	}
	return &secretSession{path: path, key: key}, nil
}

func (c *secretServiceClient) openPlainSession() (*secretSession, error) {
	reply := c.service().Call(secretServiceIface+".OpenSession", 0, secretSessionAlgorithmPlain, dbus.MakeVariant([]byte{}))
	if reply.Err != nil {
		return nil, reply.Err
	}
	var outVariant dbus.Variant
	var path dbus.ObjectPath
	if err := dbus.Store(reply.Body, &outVariant, &path); err != nil {
		return nil, err
	}
	return &secretSession{path: path}, nil
}

// seal 把明文编码成 secret 元组的 (param, content)；plain 会话 param 为空、content 即明文。
func (s *secretSession) seal(value []byte) (param, content []byte, err error) {
	if s.key == nil {
		return nil, append([]byte(nil), value...), nil
	}
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return nil, nil, fmt.Errorf("生成会话随机 IV 失败: %w", err)
	}
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, nil, err
	}
	padded := pkcs7Pad(value)
	content = make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(content, padded)
	return iv, content, nil
}

func (s *secretSession) open(param, content []byte) ([]byte, error) {
	if s.key == nil {
		return append([]byte(nil), content...), nil
	}
	if len(content) == 0 || len(content)%aes.BlockSize != 0 {
		return nil, errors.New("secret service 返回的密文长度不符合 AES-CBC")
	}
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return nil, err
	}
	plain := make([]byte, len(content))
	cipher.NewCBCDecrypter(block, param).CryptBlocks(plain, content)
	return pkcs7Unpad(plain)
}

// secretTuple 对应规范里的 (o session, ay param, ay content, s content_type)。
type secretTuple struct {
	Session     dbus.ObjectPath
	Param       []byte
	Content     []byte
	ContentType string
}

func (c *secretServiceClient) defaultCollectionPath() (dbus.ObjectPath, error) {
	reply := c.service().Call(secretServiceIface+".ReadAlias", 0, "default")
	if reply.Err != nil {
		return "", fmt.Errorf("读取默认凭据集合失败: %w", reply.Err)
	}
	var path dbus.ObjectPath
	if err := dbus.Store(reply.Body, &path); err != nil {
		return "", err
	}
	return path, nil
}

func (c *secretServiceClient) searchItems(target string) (unlocked, locked []dbus.ObjectPath, err error) {
	reply := c.service().Call(secretServiceIface+".SearchItems", 0, map[string]string{secretServiceAttributeTarget: target})
	if reply.Err != nil {
		return nil, nil, fmt.Errorf("检索凭据失败: %w", reply.Err)
	}
	if err := dbus.Store(reply.Body, &unlocked, &locked); err != nil {
		return nil, nil, err
	}
	return unlocked, locked, nil
}

func (c *secretServiceClient) put(target string, value []byte) error {
	session, err := c.openSession()
	if err != nil {
		return err
	}
	param, content, err := session.seal(value)
	if err != nil {
		return err
	}
	collection, err := c.defaultCollectionPath()
	if err != nil {
		return err
	}
	properties := map[string]dbus.Variant{
		"org.freedesktop.Secret.Item.Label":      dbus.MakeVariant(target),
		"org.freedesktop.Secret.Item.Attributes": dbus.MakeVariant(map[string]string{secretServiceAttributeTarget: target}),
	}
	tuple := secretTuple{Session: session.path, Param: param, Content: content, ContentType: "text/plain"}
	reply := c.conn.Object(secretServiceName, collection).Call(secretCollectionIface+".CreateItem", 0, properties, tuple, true)
	if reply.Err != nil {
		return fmt.Errorf("写入 secret service 失败: %w", reply.Err)
	}
	var item, prompt dbus.ObjectPath
	if err := dbus.Store(reply.Body, &item, &prompt); err != nil {
		return err
	}
	if prompt != "" && prompt != "/" {
		return fmt.Errorf("secret service 要求交互解锁后才能写入（%s），无法自动完成", prompt)
	}
	return nil
}

func (c *secretServiceClient) get(target string) ([]byte, error) {
	unlocked, locked, err := c.searchItems(target)
	if err != nil {
		return nil, err
	}
	if len(locked) > 0 {
		return nil, errors.New("凭据所在凭据集合处于锁定状态，解锁后重试")
	}
	if len(unlocked) == 0 {
		return nil, ErrSecretNotFound
	}
	session, err := c.openSession()
	if err != nil {
		return nil, err
	}
	reply := c.service().Call(secretServiceIface+".GetSecrets", 0, []dbus.ObjectPath{unlocked[0]}, session.path)
	if reply.Err != nil {
		return nil, fmt.Errorf("读取 secret service 凭据失败: %w", reply.Err)
	}
	var secrets map[dbus.ObjectPath]secretTuple
	if err := dbus.Store(reply.Body, &secrets); err != nil {
		return nil, err
	}
	tuple, ok := secrets[unlocked[0]]
	if !ok {
		return nil, ErrSecretNotFound
	}
	// 服务侧负责把旧会话绑定的 secret 换成当前会话重新加密返回。
	return session.open(tuple.Param, tuple.Content)
}

func (c *secretServiceClient) delete(target string) error {
	unlocked, locked, err := c.searchItems(target)
	if err != nil {
		return err
	}
	if len(unlocked) == 0 && len(locked) == 0 {
		return nil
	}
	if len(locked) > 0 {
		return errors.New("凭据所在凭据集合处于锁定状态，解锁后重试")
	}
	reply := c.conn.Object(secretServiceName, unlocked[0]).Call(secretItemIface+".Delete", 0)
	if reply.Err != nil {
		return fmt.Errorf("删除 secret service 凭据失败: %w", reply.Err)
	}
	var prompt dbus.ObjectPath
	if err := dbus.Store(reply.Body, &prompt); err != nil {
		return err
	}
	if prompt != "" && prompt != "/" {
		return fmt.Errorf("secret service 要求交互确认后才能删除（%s），无法自动完成", prompt)
	}
	return nil
}

func pkcs7Pad(data []byte) []byte {
	n := aes.BlockSize - len(data)%aes.BlockSize
	out := make([]byte, len(data)+n)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(n)
	}
	return out
}

func pkcs7Unpad(data []byte) ([]byte, error) {
	if len(data) == 0 || len(data)%aes.BlockSize != 0 {
		return nil, errors.New("PKCS7 填充长度不符")
	}
	n := int(data[len(data)-1])
	if n < 1 || n > aes.BlockSize {
		return nil, errors.New("PKCS7 填充值不符")
	}
	for i := len(data) - n; i < len(data); i++ {
		if int(data[i]) != n {
			return nil, errors.New("PKCS7 填充字节不符")
		}
	}
	return data[:len(data)-n], nil
}

func dhKeyPair() (priv, pub *big.Int) {
	for {
		value, err := rand.Int(rand.Reader, dhPrime)
		if err != nil {
			panic(fmt.Sprintf("生成 DH 私钥失败: %v", err))
		}
		if value.Sign() < 1 {
			continue
		}
		pub = new(big.Int).Exp(dhGenerator, value, dhPrime)
		if pub.Sign() < 1 {
			continue
		}
		return value, pub
	}
}

// secretServiceStore 同时是小凭据与大凭据的 Linux 实现：
// 两侧都落在系统密钥环（login 集合），目标名互相不重叠（connection/ 与 connection-ssh/ 前缀区分）。
type secretServiceStore struct{}

func newPlatformCredentialManagerStore() Store {
	return secretServiceStore{}
}

func newPlatformLargeStore(_ string) (LargeStore, error) {
	// 构造时探测一次：让「这台机器到底有没有 Secret Service」在迁移开始时就有定论，
	// 前端据此如实显示「未迁入」，而不是迁移到一半才逐个失败。
	if _, err := newSecretServiceClient(); err != nil {
		return nil, err
	}
	return secretServiceStore{}, nil
}

func (secretServiceStore) StorageKind() string {
	return storageKindSecretService
}

func (secretServiceStore) Put(ctx context.Context, ref SecretRef, value []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateSecretValue(value); err != nil {
		return err
	}
	client, err := newSecretServiceClient()
	if err != nil {
		return err
	}
	defer client.close()
	return client.put(ref.TargetName(), value)
}

func (secretServiceStore) Get(ctx context.Context, ref SecretRef) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	client, err := newSecretServiceClient()
	if err != nil {
		return nil, err
	}
	defer client.close()
	return client.get(ref.TargetName())
}

func (secretServiceStore) Delete(ctx context.Context, ref SecretRef) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	client, err := newSecretServiceClient()
	if err != nil {
		return err
	}
	defer client.close()
	return client.delete(ref.TargetName())
}

func (secretServiceStore) PutLarge(ctx context.Context, ref LargeRef, value []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateLargeSecretValue(value); err != nil {
		return err
	}
	client, err := newSecretServiceClient()
	if err != nil {
		return err
	}
	defer client.close()
	return client.put(ref.TargetName(), value)
}

func (secretServiceStore) GetLarge(ctx context.Context, ref LargeRef) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	client, err := newSecretServiceClient()
	if err != nil {
		return nil, err
	}
	defer client.close()
	return client.get(ref.TargetName())
}

func (secretServiceStore) DeleteLarge(ctx context.Context, ref LargeRef) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	client, err := newSecretServiceClient()
	if err != nil {
		return err
	}
	defer client.close()
	return client.delete(ref.TargetName())
}
