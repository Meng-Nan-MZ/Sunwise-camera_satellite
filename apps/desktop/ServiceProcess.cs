using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text;

namespace SatelliteStudio.Desktop;

internal sealed class ServiceProcess : IDisposable
{
    private readonly LaunchOptions options;
    private readonly TaskCompletionSource<Uri> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object logLock = new();
    private Process? process;
    private StreamWriter? log;
    private bool disposed;
    private bool started;
    public event Action<string>? Failed;

    public ServiceProcess(LaunchOptions options) => this.options = options;

    public async Task<Uri> StartAsync(CancellationToken cancellation)
    {
        options.ValidateFiles();
        var logDirectory = Path.Combine(options.Workspace, "logs");
        Directory.CreateDirectory(logDirectory);
        log = new StreamWriter(Path.Combine(logDirectory, "desktop-service.log"), append: true) { AutoFlush = true };
        var start = new ProcessStartInfo(options.Python)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = options.ProjectRoot
        };
        foreach (var arg in new[] { "-B", "-u", "-X", "utf8", "-m", "satellite_studio", "--project-root", options.ProjectRoot,
                     "--workspace", options.Workspace, "--blender", options.Blender, "--port", "0" })
            start.ArgumentList.Add(arg);
        start.Environment["PYTHONPATH"] = Path.Combine(options.ProjectRoot, "python", "src");
        start.Environment["PYTHONUTF8"] = "1";
        start.Environment["PYTHONDONTWRITEBYTECODE"] = "1";
        process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => Receive(e.Data, true);
        process.ErrorDataReceived += (_, e) => Receive(e.Data, false);
        process.Exited += (_, _) =>
        {
            if (disposed) return;
            var message = $"本机服务已退出。请查看 {logDirectory}";
            ready.TrySetException(new InvalidOperationException(message));
            Failed?.Invoke(message);
        };
        started = process.Start();
        if (!started) throw new InvalidOperationException("无法启动本机服务进程");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return await ready.Task.WaitAsync(TimeSpan.FromSeconds(60), cancellation);
    }

    private void Receive(string? line, bool stdout)
    {
        if (line is null) return;
        lock (logLock) { log?.WriteLine(line); }
        if (!stdout || !line.StartsWith('{')) return;
        try
        {
            using var message = JsonDocument.Parse(line);
            if (message.RootElement.TryGetProperty("event", out var kind) && kind.GetString() == "ready")
            {
                var port = message.RootElement.GetProperty("port").GetInt32();
                if (port is > 0 and <= 65535) ready.TrySetResult(new Uri($"http://127.0.0.1:{port}/"));
            }
        }
        catch (JsonException) { /* Application logs may also start with a brace. */ }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (process is not null)
        {
            if (started && !process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(5000);
            }
            process.Dispose();
            process = null;
        }
        lock (logLock) { log?.Dispose(); log = null; }
    }
}
