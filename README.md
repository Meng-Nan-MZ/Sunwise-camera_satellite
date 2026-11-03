# Satellite Dataset Studio Web

浏览器本地版卫星图像与姿态数据工作台，当前版本 `0.1.0-web`。本目录是独立 Web 副本，开发分支为 `web/browser-local`。模型渲染、灰度图像处理、噪声、标注和 ZIP 打包均在本机浏览器执行，不需要 Python 服务，不上传帧图像。

## 本地启动

双击 `tools/start-web.cmd`。启动器校验本地模型文件，启动仅监听 `127.0.0.1:5173` 的静态开发服务，并打开浏览器。保持命令窗口和网页开启；关闭服务可在窗口按 Ctrl+C。端口被占用时会报错，不会悄悄切换到其他端口。

启动器优先使用系统 Node.js 22.18 或更新版本，也会尝试读取已安装的 `OpenAI.CodexPrimaryRuntime*` 包中的 Node.js。它直接调用本地 Node.js 和 Vite，无需在每次启动时找到 pnpm，不修改全局 PATH、系统设置，也不自动联网安装依赖。

首次使用源码或依赖尚未安装时，在 `apps/ui` 目录运行 `pnpm install --frozen-lockfile`；安装过程可能需要联网，须自行准备 Node.js 和 pnpm。GLB 模型体积较大，未提交到 Git，需保留本地 `assets/models/` 中与清单 SHA256 对应的文件。缺少模型或依赖时，启动器会显示具体错误，窗口会停留供阅读。

仅检查运行时、依赖和本地模型并准备静态资源，不启动服务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\start-web.ps1 -Check
```

## 采集与下载

支持单张、随机姿态批量、自动旋转序列、自定义起止姿态序列。距离固定在 10–30 km，默认 20 km；每任务最多 500 帧，自定义起止序列至少 2 帧。所有模式共用页面设置、校验和任务控制器，任务串行运行，可取消并保留完整帧。

正式图像为 **1024×1024、8 位灰度 PNG**，同时生成 YOLO 标签及 WXYZ 姿态 JSON。ZIP 包含：

- `job.json`：采集设置、任务状态、算法版本和已包含帧；取消或失败任务标记为部分结果。
- `images_clean/`、`images_noisy/`：原图及启用噪声后的图像。
- `labels/`、`poses/`：每帧 YOLO 标签及 `satellite-pose-4.0` 姿态。
- `noise_meta/`：追加噪声版本的参数、种子、原图哈希与来源关联。

先点击准备 ZIP，再点击页面中的保存链接，由浏览器保存到电脑。准备操作本身不会自动下载文件；保存位置由浏览器的下载设置或保存对话框决定。

已完成的采集任务可追加噪声版本，复用原图和像素，不重新渲染，保留原始姿态与标签。移除原图任务前须先移除其噪声版本。模型来源、许可和尺度信息来自现有模型清单；未独立校准的素材不应视为真实卫星工程尺寸。

## 会话与计算限制

图像和任务仅保存在当前网页内存中，**刷新、关闭页面或开发热更新会丢失会话结果**；请及时下载。没有后台持久化、断点续跑或跨浏览器任务恢复。输出保留量最多 256 MiB，ZIP 输出也有 256 MiB 上限；删除已下载任务可释放会话存储。浏览器还需要额外渲染、处理和打包内存，实际可用数量受设备 RAM、WebGL 和显卡能力限制。

正式采集使用固定 Three.js 渲染配置，图像处理记录浏览器 Lanczos 灰度算法版本，噪声记录浏览器随机数与采样算法版本。相同浏览器算法和参数可用于复现；**不宣称与 Python/NumPy 或桌面版相同种子逐像素等同**。姿态和坐标沿用左手世界系与 `{W,X,Y,Z}` 主动四元数约定，辅助坐标轴不进入正式图像。

## WebMCP 与 AI

工作台不包含 AI 模型，不需要 API Key，也没有模拟聊天。浏览器或外部智能体如果支持原生 WebMCP，可调用页面暴露的八个结构化工具：`list_satellite_models`、`get_capture_state`、`configure_capture`、`start_capture`、`get_capture_job`、`cancel_capture_job`、`add_noise_variant`、`prepare_dataset_download`。工具与手动操作使用同一套状态、参数校验和任务功能。

原生 WebMCP 仍属实验性能力，并非所有浏览器都支持；页面通过实际接口检测显示可用状态，优先 `document.modelContext`，兼容较早的 `navigator.modelContext`。不支持时仍可手动采集和下载。智能体的发现、连接与模型由浏览器或外部客户端提供，页面本身不会自动获得 AI 能力。下载工具仅准备页面保存入口。

## 开发与构建

在已准备 Node.js 和 pnpm 的终端中：

```powershell
cd apps/ui
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm preview --host 127.0.0.1
```

`pnpm build` 会先校验并复制本地模型静态资源，再执行 TypeScript 检查和 Vite 构建。构建产物位于 `apps/ui/dist/`，应通过本地 HTTP 服务访问，不要直接双击 `index.html`。`pnpm dev` 同样会先准备本地模型；浏览器开发期间修改源码可能触发热更新并清空会话。

桌面版历史源码仍保留，原 V3 README 已归档至 [docs/desktop-v3-readme.md](docs/desktop-v3-readme.md)，其中桌面启动方式、持久化工作区、输出目录和数量上限不适用于本 Web 版。
