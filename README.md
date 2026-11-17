# 快传 · 零依赖的点对点文件直传

两台设备打开同一个网页，输入房间码即可互传文件。文件通过 WebRTC DataChannel 在浏览器之间**直连传输**，服务端只负责牵线（交换信令），既不入库也不中转文件内容。当直连不通时，会自动降级为经服务器中转。

## 特性

- **零依赖**：服务端只用 Node.js 内置模块，不需要 `npm install`
- **点对点直传**：文件不经过服务器，不落盘，理论上没有大小上限
- **房间码**：6 位大小写字母/数字，输入相同房间码即可互连，单房间最多 8 台设备
- **双信令通道**：优先 WebSocket，被网关拦截时自动切换为 HTTP 长轮询
- **中转兜底**：P2P 打不通时自动改用服务器中转（单文件上限 4 GB，临时文件 30 分钟后过期）
- **断线重连**：掉线后 90 秒内用原令牌回来可恢复房间
- **局域网可用**：启动后终端会打印局域网地址，发给同事即可在同一 Wi-Fi 下互传

## 快速开始

需要 Node.js 16+（推荐 LTS）。

```bash
git clone https://github.com/jeanyan666/quick_send.git
cd quick_send
node server.js
```

浏览器打开 <http://localhost:8787>。另一台设备访问终端打印的局域网地址（如 `http://192.168.1.20:8787`）。

Windows 用户可直接双击 `start.cmd`，脚本会检查 Node.js 并自动打开浏览器。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |

```bash
PORT=9000 node server.js
```

## 使用方法

1. 一端点击「创建房间」，得到 6 位房间码
2. 另一端输入房间码加入
3. 连接建立后选择文件发送；接收端可选择保存位置，边写盘边传输
4. 多人加入同一房间后，文件会经服务器分发给其他成员

> 浏览器不支持 `showSaveFilePicker` 时（如 Safari），接收的文件会先进入内存再触发下载，建议单文件 ≤ 500 MB。

## 技术原理

| 层次 | 实现 |
| --- | --- |
| 静态托管 | `server.js` 用原生 `http` 模块托管 `public/index.html`，并处理目录穿越防护、MIME 类型 |
| 信令 | 自研极简 WebSocket（RFC 6455 子集）；`/api/sig/open`、`/api/sig/send`、`/api/sig/poll` 提供 HTTP 轮询降级 |
| 房间管理 | 内存 Map 维护 host/guest/others，token 机制支持断线恢复 |
| 文件传输 | WebRTC DataChannel，STUN 服务器辅助打洞；分片大小自适应 SCTP `maxMessageSize`（上限 128 KB） |
| 中转通道 | `/relay/upload`、`/relay/file`、`/relay/cancel`，文件写入系统临时目录 `kuaichuan-relay`，TTL 30 分钟 |

服务端启动的 WebSocket 和轮询都只交换 SDP / ICE 等信令，**文件内容不经过服务端**（除非走中转兜底）。

## 部署

这是一个单端口 HTTP 服务，监听 `PORT` 并绑定 `0.0.0.0`，可直接托管到支持 Node.js 的平台。

```bash
PORT=3000 node server.js
```

公网部署需要注意：

- WebRTC 要求安全上下文，非 localhost 的 HTTP 站点浏览器会拒绝 `RTCPeerConnection`，应使用 HTTPS
- 反向代理需支持 WebSocket 升级；不支持时前端会自动降级为 HTTP 轮询
- `GET /health` 可用于健康检查，返回 `{"ok":true,"rooms":N,"uptime":秒}`

## 限制

- 仅配置 STUN，**没有 TURN 服务器**。对称 NAT 或严格企业网络下可能无法直连，会退到服务器中转
- 中转文件最大 4 GB，且依赖服务端临时磁盘空间
- 房间信息保存在内存中，进程重启后所有房间失效
- 服务端不提供鉴权或持久化，适合临时、小范围使用

## 目录结构

```
.
├── server.js          # 服务端：静态托管 + 信令 + 中转
├── public/
│   └── index.html     # 前端单页：房间 UI + WebRTC + 信令客户端
└── start.cmd          # Windows 一键启动脚本
```

## License

[MIT](LICENSE) © 2026 jeanyan666
