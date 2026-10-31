# 卫星数据工作台 V2.2 界面

React、TypeScript 严格检查、Three.js 和 Vite。版本 2.2.0；应用资源由同源本机服务提供，不从 CDN 获取脚本、字体或模型。依赖版本由 `pnpm-lock.yaml` 固定。

关闭像素噪声的新采集任务仅保存原图。选择完成任务后，可使用当前像素噪声设置与随机种子“基于原图生成噪声版本”；此操作独立于模型预览与 Blender。新版本复用原始任务的原图、姿态与标签，移动或备份时需同时保留原始任务。

## 开发与构建

使用 Node.js 24（测试使用原生 TypeScript 类型擦除）和 pnpm：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm format:check
```

依赖已准备好而 pnpm 启动器无法联网时，可直接运行相同检查：

```powershell
node --test tests/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
node node_modules/prettier/bin/prettier.cjs --check src tests *.ts *.json *.yaml *.html *.md
```

生产文件位于 `dist/`，由 Python 服务直接提供。`pnpm dev` 将 `/api`、`/assets/models` 和 `/data` 代理到 `http://127.0.0.1:8765`。

## 坐标与姿态

- 世界系及零姿态本体系均为甲方左手系：X 图像右、Y 朝观测相机、Z 图像上。辅助轴红 X、绿 Y、蓝 Z；零姿态绿色朝相机、蓝色向上。
- 姿态输入为内禀 XYZ 欧拉角，Hamilton 公式、主动 local-to-world 变换。内部数学使用 xyzw 数组；显示和公开 scene API 使用 `sat_quat: { W, X, Y, Z }`，相邻操作保持四元数符号连续。旧 `quaternion_xyzw` 请求被拒绝。
- 仅在目标渲染边界采用 `q_engine = [-x, -z, -y, w]`，等价于交换 Y/Z 的 `R_engine = P R_client P.T`。辅助轴独立应用 P；GLB 保持原有米制引擎坐标和原点，不移动、缩放、反射或重新归一化模型。
- 默认观测相机 CamQuat 为 WXYZ `(0.5, 0.5, -0.5, 0.5)`，其左手坐标为 X 图像上、Y 图像左、Z 光轴朝目标。相机位于甲方世界 `(0,d,0)`，对应引擎 `(0,0,d)`；每个模型使用固定短边 FOV：`2 atan(r / (0.8 sqrt(10000²-r²)))`。
- 自由观察使用另一台相机及独立环境补光，不改变采集姿态或观测相机；正式输出 CamQuat 由后端实际观测相机产生。
- V2 协议为 `satellite-pose-4.0` / `lh-client-world-v2`，完整契约见工程 `docs/architecture/interfaces.md`。

## 任务和资源

- 正式图像显示 `/data` 下真实保存的 PNG。改变当前场景不会改动所选任务结果。正式单帧按钮提交一个常规单帧任务；输出目录继续使用 `poses` 命名。
- 覆盖与序列使用服务提供的采样默认值；界面只开放契约支持的参数。
- GLB 内嵌纹理由 Three.js 通过 `fetch(blob:)` 解码，服务 CSP 的 `connect-src` 必须包含 `blob:`。模型、纹理、网络、WebGL 和正式图片错误均有可见提示。
- 快速模型切换取消旧请求，丢弃并释放过期解析结果；卸载时清理动画、控件、纹理、几何、材质和 WebGL 上下文。
- 拍摄视角只在模型材质最终输出中应用灰度；辅助轴始终保留红 X、绿 Y、蓝 Z。自由观察关闭同一灰度开关，恢复模型材质颜色。沿用同一画布、曝光与光照流程。实时预览近似呈现材质和光照；正式灰度、曝光与噪声以 Blender 保存的图像为准。辅助线不进入输出。

## 验证范围

自动测试覆盖三轴 ±90°、非对称复合旋转的基变换、q/-q 等价、辅助轴方向及颜色、跨 180° 符号连续、固定球体视场、WXYZ 归一化与嵌套快照冻结，以及旧请求、非有限和越界输入拒绝。实际浏览器和 Blender 的 V2 图像对应验收由整体验证执行，不将 V1 浏览器记录作为 V2 证明。

Vite 可能提示 Three.js 主包超过默认 500 KB；所有依赖均为本地打包资源。

## 自定义姿态序列

选择“自定义姿态序列”，在右侧独立设置起点和终点 XYZ 欧拉角，或记录当前手动姿态。默认 120 帧，包含首尾；数量范围为 2–100000。沿最短旋转路径过渡，相同起止姿态得到静止序列，不表示转一整圈。

播放、暂停或拖动“预览帧”可检查序列。预览期间手动姿态控件禁用；退出后恢复手动姿态。修改端点、帧数或模型会停止并重置预览。自由观察相机保持独立。

“开始生成”冻结完整起终点与场景快照；播放位置不改变批量轨迹。“生成当前单帧”暂停预览并保存当前显示姿态。共享数学向量位于工程 tests/fixtures/custom-trajectory-vectors.json，UI 单元测试同时验证独立角距离和边界输入。
