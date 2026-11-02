; Offline, per-user installer. Keep AppId stable across upgrades.
#ifndef AppVersion
  #define AppVersion "3.0.0"
#endif
#ifndef PayloadDir
  #error PayloadDir must point to a verified release payload.
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by the packaging script.
#endif
#ifndef OutputBaseName
  #define OutputBaseName "SatelliteDatasetStudio-V3-" + AppVersion + "-win-x64-setup"
#endif
#if !FileExists(PayloadDir + "\release-manifest.json")
  #error The payload release-manifest.json is missing.
#endif
#if !FileExists(PayloadDir + "\SatelliteStudio.Desktop.exe")
  #error The payload desktop executable is missing.
#endif
#if !FileExists(PayloadDir + "\docs\使用说明.html")
  #error The offline HTML user guide is missing.
#endif

[Setup]
AppId={{B46CE219-98FD-430C-AC12-A09EC62CC127}
AppName=Satellite Dataset Studio V3
AppVersion={#AppVersion}
AppVerName=Satellite Dataset Studio V3 {#AppVersion}
VersionInfoVersion={#AppVersion}.0
AppPublisher=Satellite Dataset Studio V3
DefaultDirName={localappdata}\Programs\SatelliteDatasetStudioV2
DefaultGroupName=Satellite Dataset Studio V3
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible and not arm64
ArchitecturesInstallIn64BitMode=x64compatible
SetupArchitecture=x64
MinVersion=10.0
WizardStyle=modern
DisableWelcomePage=no
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseName}
Compression=lzma2/normal
SolidCompression=yes
SetupLogging=yes
CloseApplications=yes
CloseApplicationsFilter=*.exe,*.dll,*.pyd
RestartApplications=no
UninstallDisplayIcon={app}\SatelliteStudio.Desktop.exe
UninstallDisplayName=Satellite Dataset Studio V3
Uninstallable=yes

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Satellite Dataset Studio V3"; Filename: "{app}\SatelliteStudio.Desktop.exe"; WorkingDir: "{app}"
Name: "{group}\使用说明"; Filename: "{app}\docs\使用说明.html"; WorkingDir: "{app}\docs"
Name: "{userdesktop}\Satellite Dataset Studio V3"; Filename: "{app}\SatelliteStudio.Desktop.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\SatelliteStudio.Desktop.exe"; WorkingDir: "{app}"; Description: "打开 Satellite Dataset Studio V3"; Flags: nowait postinstall skipifsilent unchecked; Check: CanLaunchApplication

[Code]
var
  WebViewPermissionsReady: Boolean;

procedure InitializeWizard;
begin
  WebViewPermissionsReady := False;
  WizardForm.WelcomeLabel2.Caption :=
    '本安装包包含应用及所需运行时，安装过程不下载依赖，也不需要管理员权限。' + #13#10#13#10 +
    '升级前，请等待当前采集任务结束，并关闭 Satellite Dataset Studio V3。安装程序会检查正在使用的文件；不会强制结束采集进程。' + #13#10#13#10 +
    '采集数据保存在独立的用户数据目录。升级和卸载均保留该目录。';
end;

function OutputText(const Lines: TArrayOfString): String;
var
  I: Integer;
begin
  Result := '';
  for I := 0 to GetArrayLength(Lines) - 1 do begin
    Log(Lines[I]);
    if Length(Result) < 1800 then
      Result := Result + Lines[I] + #13#10;
  end;
end;

procedure GrantWebViewReadExecute(const Sid: String);
var
  RuntimeDir, Parameters, Details: String;
  ResultCode: Integer;
  Output: TExecOutput;
begin
  RuntimeDir := ExpandConstant('{app}\runtime\webview2');
  if not DirExists(RuntimeDir) then
    RaiseException('安装包缺少固定 WebView2 运行时目录：' + RuntimeDir);
  { Only this application's WebView2 directory receives inheritable RX. }
  Parameters := '"' + RuntimeDir + '" /grant "*' + Sid + ':(OI)(CI)(RX)"';
  Log('WebView2 runtime ACL: icacls ' + Parameters);
  if not ExecAndCaptureOutput(ExpandConstant('{sys}\icacls.exe'), Parameters,
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode, Output) then
    RaiseException('无法启动 WebView2 权限设置工具。Windows 错误 ' +
      IntToStr(ResultCode) + '：' + SysErrorMessage(ResultCode));
  Details := OutputText(Output.StdOut) + OutputText(Output.StdErr);
  if ResultCode <> 0 then
    RaiseException('无法设置固定 WebView2 运行时的读取和执行权限。' + #13#10 +
      '目录：' + RuntimeDir + #13#10 + '返回码：' + IntToStr(ResultCode) + #13#10 +
      Details + #13#10 + '请保存安装日志，并检查此目录的访问权限后重新安装。');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    WebViewPermissionsReady := False;
    GrantWebViewReadExecute('S-1-15-2-1');
    GrantWebViewReadExecute('S-1-15-2-2');
    WebViewPermissionsReady := True;
  end;
end;

function CanLaunchApplication: Boolean;
begin
  Result := WebViewPermissionsReady;
end;

function GetCustomSetupExitCode: Integer;
begin
  if WebViewPermissionsReady then Result := 0 else Result := 1;
end;

// No [UninstallDelete]. User-created workspace files are outside {app}:
// {localappdata}\SatelliteDatasetStudioV2\workspace
