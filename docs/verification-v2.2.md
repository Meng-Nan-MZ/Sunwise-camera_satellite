# V2.2 验证记录

日期：2026-11-01。范围为甲方第四条：关闭噪声不输出副本，以及复用已有原图生成多组噪声。程序 V2.2 / 2.2.0，继续使用 V2 工作区和 satellite-pose-4.0 / lh-client-world-v2，不迁移 V1 数据。

## 实现范围

新渲染任务关闭噪声时，每帧仅发布原图、YOLO 和姿态 JSON；开启时继续输出配对噪声图。历史 V2/V2.1 已保存配对文件仍可读、可校验，不自动删除旧数据。

已完成任务可用当前噪声参数与种子创建独立噪声版本，只保存噪声图及来源元数据，复用原图和标注。完成的噪声版本也可作为入口，始终指向同一原始渲染任务，不产生递归引用。旧噪声图丢失或损坏不影响从完整原图重新生成；原图、标签或姿态缺失/损坏会明确失败。

追加任务不调用 Blender，也不要求原模型渲染二进制存在。桌面仅取消 Blender 文件的启动必需条件，其余运行文件检查保留；没有 Blender 时禁用新拍摄，保留已有数据及噪声功能。

## 自动化与构建

| 检查 | 结果 | 本机证据 |
|---|---|---|
| Python 领域、任务、HTTP、存储、来源与噪声 | 70 项通过 | var/development/v2.2/final-python.log |
| 渲染边界与资产生命周期 | 5 项通过 | var/development/v2.2/final-rendering.log |
| UI 旧姿态及新噪声/图片可用性 | 37 项通过 | var/development/v2.2/final-ui.log |
| 桌面启动、路径、旧协议拒绝和清理 | 18 项通过 | var/development/v2.2/desktop-green.log |
| 打包工具静态夹具及 V2 身份隔离 | 9 项通过 | var/development/v2.2/packaging-green.log |
| TypeScript / Vite / Prettier | 通过 | var/development/v2.2/ui-report.md |
| WPF 开发构建 | 通过，0 警告/错误 | var/development/v2.2/desktop-build.log |

共 139 项自动化检查通过。新行为先确认测试失败，再实现通过；桌面缺少 Blender 的新要求、来源扫描和旧噪声依赖修正也有独立失败到通过的回归证据。

独立审查的来源扫描持锁问题已修正：开始时只在短数据库锁内记录帧 ID/数量/快照摘要，文件检查按帧进行。事件控制的并发回归证明，文件查询延迟时仍能读取列表和取消任务，取消后不再查询后续帧。噪声输出 schema 也已强制要求实际使用的 sigma/peak，入口参数默认值保持不变。

测试覆盖全部四种渲染模式关闭噪声、历史关闭噪声配对数据、禁止渲染器工厂时真实队列/API处理、模型 blend 缺失、两组参数及重复种子、来源文件清单/字节哈希不变、规范来源、非法请求、来源损坏、输出/元数据篡改、发布白名单、排队/处理中取消、重启中断以及坏请求不终止队列。

## 真实出图与桌面验收

真实 Blender 先生成三帧自定义序列原图，再分别生成单张、全姿态、随机连续序列各一帧。六帧均无 images_noisy 输出，姿态 JSON 不声明不存在的噪声文件。

随后关闭服务并以 Blender=None 重启，完成两组噪声、同种子重复、从噪声版本解析原始来源、旧 V2.1 数据追加和取消。逐帧检查 PNG 灰度/尺寸、来源相对路径与摘要、参数、master_seed/noise_seed 和输出摘要。同参数同种子的三张 PNG 字节摘要完全一致，不同参数结果不同，来源文件集合与哈希不变。最终源码记录：var/verification/v2.2-api-final/report.json；早期集成记录另存 var/verification/v2.2-api/report.json。

真实 WPF 使用不存在的 Blender 路径启动，确认新拍摄不可用、原图仍可查看。操作噪声开关、参数和种子，生成两组版本，切换干净/含噪图。请求体只有 noise/seed；即使当前模型姿态为 X123°、距离25km、面板帧数9，新版本仍使用所选原始三帧，原图 URL 指向原任务。V2.1 轨迹播放、暂停、退出及手动姿态恢复继续正常。来源文件无改动，追加目录没有 images_clean/labels/poses 副本，无页面或资源异常，关闭后自有后台退出。

桌面证据：var/verification/v2.2-desktop/report.json，以及其中 output 目录的 clean-only-no-renderer.png、noise-version-source-reuse.png 和任务数据；截图已目视检查。最终审查修正后重新执行桌面验收，记录在 var/development/v2.2/real-desktop-final.log。

## 数据依赖与验证边界

噪声版本的 job.json 和 noise_meta 通过相对引用依赖同级原始任务；单独移动版本目录不等于完整数据集。原始 pose 的噪声配置是拍摄时的记录，追加版本配置以 noise_meta 为准。算法沿用原有 Poisson 后 Gaussian，记录 NumPy/Pillow 实现版本以便复现。

来源 DB 请求快照在提交时冻结；输入图像摘要在处理每帧时记录并在发布前复核，不对十万张图片在提交接口做预先解码。任务列表可用性是快速状态/记录检查，物理文件损坏由后台处理明确报错。HTTP 读取沿用已发布白名单，不逐次重新计算图像摘要。

本轮在当前 Windows、现有资产与运行库上验证，未声称完成其他显卡/全新 Windows、十万帧长时间负载或甲方下游消费程序联调。JSON Schema 已解析与检查关键契约，未用第三方完整 Schema 引擎验收。Three.js 预览仍是近似效果，正式 PNG 为准。

本轮不制作、压缩或安装安装包。Git 仅保存源码、测试和文档；模型、运行库、生成数据和验收截图留在本地 var。代码审查记录见 var/development/v2.2/review-report.md。
