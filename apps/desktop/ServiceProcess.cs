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
    private readonly StringBuilder startupOutput = new();
    private readonly TaskCompletionSource stdoutClosed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource stderrClosed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private Process? process;
    private StreamWriter? log;
    private volatile bool disposed;
    private volatile bool workspaceValidated;
    private bool started;
    public bool WorkspaceValidated => workspaceValidated;
    public event Action<string>? Failed;

    public ServiceProcess(LaunchOptions options) => this.options = options;

    public async Task<Uri> StartAsync(CancellationToken cancellation)
    {
        options.ValidateFiles();
        var start = new ProcessStartInfo(options.Python)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = options.ProjectRoot
        };
        foreach (var arg in new[] { "-B", "-u", "-X", "utf8", "-m", "satellite_studio", "--project-root", options.ProjectRoot,
                     "--workspace", options.Workspace, "--port", "0" })
            start.ArgumentList.Add(arg);
        start.Environment["PYTHONPATH"] = Path.Combine(options.ProjectRoot, "python", "src");
        start.Environment["PYTHONUTF8"] = "1";
        start.Environment["PYTHONDONTWRITEBYTECODE"] = "1";
        process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => Receive(e.Data, true);
        process.ErrorDataReceived += (_, e) => Receive(e.Data, false);
        try
        {
            started = process.Start();
            if (!started) throw new InvalidOperationException("无法启动本机服务进程");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _ = ObserveExitAsync(process);
            return await ready.Task.WaitAsync(TimeSpan.FromSeconds(60), cancellation);
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    private async Task ObserveExitAsync(Process child)
    {
        try
        {
            await child.WaitForExitAsync();
            // Process exit can precede the final redirected stderr callback.
            await Task.WhenAll(stdoutClosed.Task, stderrClosed.Task);
            if (disposed) return;
            string message;
            lock (logLock)
                message = workspaceValidated
                    ? $"本机服务已退出。请查看 {Path.Combine(options.Workspace, "logs")}"
                    : $"本机服务启动失败：{startupOutput.ToString().Trim()}";
            ready.TrySetException(new InvalidOperationException(message));
            Failed?.Invoke(message);
        }
        catch (Exception error)
        {
            // Background process/event failures must reach startup, never escape a callback.
            if (!disposed) ready.TrySetException(error);
        }
    }

    private void Receive(string? line, bool stdout)
    {
        if (line is null)
        {
            (stdout ? stdoutClosed : stderrClosed).TrySetResult();
            return;
        }
        try
        {
            lock (logLock)
            {
                if (disposed) return;
                if (log is not null) log.WriteLine(line);
                else startupOutput.AppendLine(line);
                if (!stdout || !line.StartsWith('{')) return;
                using var message = JsonDocument.Parse(line);
                if (message.RootElement.TryGetProperty("event", out var kind) && kind.ValueKind == JsonValueKind.String &&
                    kind.GetString() == "ready" && message.RootElement.TryGetProperty("port", out var value) &&
                    value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var port) && port is > 0 and <= 65535)
                {
                    // Python emits ready only after its read-only workspace preflight succeeds.
                    workspaceValidated = true;
                    if (log is null)
                    {
                        var logDirectory = Path.Combine(options.Workspace, "logs");
                        Directory.CreateDirectory(logDirectory);
                        var logPath = Path.Combine(logDirectory, "desktop-service.log");
                        try
                        {
                            // Bound unbounded growth: keep one previous generation.
                            if (new FileInfo(logPath).Length > 10 * 1024 * 1024)
                                File.Move(logPath, Path.Combine(logDirectory, "desktop-service.1.log"), overwrite: true);
                        }
                        catch (IOException) { /* Keep appending if rotation fails. */ }
                        log = new StreamWriter(logPath, append: true) { AutoFlush = true };
                        log.Write(startupOutput.ToString());
                        startupOutput.Clear();
                    }
                    ready.TrySetResult(new Uri($"http://127.0.0.1:{port}/"));
                }
            }
        }
        catch (JsonException) { /* Application logs may also start with a brace. */ }
        catch (Exception error) { ready.TrySetException(error); }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (process is not null)
        {
            if (started && !process.HasExited)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(5000);
                }
                catch (InvalidOperationException)
                {
                    // The process exited between the HasExited check and Kill.
                }
            }
            process.Dispose();
            process = null;
        }
        lock (logLock) { log?.Dispose(); log = null; }
    }
}
