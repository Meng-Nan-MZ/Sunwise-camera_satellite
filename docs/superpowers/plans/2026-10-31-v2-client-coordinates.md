# V2 甲方坐标与姿态协议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 留存可校验 V1，在隔离 V2 中交付与甲方一致的界面姿态和 JSON。

**Architecture:** 公开 API/持久化/界面统一甲方左手系；引擎仅在渲染边界转换。完整 JSON 使用新 schema，无旧协议兼容。

**Tech Stack:** Python/NumPy/Pillow、React/TypeScript/Three.js、C# WPF/WebView2、Blender、Git。

**Spec:** ../specs/2026-10-31-v2-client-coordinates-design.md

## Global Constraints

- 仅编辑 V2；V1、原始工程与历史数据不变。
- API scene.sat_quat={W,X,Y,Z}；默认 CamQuat={W:.5,X:.5,Y:-.5,Z:.5}。
- schema=satellite-pose-4.0；coordinate_convention_id=lh-client-world-v2。
- 世界 X右 Y朝相机 Z上；相机 X上 Y左 Z朝目标。
- P交换Y/Z；q_engine=(-x,-z,-y,w)。不改变模型二进制。
- V2 数据、安装标识、启动入口独立；无旧任务迁移或旧格式兼容。
- 不实现反馈2-6；源码入Git，资产/运行库/数据留本地。

## Review Focus

- 非零和复合姿态不能仅靠identity假通过；以轴向和投影不变验收。
- 相机姿态须来自实际正式相机，K的CV基须明确。
- 新前端提交必须与Python API同构，旧请求必须报错。
- 批量任务和元数据中的全部变换不能残留旧语义。
- 安装版或显式workspace不得读入V1任务，V1哈希不能变化。

### Task 1: 冻结 V1、复制 V2 与 Git 基线（root）
- [ ] 完整复制 V1，生成源码、资产、安装包和数据哈希对照；V2不带旧任务。
- [ ] 在V2保存设计和计划，初始化/关联Git保留远程已有历史，保存v1-source基线。

### Task 2: Python、渲染与新协议（backend implementer）
**Files:** python/src/satellite_studio、schemas、tests/python、tests/rendering、tools/verify*.py。
**Interfaces:** scene.sat_quat对象输入；内部数学xyzw；Location对象输出；renderer返回实际observer_camera。
- [ ] 先写并运行默认相机、已知轴向、投影一致、旧请求拒绝的失败测试。
- [ ] 实现坐标边界、Scene输入、采样、正式渲染、输出和逐帧验证；更新测试及协议。
- [ ] 运行Python/渲染测试，记录红绿测试证据。

### Task 3: UI 姿态操作（UI implementer）
**Files:** apps/ui/src、apps/ui/tests、apps/ui/package.json、apps/ui/README.md。
**Interfaces:** SceneSettings.sat_quat对象；渲染边界q_engine；其余HTTP接口保持。
- [ ] 先写三轴操作和适配的失败测试。
- [ ] 改输入/显示/轴线/提示，提交新对象格式，标V2；复制相同数学标准向量核对。
- [ ] pnpm test、build、format:check。

### Task 4: 桌面隔离、文档与整体验证（root）
**Files:** apps/desktop、tests/desktop、packaging、tools启动/打包、docs、README。
- [ ] 测试V2默认路径/标题/安装身份与V1隔离，再改实现；拒绝旧协议任务目录。
- [ ] 更新当前入口文档，历史记录明确为V1，生成可运行V2开发构建。
- [ ] 实际生成已知姿态单帧和覆盖/序列；逐帧核对新JSON、PNG、投影。
- [ ] 浏览器/桌面操作与截图；独立审查改动，解决重要发现；复核V1哈希。
- [ ] 提交本地Git；若远程连接可用，推送独立V2分支，不强推主分支。
