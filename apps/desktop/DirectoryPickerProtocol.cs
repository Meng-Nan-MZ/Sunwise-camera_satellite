using System.Text.Json;

namespace SatelliteStudio.Desktop;

internal sealed record DirectoryPickerRequest(string RequestId, string InitialDirectory);

internal sealed class DirectoryPickerProtocol
{
    // A maximum-length path may be encoded entirely as six-character JSON escapes.
    private const int MaximumMessageLength = 200000;
    private DirectoryPickerRequest? active;

    public static bool TryParseRequest(string source, string json, Uri serviceOrigin, out DirectoryPickerRequest? request)
    {
        request = null;
        if (json.Length > MaximumMessageLength ||
            !Uri.TryCreate(source, UriKind.Absolute, out var sender) ||
            sender.Scheme != serviceOrigin.Scheme || sender.Host != serviceOrigin.Host ||
            sender.Port != serviceOrigin.Port || sender.UserInfo.Length != 0)
            return false;
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            var fields = new HashSet<string>(StringComparer.Ordinal);
            foreach (var field in root.EnumerateObject())
            {
                if (field.Name is not ("type" or "request_id" or "initial_directory") ||
                    !fields.Add(field.Name) || field.Value.ValueKind != JsonValueKind.String) return false;
            }
            if (fields.Count != 3 || root.GetProperty("type").GetString() != "satellite.select-output-directory") return false;
            var id = root.GetProperty("request_id").GetString()!;
            var initial = root.GetProperty("initial_directory").GetString()!;
            if (string.IsNullOrWhiteSpace(id) || id.Length > 64 || initial.Length > 32767) return false;
            request = new DirectoryPickerRequest(id, initial);
            return true;
        }
        catch (JsonException) { return false; }
    }

    // Accessed only on the window dispatcher; ShowDialog runs a nested dispatcher loop.
    public bool TryAcquire(DirectoryPickerRequest request)
    {
        if (active is not null) return false;
        active = request;
        return true;
    }

    public string? Complete(string requestId, string? path, string? error = null)
    {
        if (active is null || active.RequestId != requestId) return null;
        var reply = Reply(active, path, error);
        active = null;
        return reply;
    }

    public static string Reply(DirectoryPickerRequest request, string? path, string? error = null)
    {
        var result = new Dictionary<string, object?>
        {
            ["type"] = "satellite.output-directory-selected", ["request_id"] = request.RequestId, ["path"] = path
        };
        if (error is not null) result["error"] = error;
        return JsonSerializer.Serialize(result);
    }
}
