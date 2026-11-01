# V2.3 保存位置验证

日期：2026-11-01。基于 V2.2.1（8ef5a63）完成反馈第五条“UI直接修改图片生成保存路径”。版本V2.3/2.3.0；保留网页正式采集和可选Blender对照。浅色主题留到V2.4。本轮更新源码与可运行开发构建，未制作安装包。

## 最终行为

“数据集保存位置”支持手动输入、系统文件夹选择、应用、立即恢复默认和重启记忆。输入/选择与已应用的位置分开，取消不改路径。接受已有、可写的绝对目录，支持中文、空格和其他磁盘；独立浏览器可手动应用，系统选择由桌面提供。

新采集在提交时冻结自己的根目录；更改设置不影响排队、运行中或历史任务。每个任务仍保存PNG、YOLO及姿态JSON。旧数据库以新增nullable output_root兼容，旧NULL映射原workspace/jobs，旧快照和协议不变。数据库、日志、设置仍在原工作区。

噪声版本始终放在规范原图任务旁边，继续使用satellite-noise-1.0的同级相对引用；不复制或改写原图/姿态/标签。目录不可用时明确失败，不自动改存其他目录；在任务中失联时也不递归重建已消失的根目录或任务目录。

## 自动回归

最终共230项通过；重复独立审查执行不重复计数：

| 检查 | 结果 | var/development/v2.3/下证据 |
| --- | --- | --- |
| Python任务、协议、目录设置与HTTP | 106/106 | root-python-final.log |
| Blender客户端/资产边界 | 6/6 | root-rendering-final.log |
| UI数学、几何、桥接与设置控制器 | 85/85 | root-ui-final.log |
| 桌面生命周期与受限文件夹协议 | 24/24 | root-desktop-final.log |
| 打包工具静态夹具/身份隔离 | 9/9 | packaging-green.log |
| TypeScript、Vite、Prettier | 通过 | root-ui-build-final.log、root-ui-format-final.log及ui-report.md |

新回归覆盖：实际旧表结构升级、快照摘要保持、设置重开持久化、任务根不可变、探测脱锁与设置/提交竞态、无效路径回滚、已保存目录离线、规范原图/噪声同级、外部目录已发布文件访问及穿越/来源拒绝；UI覆盖草稿/保存、取消/错误/过期回复、清理、手动输入和提交/应用同步互斥。不可写权限错误用确定性PermissionError注入；实际中文目录执行真实写探测，未改系统ACL。

Three.js分块仍有超过500kB的构建体积提示，资源全为本地提供。没有新增运行依赖。

## 原生与实际磁盘验收

工具tools/verify_v23_output_directory.cjs，真实WPF/WebView2、真实模型、真实网页PNG及标注，使用不存在的Blender路径。最新完整记录为var/verification/v2.3-output-directory/report.json，独立验证工作区与产物不操作用户工作区。

实际系统窗口取消和选择分别完成，选择返回C盘含“V2.3 甲方 数据集”的中文/空格路径；仅选择不改变服务设置，应用后正式单帧写入该目录。原生操作记录1793506061714保留picker_cancel=true、picker_selection=true和生成的C盘单帧。该次后续验收脚本误将协议名写为“4.0”而报错，实际JSON是正确的satellite-pose-4.0；修正断言后，完整流程通过。最终记录通过picker_evidence保存这份真实操作报告的路径和SHA256；不以模拟选择替代系统交互。

完整实际保存流程通过：

1. 从复制的V2.2.1工作区升级，默认仍指向新验证工作区/jobs，旧任务可访问。
2. 界面应用C盘目录并生成单帧；提交60帧自定义序列及排队单帧，随后界面切换H盘中文/空格目录，再提交新单帧。原批量与排队任务仍全部写C盘，新任务写H盘。
3. 在当前设置为H盘时，从旧默认目录任务、C盘任务分别追加噪声；两个版本都与各自原图同级，来源哈希和相对引用匹配，原文件不变。
4. 关闭重开同工作区，界面记住H盘目录，旧默认、C盘和H盘任务图片均可通过原任务访问。
5. 相对路径应用返回400，保留已保存位置。已应用目录随后删除时，新采集明确返回400，设置不回退；恢复可用目录后单帧完成。
6. 点击恢复默认，生成的任务写入原默认jobs；再次应用自定义位置成功。
7. 实际65帧干净PNG完整解码，尺寸1024²、8位L模式、非空；姿态协议/后端保持正确，195个PNG/JSON/TXT摘要写入报告。另有两张实际追加噪声PNG及元数据/来源摘要核对。
8. 数据集目录没有jobs.sqlite3、logs或service.lock；数据库和日志仍在验证工作区。两次正常关闭后所属服务退出，无页面异常或资源加载失败。

新增实际浏览器布局检查：专用正式画布计算样式display=none，布局宽高为0。验收截图发现Three.js默认内联display:block覆盖HTML hidden，已显式隐藏正式画布并保持2048²缓冲；修正前检查明确失败（2048px溢出），修正后重新出图和保存流程验证。预览、相机、材质与正式配置不变。

## 独立审查与兼容性

独立代码审查发现两项P2，修复后复审关闭：失联根目录在Blender启动/两种发布边界被递归重建；以及WebView2回调内同步打开模态窗口。前者以三个真实生产函数的确定性失联回归验证，后者延迟到Dispatcher、保留单例及关闭检查，符合[微软WebView2线程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model#reentrancy)。没有将桌面操作工具的缓存/坐标失败推断为产品原因。

两处直接调用BlenderRenderer的QA工具同步补上自行创建staging的责任，生产检查保持严格。实际Blender5.2对全新目录复跑：tools/verify_rendering.py六模型通过并生成contact sheet；tools/verify_v2_coordinates.py八组已知姿态通过，包含独立投影核对。证据在var/verification/v2.3-tools/{rendering-fresh,coordinates-fresh}。这些是保留对照路径的附加验收，网页采集仍不依赖Blender。

review-report.md记录原问题、复现、修复和最终无遗留审查项。artifact-audit-report.md及独立产物核对另存var/development/v2.3，核对真实SQLite、快照、PNG/YOLO与噪声来源，不使用程序存储解析器代替参考。

## 启动与留存

tools/runtime.ps1从桌面工程版本计算var/build/desktop-2.3.0，构建与启动入口共享这一规则，保留正在使用的旧构建。tools/start-desktop.cmd启动V2.3；使用原工作区前先关闭旧窗口，单工作区锁继续生效。最终Release构建零警告/零错误，提交后重建以记录最终源码SHA。

实际执行日常build-desktop.ps1时发现原脚本未指定锁定文件中的win-x64，触发NU1004；已显式添加win-x64及非自包含构建选项。相同脚本随后还原/构建成功、零警告/零错误，依赖锁文件未修改。修正前日志desktop-build-rid-red.log和成功日志desktop-build-final.log保留。

原V1目录、v2.2.1及更早标签保留。以普通快进更新已有v2/client-coordinate-protocol分支，并新增v2.3标签；不改写历史。Git只保存源码、测试和文档，授权模型、运行时、截图和数据仍留本地。

此版本不自动移动/导入外部数据、不提供断点续跑。访问历史任务需要其目录仍保留在记录位置；备份任务历史需同时保留程序工作区数据库与各数据集目录，原图和噪声版本保持同级。没有声称可在所有设备上保证相同速度或磁盘持续可写。
