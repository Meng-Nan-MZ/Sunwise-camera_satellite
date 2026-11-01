using SatelliteStudio.Desktop;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

// A real child process exercises argument/environment forwarding and cleanup
// without making this desktop-only suite depend on a particular Python install.
if (args.Contains("-m") && args.Contains("satellite_studio"))
{
    var childWorkspace = args[Array.IndexOf(args, "--workspace") + 1];
    if (File.Exists(Path.Combine(childWorkspace, "legacy.db")))
    {
        Console.Error.WriteLine("V1 workspace rejected: incompatible coordinate protocol; choose a new V2 workspace.");
        Environment.ExitCode = 1;
        return;
    }
    Directory.CreateDirectory(childWorkspace);
    File.WriteAllText(Path.Combine(childWorkspace, "child-probe.json"), JsonSerializer.Serialize(new
    {
        Arguments = args, ProcessId = Environment.ProcessId, CurrentDirectory = Environment.CurrentDirectory,
        PythonPath = Environment.GetEnvironmentVariable("PYTHONPATH"),
        PythonUtf8 = Environment.GetEnvironmentVariable("PYTHONUTF8"),
        DontWriteBytecode = Environment.GetEnvironmentVariable("PYTHONDONTWRITEBYTECODE")
    }));
    Console.WriteLine("startup stdout diagnostic");
    Console.Error.WriteLine("startup stderr diagnostic");
    Console.WriteLine("{\"event\":\"ready\",\"port\":\"invalid\"}");
    Console.WriteLine("{\"event\":\"ready\",\"port\":49123}");
    await Task.Delay(Timeout.Infinite);
    return;
}

Native.SetErrorMode(0x0001 | 0x0002 | 0x8000);
var directory = Path.Combine(Path.GetTempPath(), "satellite-host-test-" + Guid.NewGuid());
var project = Path.Combine(directory, "安装 中文 package");
var workspace = Path.Combine(directory, "用户 数据");
var originalDirectory = Environment.CurrentDirectory;
Directory.CreateDirectory(project);
var failures = new List<string>();
var passed = 0;

