# Satellite Dataset Studio 首轮迁移实施计划

> **For agentic workers:** Use superpowers:executing-plans. Native execution with bounded parallel implementation and independent final review. Steps use checkbox syntax.

**Goal:** 在整洁的独立工程中交付能预览六个模型、设置姿态并生成新协议数据的首条工作链路。

**Architecture:** React/Three.js 静态界面经本机 Python 服务提供；WPF/WebView2 包装同一页面。Python 域逻辑、持久队列、数据导出与 Blender 适配器分离；Blender 只在正式生成时后台启动。

**Tech Stack:** Python 3.11+、NumPy/Pillow、React/TypeScript/Three.js、.NET 8 WPF/WebView2、现有 Blender 5.2。

**Spec:** ../specs/2026-09-19-satellite-studio-reconstruction-design.md；接口以 ../../architecture/interfaces.md 为准。

## Global Constraints

- Windows、本地离线运行；不依赖运行时 CDN。
- schema_version=satellite-pose-3.0；coordinate_convention_id=rh-image-world-v1。
- 正式输出1024×1024灰度8位；距离10000–30000米；固定模型采集FOV。
- 旧版源码、原始RAR及已有数据原位保留，禁止覆写迁移。
- 根目录只放入口说明、通用配置和有明确职责的子目录；日志与生成物进入var。
- 开发阶段可获取官方构建依赖；离线发行包需要单独打包运行时，不虚报已完成安装验收。

## Review Focus

- 四元数跨180度不能符号跳变；测试连续采样邻接点积。
- 缺少模型或渲染器时UI能给出可读错误；启动预览不能依赖Blender。
- 非有限数、零四元数、路径穿越不能进入正式任务。
- 渲染中断不能让半套产物显示已完成；测试数据库重启状态与PNG损坏。
- Three.js与正式几何坐标相同；通过单位姿态、轴标记与正式图核对。

### Task 1: 工程布局、契约、模型资产

**Files:** README.md、.editorconfig、.gitignore、python/pyproject.toml、schemas/*.json、tools/prepare_assets.py、assets/models/index.json、docs/architecture/interfaces.md。

**Interfaces:** 模型对象字段与Scene/Job见接口文档；模型预处理生成同坐标的GLB与blend，记录SHA256与源变换。

- [x] 建立用户指定目录与运行目录规则，复制已批准设计，旧版不动。
- [x] 读取六个源资产，正式材质优先使用现有blend_sources；以模型包围盒中心为原点，米制，注册为仿真机体系；保存规范化blend与GLB。
- [x] 验证每个模型包含几何、半径有限且正、资源存在、GLB不引用外部贴图。记录程序材质预览不能等同正式图的限制。

### Task 2: 领域、队列、数据与本机服务

**Files:** python/src/satellite_studio/{domain,jobs,datasets,server}、tests/python、schemas。

**Interfaces:** `python -m satellite_studio --project-root PATH --workspace PATH --blender PATH --port 8765`；消费BlenderRenderer接口；提供完整HTTP接口。

- [x] 先写数学/参数/持久化/文件校验测试，执行确认失败。
- [x] 实现xyzw四元数、六角及有效位、SO(3)覆盖、连续序列、固定FOV、观察相机和载荷外参。
- [x] 实现SQLite任务状态与不可变快照，后台串行渲染，取消与中断恢复说明。
- [x] 导出逐帧PNG、YOLO、JSON，噪声按帧种子产生；先校验再标记完成。
- [x] 提供静态资源和同源API，限制路径与请求大小；运行纯Python测试。

示例验收：`assert six_angles([0,0,0,1])["alpha_valid"] == [True,True,False]`；连续帧`dot(q[i],q[i+1])>=0`；拒绝NaN、distance=9999、resolution=512。

### Task 3: React/Three.js 操作界面

**Files:** apps/ui/package.json、apps/ui/src/{App,components,api,types,styles}、apps/ui/index.html。

**Interfaces:** 仅使用文档约定的HTTP接口；不从旧后端引用字段。浏览器中使用GLB，网格坐标已是B。

- [x] 中文工作台：模型列表、实时3D、姿态输入、10–30km距离、太阳光、噪声、采集方式、种子与队列。
- [x] 分开拍摄视角和自由观察，复位/坐标轴/安全框；正式预览显示任务生成的实际PNG。
- [x] 捕捉提交时完整快照；网络失败、模型载入失败、WebGL不支持均给出可见错误。
- [x] TypeScript构建通过；浏览器验收模型切换、姿态变化、距离变化、提交与结果展示。

### Task 4: 后台渲染器与桌面壳

**Files:** python/src/satellite_studio/rendering/{client,worker,scene}.py、apps/desktop/*.cs、apps/desktop/*.xaml、tools/*.ps1、packaging/README.md。

**Interfaces:** client.render严格实现接口文档；worker通过127.0.0.1套接字接收串行帧并返回纯JSON，stdout仅日志。

- [x] 后台Blender关闭自动脚本执行，惰性启动，常驻复用；模型切换加载规范化blend。
- [x] 同一固定相机生成灰度PNG，正式求值几何投影提供标签框，渲染异常向上传播。
- [x] Windows宿主读取配置并启动Python服务、托管WebView2，异步消费日志，关闭时清理自己启动的进程。
- [x] 六模型每个一帧冒烟验收；检查尺寸、灰度、标注、无裁切，查看接触图；验证一段连续序列。

### Task 5: 交付验证与文档

**Files:** README.md、docs/verification.md、docs/migration.md、packaging/README.md。

- [x] 运行全部新测试、前端生产构建、桌面构建；记录环境缺项，不把未验证功能写成已完成。
- [x] 独立审查接口一致性、并发关闭、坐标/图像匹配和根目录整洁；修复影响工作链路的问题。
- [x] 写明开发启动、目录职责、产物位置、旧版关系、已完成范围与仍需验收的离线安装/单翼资产/物理定标。

## 执行决定

用户已确认重构并授权技术选型，继续本地可回退实施，不再重复询问执行方式。当前目录不是Git仓库，因此以独立新目录隔离，不创建假提交记录。全面产品验收（安装包、单翼资产真实性与视觉定标）与本轮能验证的工作链路分开记录。

