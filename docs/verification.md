# 2026-09-19 首轮重构验证

本记录针对新目录SatelliteDatasetStudio。旧版29项测试的历史结果不计入以下数字。

## 已执行结果

| 检查 | 结果 | 证据/复现入口 |
|---|---|---|
| 纯Python领域、队列、导出、HTTP | 23项通过 | tools/test-python.ps1；tests/python |
| 渲染器生命周期、资产SHA256与路径 | 5项通过 | tools/test-python.ps1；tests/rendering |
| 前端数学/参数快照 | 5项通过 | apps/ui中的pnpm test |
| TypeScript严格检查、生产构建 | 通过 | pnpm build |
| 前端Prettier格式检查 | 通过 | pnpm format:check |
| .NET 8桌面Release构建 | 通过，0警告0错误 | tools/build-desktop.ps1 |
| 桌面进程启动失败后清理、重复清理 | 通过 | tests/desktop/DesktopLifecycle.Tests.csproj |
| 六模型真实后台渲染 | 6/6通过 | tools/verify_rendering.py；var/verification/rendering/report.json |
| 三类采集的真实API集成 | 1单帧+3覆盖帧+3连续帧，共7帧完成 | tools/verify_api.py；var/verification/api-report.json |
| 原生桌面集成 | 启动WebView2、按钮提交Sputnik单帧、PNG链接、关闭后服务退出通过 | tools/verify_desktop.cjs；var/verification/desktop/report.json |
| 浏览器操作 | 六模型含贴图、姿态变化、固定FOV距离缩放、单帧/取消/PNG切换通过 | apps/ui/README.md；var/verification/ui.png |
| 390px布局 | 无水平溢出 | 浏览器实际验收 |
| 资产自包含 | 六GLB均无外部资源URI，哈希匹配 | var/verification/asset-report.json |

真实渲染检查完整解码1024×1024、8位L模式PNG，确认非全黑，检查可见像素落在正式几何投影框内（保留2像素抗锯齿容差）。阴影/遮挡使可见像素框可能小于几何框，不能要求二者每边相等。六模型接触图为var/verification/rendering/contact-sheet.png，已查看。

API逐帧校验PNG、YOLO五列、JSON帧名、旋转矩阵/四元数/六角一致性、K/相机外参、场景快照和文件引用。覆盖集生成coverage.json直方图与空档统计。3帧只是链路测试，不证明统计覆盖充足。

桌面验收还验证WebView2加载本地页面、实际按钮提交、保存PNG、窗口关闭后其Python服务不可访问。为了浏览器调试接口可用，此验收在许可的非限制进程环境执行；第一次受限进程环境未能连接调试端口不计为通过。服务只监听回环地址。

## 审查中修复的问题

- GLTFLoader通过fetch(blob:)解码内嵌贴图，原CSP缺少该来源；已修复并加回归检查，六模型纹理重新验收。
- Blender默认抖动让纯黑背景出现0/1灰值；已关闭，像素噪声由独立种子明确生成。
- 正式资产替换后可能仍记录旧清单哈希；现在实际读取并核对SHA256后才载入。
- .NET Process.Start失败后HasExited不可读取；增加成功启动标记与幂等清理，并实际复现失败后再验证修复。
- 桌面曾忽略PNG的新窗口链接；现在同源正式PNG在宿主拥有的图片窗口打开。
- 正常浏览器断开不再输出异常堆栈；Windows超大请求拒绝的连接重置经过重复验证。

独立复查确认资产哈希和桌面启动失败清理两项修复通过，坐标/投影链未发现重要问题。

## 仍存在的提示与验收边界

- Three.js本地生产包约593KB，Vite给出超过500KB的体积提示；构建成功，没有用隐藏警告代替分析。当前为离线本地加载，后续性能验收再决定是否进一步拆分。
- 旧版捆绑的Blender启动会记录缺少_bpy_internal.assets的附加组件警告；所有本轮正式渲染均成功。离线发行应使用完整、固定版本的运行时再验收。
- 当前曝光+2 EV是样图检查后的固定视觉配置，写入每帧renderer元数据；未承诺真实相机光度定标或跨显卡逐像素一致。
- 未完成离线安装包、全新Windows环境、单翼模型真实性、甲方ONNX协议联调、长时间大批量和自动续跑验收。详见migration.md。

## 四款购买模型的材质更新

源为 `02-四个卫星模型.zip`；模型与材质来源见 [模型更新说明](model-materials.md)。本次只更新 Sputnik-1、GPS、Galileo、GLONASS。INSAT-3B 和 Hubble 的两种二进制资产 SHA256 均与更新前一致。

- Python 服务及领域测试 26 项、渲染模块测试 5 项、前端测试 5 项通过；TypeScript 与生产构建通过。
- 本地资产验收 2 项通过：四款模型的来源、嵌入贴图、PBR 材质及内容哈希正确；保护的两款模型未变化。
- 四款实际 Blender 灰度渲染通过：1024×1024、8 位 L 模式、非全黑、可见像素位于投影框内。报告位于 `var/model-update/formal-verification/report.json`，正式已发布的 Blend 哈希与该报告逐一相符。
- 彩色检查渲染位于 `var/model-update/color-inspection/`；独立检查灯光不写回标准资产。
- 全部原始顶点配准与既有仿真几何一致，最大误差低于 2 微米；这表示数值坐标对齐，不表示真实物理尺寸得到标定。Sputnik 逐角 UV 保留，四款法线变换、GLB 半径与嵌图通过独立审查。
- 旧材质名称存在语义错误，已用几何分区替换：双翼正反面为光伏，中央机体为 MLI，边缘与支杆为金属。该结论经过实际彩图检查，不仅依赖材质名称。
- GLB URL 加入内容哈希；HTTP 回归测试验证服务重启后的同路径资源使用新版 URL 和新文件。已打开软件仍需重启以更新启动时加载的模型清单。
- 发布后四个版本 URL 均返回 HTTP 200，响应字节 SHA256、API 哈希、URL 版本和正式清单一致，记录为 `var/model-update/ui-verification/http-verification.json`。

本次浏览器自动化连接出现 `nodeRepl.fetch request failed`，因此未将真实浏览器模式切换、画布数量、控制台检查或界面截图计为通过。上面的彩色图是 Blender 材质检查渲染，不是网页截图；首轮重构的历史浏览器验收不替代本次验证。

更新前备份位于 `var/model-update/backups/20260919-183832-405904/`。模型角色配方保存在 `assets/recipes/four-satellites/`，无需保留临时审计目录即可按说明重新构建标准资产。
