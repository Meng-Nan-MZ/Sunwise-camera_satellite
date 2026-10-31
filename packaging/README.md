# Windows x64 离线发行

目标为 Windows 10+ 的 x64 系统，按当前用户安装。程序默认位于 `%LOCALAPPDATA%\Programs\SatelliteDatasetStudioV2`，数据位于独立的 `%LOCALAPPDATA%\SatelliteDatasetStudioV2\workspace`。升级和卸载不删除工作目录。

## 文件边界

- `installer/SatelliteDatasetStudio.iss`：Inno Setup 7 定义，固定 AppId，无管理员要求。
- `dependencies.lock.json`：运行时来源、版本和哈希，由依赖准备流程维护。
- `使用说明.html`：离线中文帮助，组装时复制到 payload 的 `docs/使用说明.html`。
- `THIRD-PARTY-NOTICES.md` 和许可文件：随包保留许可与源码交付说明。
- `runtime.example.json`：仅用于开发环境，不参与安装版的启动路径选择。

下载、编译工具、运行时、staging、安装测试保存在 `var/packaging/`；交付产物保存在 `var/releases/`。安装器不执行联网、下载、restore 或系统级运行时安装。

## 组装与编译

开发端需要 Python 3.11+、Node/pnpm、.NET SDK 8.0.425 与 Inno Setup 7.1.0。它们用于制作安装包，不要求最终使用者安装。

运行时输入通过 `python tools/packaging/fetch_dependencies.py` 按锁文件下载；已有缓存时加 `--offline` 只校验、不联网。所有下载必须匹配锁定 SHA256。Python 的离线装配器另读取官网下载的 `python-3.13.15-embed-amd64.zip.spdx.json`，以及 PyPI 的 `numpy/2.3.5/json`、`pillow/12.3.0/json` 元数据，分别保存到下载目录的 `numpy-2.3.5.json`、`pillow-12.3.0.json`。这些辅助文件已保存在本次开发缓存。

`prepare_python.py --python-sha256 <锁文件中的值>` 在 `var/packaging/runtimes/python` 生成隔离运行时并验证原生扩展。解压 Blender 官方 ZIP 到 `var/packaging/runtimes/blender/`；用 Windows `expand.exe <cab> -F:* <目标目录>` 将固定 WebView2 CAB 解压到 `var/packaging/webview-extracted/`，保留官方目录结构和全部文件。不要用残缺的旧版 Blender 目录替代。

UI 使用锁文件构建；桌面须进行 self-contained publish，输出到 `var/packaging/publish/desktop`：

```powershell
pnpm --dir apps/ui install --frozen-lockfile
pnpm --dir apps/ui build
dotnet publish apps/desktop/SatelliteStudio.Desktop.csproj -c Release `
  -r win-x64 --self-contained true -p:PublishTrimmed=false `
  -p:RuntimeFrameworkVersion=8.0.31 -o var/packaging/publish/desktop
./tools/packaging/stage-release.ps1 -Python C:/path/to/python.exe `
  -StagingName release-0.2.0-new
```

发布时让 `NUGET_PACKAGES` 指向工程 `var/tools/nuget`，许可证收集器从该缓存取原始声明。已有 staging 不覆盖，重建时选新名称。`build_payload.py` 使用 Windows 扩展长度路径访问供应商文件，不修改系统长路径策略；包含专门的长路径回归检查。

先由 `tools/packaging/stage-release.ps1` 和 `build_payload.py` 组装完整 payload，包括自包含桌面、本地 UI、Python 服务、六模型、Python/Blender/固定 WebView2、说明和许可证。排除 SDK、node_modules、开发日志、采集数据和原始购买压缩包。

payload 顶层的 `release-manifest.json` 包含产品、版本、平台、文件总数/大小，以及每个文件的 `path`、`size_bytes`、`sha256`。相对路径使用 `/`，清单自身不列入 `files`。

在项目根目录执行：

```powershell
./tools/packaging/build-installer.ps1 `
  -PayloadDirectory 'var/packaging/staging/release-0.2.0-r2' `
  -Version '0.2.0'
```

示例使用本次冻结的 `release-0.2.0-r2`；后续构建替换为实际 staging 路径。脚本默认使用已安装的 `var/packaging/tools/inno/ISCC.exe`，不下载编译器。可用 `-CompilerPath`、`-OutputDirectory` 指定其他位置。

编译前逐项检查 payload 大小与 SHA256，拒绝越界路径、重复条目、重解析点和清单外文件。清单版本须与参数一致。通过后，以 ISCC `/D` 传入 payload、版本和输出路径。

默认输出：

```text
var/releases/SatelliteDatasetStudio-V2-0.2.0-win-x64-setup.exe
var/releases/SatelliteDatasetStudio-V2-0.2.0-win-x64-setup.exe.sha256
var/releases/SatelliteDatasetStudio-V2-0.2.0-win-x64-setup.build.json
var/releases/SatelliteDatasetStudio-V2-0.2.0-win-x64-setup.compiler.log
```

同名安装器存在时默认停止；有意重建时使用 `-Force`。脚本不递归删除 staging 或发行目录。当前构建禁用自动签名工具，安装器尚未使用发行者证书签名。

编译器会显示“Non-commercial use only”提醒；本次随附 `license.txt` 明确允许商业用途，官方[购买说明](https://jrsoftware.org/isorder.php)亦说明商业用户购买许可并非严格要求。保留原始许可、版权与提示，不修改编译器标记。

## 安装与数据保留

固定 AppId 为 `B46CE219-98FD-430C-AC12-A09EC62CC127`，后续升级沿用。开始菜单包含应用和帮助快捷方式，桌面快捷方式可选。安装完成后启动应用可选，静默安装跳过启动。

Restart Manager 采用正常关闭而非 `force`，不自动重启应用。升级前等待采集完成并退出；静默部署也应先确认退出，不要传入强制关闭选项。

ACL 仅作用于 `{app}\runtime\webview2`：给 `S-1-15-2-1` 与 `S-1-15-2-2` 增加可继承的读取/执行权限。隐藏调用 `icacls` 并检查返回码，失败记录输出、显示原因且阻止结束页启动；不改全局 ACL，不授予写权限。

独立工作目录不在安装器文件清单内，也没有卸载删除规则。卸载只移除安装文件与快捷方式。

## 验收和交付

分别记录构建、安装、启动、六模型载入、正式灰度出图、三种采集模式、取消、关闭再开及数据保留。全新 Windows 虚拟机、断网且未预装运行时的完整验收仍待完成；开发电脑编译成功不能替代。

交付安装器、SHA256、使用说明和对应源码附件。Blender 官方 with-libraries 源码已独立保留在 `var/releases/sources/`，不放进程序运行目录。模型属于用户提供的购买资产，分发范围以资产授权为准，不因制作安装器而改变。
