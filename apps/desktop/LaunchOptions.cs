using System.IO;

namespace SatelliteStudio.Desktop;

internal record LaunchOptions(string ProjectRoot, string Workspace, string Python, string? WebView2Runtime = null)
{
    public string WebView2UserData => Path.Combine(Workspace, "userdata");

    public static LaunchOptions Parse(string[] args)
    {
        var options = new Dictionary<string, string>();
        for (var i = 0; i < args.Length; i += 2)
        {
            var name = args[i];
            if (name is not ("--project-root" or "--workspace" or "--python" or "--webview2"))
                throw new ArgumentException($"未知启动参数：{name}");
            if (i + 1 >= args.Length || string.IsNullOrWhiteSpace(args[i + 1]) || args[i + 1].StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException($"启动参数 {name} 后必须提供路径。");
            if (!options.TryAdd(name, Path.GetFullPath(args[i + 1])))
                throw new ArgumentException($"启动参数重复：{name}");
        }
        var root = options.GetValueOrDefault("--project-root", Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory));
        var workspace = options.TryGetValue("--workspace", out var selected)
            ? selected
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SatelliteDatasetStudioV2", "workspace");
        // An explicit project and Python development command may use the
        // installed Evergreen runtime. A workspace override alone stays bundled.
        var developmentLaunch = options.ContainsKey("--project-root") && options.ContainsKey("--python");
        var browser = options.TryGetValue("--webview2", out var fixedRuntime)
            ? fixedRuntime : developmentLaunch ? null : Path.Combine(root, "runtime", "webview2");
        return new(root, workspace,
            options.GetValueOrDefault("--python", Path.Combine(root, "runtime", "python", "python.exe")),
            browser);
    }

    public void ValidateFiles()
    {
        static void Required(string path, string label)
        {
            if (!File.Exists(path))
                throw new FileNotFoundException($"缺少{label}：{path}\n请检查启动路径或重新安装应用。", path);
        }
        Required(Python, " Python 运行时");
        Required(Path.Combine(ProjectRoot, "apps", "ui", "dist", "index.html"), "工作台界面文件");
        Required(Path.Combine(ProjectRoot, "python", "src", "satellite_studio", "__main__.py"), "本机服务文件");
        Required(Path.Combine(ProjectRoot, "assets", "models", "index.json"), "模型清单");
        if (WebView2Runtime is not null)
            Required(Path.Combine(WebView2Runtime, "msedgewebview2.exe"), "固定 WebView2 运行时");
    }
}