void Require(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

async Task Check(string name, Func<Task> test)
{
    try { await test(); passed++; Console.WriteLine("PASS: " + name); }
    catch (Exception error) { failures.Add(name); Console.WriteLine($"FAIL: {name}: {error.GetType().Name}: {error.Message}"); }
}

void RejectArguments(string[] arguments)
{
    try { LaunchOptions.Parse(arguments); }
    catch (ArgumentException) { return; }
    throw new Exception("Malformed launch arguments were accepted");
}

void WriteFixture(string relative)
{
    var file = Path.Combine(project, relative);
    Directory.CreateDirectory(Path.GetDirectoryName(file)!);
    File.WriteAllText(file, "test fixture; not an executable");
}

string[] DevelopmentArguments() => ["--project-root", project, "--python", Path.Combine(project, "runtime/python/python.exe"),
    "--workspace", workspace];

async Task MissingFileFailsBeforeStarting(string relative, bool fixedBrowser = false)
{
    var path = Path.GetFullPath(Path.Combine(project, relative));
    File.Move(path, path + ".held");
    try
    {
        var arguments = DevelopmentArguments();
        if (fixedBrowser) arguments = [.. arguments, "--webview2", Path.Combine(project, "runtime/webview2")];
        using var service = new ServiceProcess(LaunchOptions.Parse(arguments));
        try { await service.StartAsync(CancellationToken.None); }
        catch (FileNotFoundException error)
        {
            Require(error.FileName == path, "Missing-file error must identify the exact package file");
            return;
        }
        throw new Exception("Missing runtime or application file did not stop startup");
    }
    finally { File.Move(path + ".held", path); }
}

try
{
    Environment.CurrentDirectory = directory;
    await CompactHostChecks.Run(Check, Require, directory);
    var pickerOrigin = new Uri("http://127.0.0.1:49123/");
    string PickerJson(string id = "pick-中文", string initial = "D:\\图像 数据") => JsonSerializer.Serialize(new
    {
        type = "satellite.select-output-directory", request_id = id, initial_directory = initial
    });
    await Check("picker accepts exact service origin and preserves Chinese/spaced directory and correlation", () =>
    {
        Require(DirectoryPickerProtocol.TryParseRequest("http://127.0.0.1:49123/?view=main", PickerJson(), pickerOrigin, out var request), "Valid picker request rejected");
        Require(request == new DirectoryPickerRequest("pick-中文", "D:\\图像 数据"), "Request fields changed");
        return Task.CompletedTask;
    });
    await Check("picker rejects a different scheme, host, port, credentials or invalid source", () =>
    {
        foreach (var source in new[] { "https://127.0.0.1:49123/", "http://localhost:49123/", "http://127.0.0.1:49124/",
            "http://127.0.0.1:49123.evil.test/", "http://user@127.0.0.1:49123/", "null", "file:///test.html" })
            Require(!DirectoryPickerProtocol.TryParseRequest(source, PickerJson(), pickerOrigin, out _), "Unsafe source accepted: " + source);
        return Task.CompletedTask;
    });
    await Check("picker rejects malformed, unrelated, non-object and duplicate or extra fields", () =>
    {
        foreach (var json in new[] { "{", "[]", "null", "{}", "\"hello\"",
            "{\"type\":\"other\",\"request_id\":\"a\",\"initial_directory\":\"\"}",
            "{\"type\":\"satellite.select-output-directory\",\"request_id\":\"a\"}",
            "{\"type\":\"satellite.select-output-directory\",\"request_id\":3,\"initial_directory\":\"\"}",
            "{\"type\":\"satellite.select-output-directory\",\"request_id\":\"a\",\"initial_directory\":null}",
            "{\"type\":\"satellite.select-output-directory\",\"request_id\":\"a\",\"initial_directory\":\"\",\"command\":\"run\"}",
            "{\"type\":\"satellite.select-output-directory\",\"request_id\":\"a\",\"request_id\":\"b\",\"initial_directory\":\"\"}" })
            Require(!DirectoryPickerProtocol.TryParseRequest(pickerOrigin.ToString(), json, pickerOrigin, out _), "Invalid JSON accepted: " + json);
        return Task.CompletedTask;
    });
    await Check("picker enforces request ID and directory limits including escaped maximum paths", () =>
    {
        foreach (var json in new[] { PickerJson(""), PickerJson("  "), PickerJson(new string('a', 65)), PickerJson(initial: new string('a', 32768)), new string(' ', 210000) + PickerJson() })
            Require(!DirectoryPickerProtocol.TryParseRequest(pickerOrigin.ToString(), json, pickerOrigin, out _), "Oversized/empty input accepted");
        Require(DirectoryPickerProtocol.TryParseRequest(pickerOrigin.ToString(), PickerJson(new string('a', 64), new string('中', 32767)), pickerOrigin, out _), "Exact supported bounds rejected");
        return Task.CompletedTask;
    });
    await Check("picker serializes correlated cancellation, selection and retriable errors", () =>
    {
        var request = new DirectoryPickerRequest("pick-中文", "D:\\图像 数据");
        foreach (var (path, error) in new (string?, string?)[] { (null, null), ("E:\\选择 空间", null), (null, "请选择文件夹后重试") })
        {
            using var response = JsonDocument.Parse(DirectoryPickerProtocol.Reply(request, path, error));
            var root = response.RootElement;
            Require(root.GetProperty("type").GetString() == "satellite.output-directory-selected", "Wrong reply type");
            Require(root.GetProperty("request_id").GetString() == "pick-中文", "Correlation lost");
            Require(root.GetProperty("path").GetString() == path, "Selection/cancel changed");
            Require(error is null ? !root.TryGetProperty("error", out _) : root.GetProperty("error").GetString() == error, "Error shape changed");
            Require(root.EnumerateObject().Count() == (error is null ? 3 : 4), "Unrelated reply fields leaked");
        }
        return Task.CompletedTask;
    });
    await Check("picker allows one active dialog and ignores unrelated or duplicate completion", () =>
    {
        var protocol = new DirectoryPickerProtocol();
        var request = new DirectoryPickerRequest("first", "");
        Require(protocol.TryAcquire(request), "First dialog rejected");
        Require(!protocol.TryAcquire(new DirectoryPickerRequest("second", "")), "Concurrent dialog allowed");
        Require(protocol.Complete("second", "D:\\wrong") is null, "Wrong completion accepted");
        Require(!protocol.TryAcquire(request), "Wrong completion released active dialog");
        using var reply = JsonDocument.Parse(protocol.Complete("first", null)!);
        Require(reply.RootElement.GetProperty("request_id").GetString() == "first" && reply.RootElement.GetProperty("path").ValueKind == JsonValueKind.Null, "Cancellation lost correlation");
        Require(protocol.Complete("first", "D:\\late") is null, "Late duplicate accepted");
        Require(protocol.TryAcquire(new DirectoryPickerRequest("retry", "")), "Cancellation prevented retry");
        Require(protocol.Complete("retry", null, "Dialog failed") is not null && protocol.TryAcquire(request), "Error prevented retry");
        return Task.CompletedTask;
    });
    await Check("no arguments resolve the executable package, not the unrelated CWD", () =>
    {
        var options = LaunchOptions.Parse([]);
        Require(Path.TrimEndingDirectorySeparator(options.ProjectRoot) == Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory), "Package root followed the current directory");
        Require(options.Python == Path.Combine(AppContext.BaseDirectory, "runtime", "python", "python.exe"), "Bundled Python path was not selected");
        Require(options.WebView2Runtime == Path.Combine(AppContext.BaseDirectory, "runtime", "webview2"), "Fixed WebView2 must be selected even when not present yet");
        Require(options.Workspace == Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SatelliteDatasetStudioV2", "workspace"), "V2 must use an independent LocalAppData directory");
        Require(options.WebView2UserData == Path.Combine(options.Workspace, "userdata"), "WebView2 must not store user data in the package");
        return Task.CompletedTask;
    });
    await Check("workspace-only override retains packaged runtime defaults", () =>
    {
        var options = LaunchOptions.Parse(["--workspace", workspace]);
        Require(options.Workspace == workspace, "Workspace override was ignored");
        Require(options.Python == Path.Combine(AppContext.BaseDirectory, "runtime", "python", "python.exe"), "Workspace changed package runtime lookup");
        Require(options.WebView2Runtime == Path.Combine(AppContext.BaseDirectory, "runtime", "webview2"), "Workspace override must not enable Evergreen fallback");
        Require(options.WebView2UserData == Path.Combine(workspace, "userdata"), "User data did not follow the workspace override");
        return Task.CompletedTask;
    });
    await Check("explicit development paths preserve Chinese characters and spaces", () =>
    {
        var options = LaunchOptions.Parse(DevelopmentArguments());
        Require(options.ProjectRoot == project && options.Workspace == workspace, "Explicit root/workspace changed");
        Require(options.Python == Path.Combine(project, "runtime", "python", "python.exe"), "Explicit executable paths changed");
        Require(options.WebView2Runtime is null, "Original complete development command must remain usable with installed WebView2");
        return Task.CompletedTask;
    });
    foreach (var (name, arguments) in new (string, string[])[]
    {
        ("retired Blender switch", [.. DevelopmentArguments(), "--blender", "unused.exe"]),
        ("unknown switch", [.. DevelopmentArguments(), "--typo", "value"]),
        ("positional argument", [.. DevelopmentArguments(), "unexpected", "value"]),
        ("missing value", [.. DevelopmentArguments(), "--webview2"]),
        ("switch used as path", [.. DevelopmentArguments(), "--webview2", "--unknown"]),
        ("duplicate option", [.. DevelopmentArguments(), "--python", "other.exe"]),
        ("blank path", [.. DevelopmentArguments(), "--webview2", "   "]),
    })
        await Check("reject " + name, () => { RejectArguments(arguments); return Task.CompletedTask; });

    foreach (var relative in new[] { "apps/ui/dist/index.html", "python/src/satellite_studio/__main__.py",
        "assets/models/index.json", "runtime/python/python.exe", "runtime/webview2/msedgewebview2.exe" })
        WriteFixture(relative);
    foreach (var relative in new[] { "runtime/python/python.exe",
        "apps/ui/dist/index.html", "python/src/satellite_studio/__main__.py", "assets/models/index.json" })
        await Check("missing package file: " + relative, () => MissingFileFailsBeforeStarting(relative));
    await Check("GLB-only application validates without any Blender directory", () =>
    {
        Require(!Directory.Exists(Path.Combine(project, "runtime/blender")), "Fixture contains Blender");
        LaunchOptions.Parse(DevelopmentArguments()).ValidateFiles();
        return Task.CompletedTask;
    });
    await Check("missing fixed WebView2 cannot fall back to installed Evergreen", () =>
        MissingFileFailsBeforeStarting("runtime/webview2/msedgewebview2.exe", fixedBrowser: true));

    await Check("failed native process start and repeated disposal are safe", async () =>
    {
        var service = new ServiceProcess(LaunchOptions.Parse(DevelopmentArguments()));
        var failed = false;
        try
        {
            try { await service.StartAsync(CancellationToken.None); }
            catch (System.ComponentModel.Win32Exception) { failed = true; }
            Require(failed, "Invalid executable should fail to start");
        }
        finally { service.Dispose(); service.Dispose(); }
    });
    await Check("legacy workspace refusal preserves every entry and byte and reports the reason", async () =>
    {
        var legacy = Path.Combine(directory, "旧版 V1 workspace");
        Directory.CreateDirectory(Path.Combine(legacy, "logs"));
        File.WriteAllBytes(Path.Combine(legacy, "legacy.db"), [0x53, 0x51, 0x4c, 0, 0xff]);
        File.WriteAllText(Path.Combine(legacy, "logs", "desktop-service.log"), "existing V1 service log\n");
        File.WriteAllText(Path.Combine(legacy, "logs", "desktop-host.log"), "existing V1 host log\n");
        Dictionary<string, string> Snapshot() => Directory.EnumerateFileSystemEntries(legacy, "*", SearchOption.AllDirectories)
            .ToDictionary(path => Path.GetRelativePath(legacy, path), path => Directory.Exists(path)
                ? "directory" : Convert.ToBase64String(File.ReadAllBytes(path)));
        var before = Snapshot();
        string? refusal = null;
        using (var service = new ServiceProcess(LaunchOptions.Parse(DevelopmentArguments()) with
            { Python = Environment.ProcessPath!, Workspace = legacy }))
        {
            try { await service.StartAsync(CancellationToken.None); }
            catch (InvalidOperationException error) { refusal = error.Message; }
            Require(!service.WorkspaceValidated, "Rejected workspace was marked validated");
        }
        var after = Snapshot();
        Require(before.Count == after.Count && before.All(entry => after.TryGetValue(entry.Key, out var value) && value == entry.Value),
            "Desktop changed entries or bytes in the rejected legacy workspace");
        Require(refusal?.Contains("V1 workspace rejected: incompatible coordinate protocol") == true,
            "Startup error lost the child's workspace refusal reason: " + refusal);
    });
    await Check("real child receives safe paths and no-bytecode settings, then exits on disposal", async () =>
    {
        var options = LaunchOptions.Parse(DevelopmentArguments()) with { Python = Environment.ProcessPath! };
        var service = new ServiceProcess(options);
        var childId = 0;
        try
        {
            var uri = await service.StartAsync(CancellationToken.None);
            Require(uri == new Uri("http://127.0.0.1:49123/"), "Ready event was not consumed");
            Require(service.WorkspaceValidated, "Ready event did not mark the workspace validated");
            using var probe = JsonDocument.Parse(File.ReadAllText(Path.Combine(workspace, "child-probe.json")));
            var root = probe.RootElement;
            childId = root.GetProperty("ProcessId").GetInt32();
            var arguments = root.GetProperty("Arguments").EnumerateArray().Select(item => item.GetString()).ToArray();
            Require(!arguments.Contains("--blender"), "Child must receive no Blender startup flag");
            Require(arguments.Contains("-B"), "Child interpreter must suppress bytecode even in isolated mode");
            var utf8Option = Array.IndexOf(arguments, "-X");
            Require(utf8Option >= 0 && arguments[utf8Option + 1] == "utf8", "Isolated embedded Python must enable UTF-8 explicitly");
            Require(root.GetProperty("DontWriteBytecode").GetString() == "1", "Child environment must disable source bytecode writes");
            Require(root.GetProperty("PythonUtf8").GetString() == "1", "Child service must use UTF-8");
            Require(root.GetProperty("PythonPath").GetString() == Path.Combine(project, "python", "src"), "Development import path changed");
            Require(root.GetProperty("CurrentDirectory").GetString() == project, "Child CWD must be the project/package root");
            Require(arguments[Array.IndexOf(arguments, "--workspace") + 1] == workspace, "Workspace argument was split or changed");
            Require(arguments[Array.IndexOf(arguments, "--project-root") + 1] == project, "Chinese/spaced root argument was split or changed");
        }
        finally { service.Dispose(); service.Dispose(); }
        var serviceLog = File.ReadAllText(Path.Combine(workspace, "logs", "desktop-service.log"));
        Require(serviceLog.Contains("startup stdout diagnostic") && serviceLog.Contains("startup stderr diagnostic"),
            "Startup stdout/stderr diagnostics were not preserved after ready");
        try
        {
            using var child = Process.GetProcessById(childId);
            Require(child.HasExited, "Service child survived host disposal");
        }
        catch (ArgumentException) { /* A reaped process also proves cleanup. */ }
    });
}
finally
{
    Environment.CurrentDirectory = originalDirectory;
    var cleanup = Path.GetFullPath(directory);
    var tempRoot = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    if (!cleanup.StartsWith(tempRoot, StringComparison.OrdinalIgnoreCase)) throw new Exception("Unsafe test cleanup target");
    Directory.Delete(cleanup, recursive: true);
}
Console.WriteLine($"Desktop checks: {passed} passed, {failures.Count} failed");
Environment.ExitCode = failures.Count == 0 ? 0 : 1;

internal static partial class Native
{
    [DllImport("kernel32.dll")]
    internal static extern uint SetErrorMode(uint mode);
}
