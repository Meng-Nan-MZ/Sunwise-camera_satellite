using SatelliteStudio.Desktop;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

// A real child process exercises argument/environment forwarding and cleanup
// without making this desktop-only suite depend on a particular Python install.
if (args.Contains("-m") && args.Contains("satellite_studio"))
{
    var childWorkspace = args[Array.IndexOf(args, "--workspace") + 1];
    File.WriteAllText(Path.Combine(childWorkspace, "child-probe.json"), JsonSerializer.Serialize(new
    {
        Arguments = args, ProcessId = Environment.ProcessId, CurrentDirectory = Environment.CurrentDirectory,
        PythonPath = Environment.GetEnvironmentVariable("PYTHONPATH"),
        PythonUtf8 = Environment.GetEnvironmentVariable("PYTHONUTF8"),
        DontWriteBytecode = Environment.GetEnvironmentVariable("PYTHONDONTWRITEBYTECODE")
    }));
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
    "--blender", Path.Combine(project, "runtime/blender/blender.exe"), "--workspace", workspace];

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
    await Check("no arguments resolve the executable package, not the unrelated CWD", () =>
    {
        var options = LaunchOptions.Parse([]);
        Require(Path.TrimEndingDirectorySeparator(options.ProjectRoot) == Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory), "Package root followed the current directory");
        Require(options.Python == Path.Combine(AppContext.BaseDirectory, "runtime", "python", "python.exe"), "Bundled Python path was not selected");
        Require(options.Blender == Path.Combine(AppContext.BaseDirectory, "runtime", "blender", "blender.exe"), "Bundled Blender path was not selected");
        Require(options.WebView2Runtime == Path.Combine(AppContext.BaseDirectory, "runtime", "webview2"), "Fixed WebView2 must be selected even when not present yet");
        Require(options.Workspace == Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SatelliteDatasetStudio", "workspace"), "Default data directory must be in LocalAppData");
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
        Require(options.Python == Path.Combine(project, "runtime", "python", "python.exe") && options.Blender == Path.Combine(project, "runtime", "blender", "blender.exe"), "Explicit executable paths changed");
        Require(options.WebView2Runtime is null, "Original complete development command must remain usable with installed WebView2");
        return Task.CompletedTask;
    });
    foreach (var (name, arguments) in new (string, string[])[]
    {
        ("unknown switch", [.. DevelopmentArguments(), "--typo", "value"]),
        ("positional argument", [.. DevelopmentArguments(), "unexpected", "value"]),
        ("missing value", [.. DevelopmentArguments(), "--webview2"]),
        ("switch used as path", [.. DevelopmentArguments(), "--webview2", "--unknown"]),
        ("duplicate option", [.. DevelopmentArguments(), "--python", "other.exe"]),
        ("blank path", [.. DevelopmentArguments(), "--webview2", "   "]),
    })
        await Check("reject " + name, () => { RejectArguments(arguments); return Task.CompletedTask; });

    foreach (var relative in new[] { "apps/ui/dist/index.html", "python/src/satellite_studio/__main__.py",
        "assets/models/index.json", "runtime/python/python.exe", "runtime/blender/blender.exe", "runtime/webview2/msedgewebview2.exe" })
        WriteFixture(relative);
    foreach (var relative in new[] { "runtime/python/python.exe", "runtime/blender/blender.exe",
        "apps/ui/dist/index.html", "python/src/satellite_studio/__main__.py", "assets/models/index.json" })
        await Check("missing package file: " + relative, () => MissingFileFailsBeforeStarting(relative));
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
    await Check("real child receives safe paths and no-bytecode settings, then exits on disposal", async () =>
    {
        var options = LaunchOptions.Parse(DevelopmentArguments()) with { Python = Environment.ProcessPath! };
        var service = new ServiceProcess(options);
        var childId = 0;
        try
        {
            var uri = await service.StartAsync(CancellationToken.None);
            Require(uri == new Uri("http://127.0.0.1:49123/"), "Ready event was not consumed");
            using var probe = JsonDocument.Parse(File.ReadAllText(Path.Combine(workspace, "child-probe.json")));
            var root = probe.RootElement;
            childId = root.GetProperty("ProcessId").GetInt32();
            var arguments = root.GetProperty("Arguments").EnumerateArray().Select(item => item.GetString()).ToArray();
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
