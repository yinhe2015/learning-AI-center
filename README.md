# Codex 工作台

在一台 Mac 上运行的多用户 Codex 网页工作台。用户自助注册，在各自的项目里使用 Codex、上传资料和预览网站。所有网页账户共用宿主 Mac 上的 Codex 登录和模型用量。

[第一版需求](prompt.txt)

## 启动工作台

需要 macOS、Node.js 24 或更高版本，以及已安装的 Codex CLI。本项目已用 Codex CLI 0.171.0 验证。局域网模式还需要终端能找到 `openssl`。

在项目目录执行 `codex login status` 检查登录。工作台需要可读取的 Codex 登录文件，默认位于 `~/.codex/auth.json`，也可从 `CODEX_HOME` 指定的目录读取。

| 访问方式 | 启动命令 | 浏览器入口 |
| --- | --- | --- |
| 宿主 Mac | `npm start` | [http://127.0.0.1:8765](http://127.0.0.1:8765) |
| 同一局域网的设备 | `npm run start:lan` | 终端显示的 `https://<Mac 的局域网地址>:8765`。本机入口也可用。 |

局域网设备首次访问时，从宿主 Mac 复制终端显示的公开证书 `ca.crt`，并在客户端设为受信任。默认路径是 `.workbench-data/tls/ca/ca.crt`。工作台和项目预览使用同一个证书颁发机构。私钥 `ca.key` 保存在宿主机。 [macOS 证书信任说明](https://support.apple.com/guide/keychain-access/kyca11871/mac)

## 项目、对话与附件

1. 打开工作台，注册或登录。
2. 创建项目和会话，输入消息。Codex 的输出会实时显示，可用「规划模式」先讨论方案。
3. 普通问句直接用聊天消息回复。执行中的结构化提问会显示答题卡，提交后原运行继续。刷新页面可以重新打开仍待回答的问题。
4. 点击「项目文件」可浏览项目目录、预览 UTF-8 文本，或上传资料。对话里的「添加附件」会把资料上传到当前项目并附到下一条消息。已经上传的资料也可以从项目文件里选中并附到消息。

PNG、JPEG、WebP 图片可以预览并作为视觉输入发给 Codex。其他资料保留原文件，Codex 可按项目相对路径读取。

| 上传限制 | 上限 |
| --- | --- |
| 单个普通文件 | 25 MiB |
| 单张支持的图片 | 10 MiB |
| 单条消息 | 6 个附件，图片总计 20 MiB |
| 单个项目 | 512 MiB |

## 预览项目网页

选中项目，点击「项目预览」，选择启动方式，然后点击「启动预览」和「打开预览」。

| 网站类型 | 启动方式 |
| --- | --- |
| 静态主页或已构建的网站 | 选择「静态页面」，填写 `dist` 等项目相对目录。留空时依次在项目根目录、`dist`、`build`、`out` 和 `public` 查找 `index.html`。 |
| Node Web 服务 | 选择「启动 Web 服务」，填写 `npm run dev` 等前台命令。项目需已具备运行所需依赖，预览支持一个 HTTP 监听器。 |
| 支持 Unix Socket 的其他服务 | 在启动命令中使用工作台提供的 `$WORKBENCH_PREVIEW_SOCKET`。例如 `uvicorn app:app --uds "$WORKBENCH_PREVIEW_SOCKET"`。 |

局域网模式给每个运行中的项目预览分配独立的 HTTPS 端口，默认范围为 `49152–49215`。从远程设备打开预览时，请用工作台生成的完整链接，客户端需要能连接到该端口。仅本机模式下的预览链接只在宿主 Mac 上使用。

预览进程独立于 Codex 对话，关闭会话后仍会运行。点击「停止预览」或关闭工作台会结束进程。工作台重启后需要重新启动预览。

## 局域网域名与端口

如果局域网 DNS 中已有指向这台 Mac 的域名，可用下面的命令启动。将示例域名换成你的域名。

```bash
WORKBENCH_LAN_HOSTNAME=codex.example.com npm run start:lan
```

生成的证书包含 Mac 的局域网 IP 和配置的域名。通过域名打开工作台时，预览链接也会使用该域名。若使用端口映射或反向代理，客户端必须能经过同一入口访问分配给预览的端口。工作台和项目预览使用各自的端口。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `PORT` | 工作台端口 | `8765` |
| `WORKBENCH_LAN_ADDRESS` | 选择 Mac 上已启用的局域网 IPv4 地址 | 默认路由接口的私有 IPv4 地址 |
| `WORKBENCH_LAN_HOSTNAME` | 已解析到 Mac 的局域网域名，填写纯域名 | 使用局域网 IP |
| `WORKBENCH_PREVIEW_PORTS` | 局域网预览端口范围，格式为 `起始端口-结束端口` | `49152-49215` |
| `WORKBENCH_DATA_DIR` | 数据目录 | 本仓库下的 `.workbench-data/` |
| `WORKBENCH_CODEX` | 工作台调用的 Codex 可执行文件 | `codex` |

## 数据与权限

| 路径 | 内容 |
| --- | --- |
| `.workbench-data/workbench.sqlite` | 网页账户、登录会话、项目和对话记录、附件索引 |
| `.workbench-data/workspaces/<用户 ID>/<项目 ID>/` | 项目文件。上传的资料保存在项目内的 `.workbench-uploads/` |
| `.workbench-data/codex/` | 工作台专用的 Codex 运行数据、对话状态和导入的凭据 |
| `.workbench-data/tls/ca/` | 局域网公开证书和对应的私钥 |

工作台按账户和项目检查资源归属。每个项目同一时间可运行一轮 Codex 对话。命令和预览进程使用 macOS 文件沙盒，项目内的上传资料对 Codex 命令为只读，项目命令的直接网络访问和权限提升关闭。工作台在沙盒外管理预览的 HTTPS 端口。
