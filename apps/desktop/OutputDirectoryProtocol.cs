using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;

namespace SatelliteStudio.Desktop;

internal sealed record OutputDirectoryRequest(string RequestId, string Target, string? JobId);

// Source validation and directory resolution live in the native host. The UI never supplies a path.
internal sealed class OutputDirectoryProtocol(HttpClient client, Action<string> open, TimeSpan? timeout = null)
{
    private int active;
    public static bool TryParseRequest(string source, string json, Uri origin, out OutputDirectoryRequest? request)
    {
        request = null;
        if (json.Length > 2048 || !Uri.TryCreate(source, UriKind.Absolute, out var sender) ||
            sender.Scheme != origin.Scheme || sender.Host != origin.Host || sender.Port != origin.Port || sender.UserInfo.Length != 0)
            return false;
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            var fields = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in root.EnumerateObject())
                if (field.Name is not ("type" or "request_id" or "target" or "job_id") ||
                    !fields.Add(field.Name) || field.Value.ValueKind != JsonValueKind.String) return false;
            if (!fields.Contains("type") || !fields.Contains("request_id") || !fields.Contains("target") ||
                root.GetProperty("type").GetString() != "satellite.open-output-directory") return false;
            var id = root.GetProperty("request_id").GetString()!;
            var target = root.GetProperty("target").GetString()!;
            var job = fields.Contains("job_id") ? root.GetProperty("job_id").GetString() : null;
            if (string.IsNullOrWhiteSpace(id) || id.Length > 64) return false;
            if (target == "output-root") { if (job is not null) return false; }
            else if (target == "job-output")
            {
                if (job is null || job.Length != 32 || job.Any(c => !(c is >= '0' and <= '9' or >= 'a' and <= 'f'))) return false;
            }
            else return false;
            request = new(id, target, job);
            return true;
        }
        catch (JsonException) { return false; }
    }

    public async Task<string?> HandleAsync(string source, string json, Uri origin, CancellationToken cancellation)
    {
        if (cancellation.IsCancellationRequested || !TryParseRequest(source, json, origin, out var request)) return null;
        if (Interlocked.CompareExchange(ref active, 1, 0) != 0) return Reply(request!, "正在打开文件夹，请稍后重试。");
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            deadline.CancelAfter(timeout ?? TimeSpan.FromSeconds(5));
            var path = request!.Target == "output-root" ? "/api/settings/output-directory" : "/api/jobs/" + request.JobId;
            using var response = await client.GetAsync(new Uri(origin, path), HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            response.EnsureSuccessStatusCode();
            // Job details may include long frozen parameter snapshots. Bound the native response regardless.
            const int maximumResponseBytes = 1024 * 1024;
            using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            using var body = new MemoryStream();
            var buffer = new byte[8192];
            int count;
            while ((count = await stream.ReadAsync(buffer, deadline.Token)) != 0)
            {
                if (body.Length + count > maximumResponseBytes) throw new InvalidDataException();
                body.Write(buffer, 0, count);
            }
            using var document = JsonDocument.Parse(body.ToArray(), new JsonDocumentOptions { MaxDepth = 64 });
            if (!document.RootElement.TryGetProperty("output_directory", out var field) || field.ValueKind != JsonValueKind.String)
                throw new InvalidDataException();
            var directory = field.GetString()!;
            if (directory.Length > 32767 || !Path.IsPathFullyQualified(directory) || !Directory.Exists(directory))
                throw new DirectoryNotFoundException();
            deadline.Token.ThrowIfCancellationRequested();
            open(Path.GetFullPath(directory));
            return cancellation.IsCancellationRequested ? null : Reply(request, null);
        }
        catch (OperationCanceledException)
        {
            return cancellation.IsCancellationRequested ? null : Reply(request!, "打开文件夹超时，请重试。");
        }
        catch (Exception)
        {
            return cancellation.IsCancellationRequested ? null : Reply(request!, "无法打开文件夹，请确认输出目录仍然存在后重试。");
        }
        finally { Interlocked.Exchange(ref active, 0); }
    }

    private static string Reply(OutputDirectoryRequest request, string? error) => JsonSerializer.Serialize(new
    {
        type = "satellite.output-directory-opened", request_id = request.RequestId, error
    });

    public static void OpenExplorer(string directory)
    {
        // Invoke Explorer directly with one argument; no shell command or client-provided executable.
        var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"))
        { UseShellExecute = false };
        start.ArgumentList.Add(directory);
        using var process = Process.Start(start);
    }
}
