using SatelliteStudio.Desktop;
using System.Net;
using System.Text;
using System.Text.Json;

internal static class CompactHostChecks
{
    public static async Task Run(Func<string, Func<Task>, Task> check, Action<bool, string> require, string temp)
    {
        await check("window sizing respects DIP work area, taskbars and tiny monitors", () =>
        {
            foreach (var (w,h) in new[] { (1920d,1040d), (1366d,728d), (1366d/1.25,728d/1.25), (768d,1366d), (600d,420d), (80d,60d) })
            {
                var bounds = WindowBounds.Calculate(-300, 40, w, h);
                require(bounds.Width <= w && bounds.Height <= h, "Window exceeds working area");
                require(bounds.Left >= -300 && bounds.Top >= 40 && bounds.Left + bounds.Width <= -300+w && bounds.Top + bounds.Height <= 40+h, "Window position exceeds working area");
                require(bounds.MinWidth <= bounds.Width && bounds.MinHeight <= bounds.Height, "Minimum size overrides available space");
                require(bounds.Width > 0 && bounds.Height > 0, "Invalid size");
            }
            var preferred = WindowBounds.Calculate(0,0,1920,1040);
            require(preferred.Width == 1120 && preferred.Height == 680, "Preferred compact size changed");
            return Task.CompletedTask;
        });
        var origin = new Uri("http://127.0.0.1:49123/");
        const string job = "0123456789abcdef0123456789abcdef";
        string Message(string target = "output-root", string? id = null) => JsonSerializer.Serialize(new Dictionary<string,object?> { ["type"]="satellite.open-output-directory", ["request_id"]="open-1", ["target"]=target }.Concat(id is null ? [] : new Dictionary<string,object?> { ["job_id"]=id }).ToDictionary(x=>x.Key,x=>x.Value));
        await check("folder opener accepts only strict same-origin bounded requests without UI paths", () =>
        {
            require(OutputDirectoryProtocol.TryParseRequest(origin.ToString(), Message(), origin, out _), "Root rejected");
            require(OutputDirectoryProtocol.TryParseRequest(origin.ToString(), Message("job-output",job), origin, out _), "Job rejected");
            foreach(var source in new[] {"https://127.0.0.1:49123/","http://localhost:49123/","http://127.0.0.1:49124/","http://user@127.0.0.1:49123/","null"})
                require(!OutputDirectoryProtocol.TryParseRequest(source, Message(), origin, out _), "Wrong origin accepted");
            foreach(var json in new[] {"{","[]","null",Message("else"),Message("job-output"),Message("output-root",job),Message("job-output","../foo"),Message("job-output",job.ToUpperInvariant()),Message().Replace("open-1",new string('x',65)),Message().Replace("open-1","  "),Message().Replace("}",",\"path\":\"C:\\\\Windows\"}"),Message().Replace("}",",\"target\":\"output-root\"}"),new string(' ',2100)+Message()})
                require(!OutputDirectoryProtocol.TryParseRequest(origin.ToString(), json, origin, out _), "Malformed message accepted: "+json);
            return Task.CompletedTask;
        });
        await check("folder opener resolves applied root and frozen job directories using its own GET", async () =>
        {
            var paths = new List<string>(); var endpoints = new List<string>();
            using var client = new HttpClient(new ReplyHandler((request,_) => { endpoints.Add(request.RequestUri!.AbsolutePath); return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(new { output_directory=temp })) }); }));
            var host = new OutputDirectoryProtocol(client, paths.Add);
            foreach(var json in new[] {Message(),Message("job-output",job)})
            {
                using var reply = JsonDocument.Parse((await host.HandleAsync(origin.ToString(),json,origin,CancellationToken.None))!);
                require(reply.RootElement.GetProperty("type").GetString()=="satellite.output-directory-opened" && reply.RootElement.GetProperty("request_id").GetString()=="open-1" && reply.RootElement.GetProperty("error").ValueKind==JsonValueKind.Null,"Wrong correlated response");
            }
            require(paths.SequenceEqual(new[]{temp,temp}), "Service directory was not opened");
            require(endpoints.SequenceEqual(new[]{"/api/settings/output-directory","/api/jobs/"+job}),"Wrong authoritative endpoints");
        });
        await check("folder opener rejects missing/relative/file directories and service errors", async () =>
        {
            foreach (var path in new[] {"relative", Path.Combine(temp,"missing"), Path.Combine(temp,"file.txt"), ""})
            {
                File.WriteAllText(Path.Combine(temp,"file.txt"),"fixture");
                using var client = new HttpClient(new ReplyHandler((_,_)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(JsonSerializer.Serialize(new { output_directory=path }))})));
                var opened=false; var host=new OutputDirectoryProtocol(client,_=>opened=true);
                using var reply=JsonDocument.Parse((await host.HandleAsync(origin.ToString(),Message(),origin,CancellationToken.None))!);
                require(!opened && reply.RootElement.GetProperty("error").ValueKind==JsonValueKind.String,"Unsafe resolved directory opened");
            }
        });
        await check("folder opener reports HTTP, malformed service replies and opener failures", async () =>
        {
            foreach(var (status,body) in new[] { (HttpStatusCode.NotFound,"{}"), (HttpStatusCode.OK,"{"), (HttpStatusCode.OK,"[]"), (HttpStatusCode.OK,"{\"output_directory\":3}"), (HttpStatusCode.OK,"{}"), (HttpStatusCode.OK,new string(' ',1048577)) })
            {
                var opened=false;
                using var client = new HttpClient(new ReplyHandler((_,_)=>Task.FromResult(new HttpResponseMessage(status) { Content=new StringContent(body) })));
                var host = new OutputDirectoryProtocol(client,_=>opened=true);
                using var result=JsonDocument.Parse((await host.HandleAsync(origin.ToString(),Message(),origin,CancellationToken.None))!);
                require(!opened && result.RootElement.GetProperty("error").ValueKind==JsonValueKind.String,"Service failure opened a directory");
            }
            using var validClient = new HttpClient(new ReplyHandler((_,_)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content=new StringContent(JsonSerializer.Serialize(new{ output_directory=temp })) })));
            var failing = new OutputDirectoryProtocol(validClient,_=>throw new System.ComponentModel.Win32Exception("fixture"));
            using var failed=JsonDocument.Parse((await failing.HandleAsync(origin.ToString(),Message(),origin,CancellationToken.None))!);
            require(failed.RootElement.GetProperty("error").ValueKind==JsonValueKind.String,"Opener failure swallowed");
            using var closed=new CancellationTokenSource(); closed.Cancel();
            require(await failing.HandleAsync(origin.ToString(),Message(),origin,closed.Token) is null,"Already closed host replied");
        });

        await check("folder opener rejects concurrent requests, cancels on close and timeout without launching", async () =>
        {
            var started = new TaskCompletionSource();
            using var client = new HttpClient(new ReplyHandler(async (_,token)=> { started.TrySetResult(); await Task.Delay(Timeout.Infinite,token); return new HttpResponseMessage(); }));
            var opened=false; var host = new OutputDirectoryProtocol(client,_=>opened=true,TimeSpan.FromMilliseconds(100));
            using var close = new CancellationTokenSource();
            var pending=host.HandleAsync(origin.ToString(),Message(),origin,close.Token);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(3));
            using var busy=JsonDocument.Parse((await host.HandleAsync(origin.ToString(),Message(),origin,close.Token))!);
            require(busy.RootElement.GetProperty("error").ValueKind==JsonValueKind.String,"Concurrent open accepted");
            close.Cancel(); require(await pending is null && !opened,"Close launched or replied");
            using var timeout=JsonDocument.Parse((await host.HandleAsync(origin.ToString(),Message(),origin,CancellationToken.None))!);
            require(timeout.RootElement.GetProperty("error").ValueKind==JsonValueKind.String && !opened,"Timeout launched");
            require(await host.HandleAsync("null",Message(),origin,CancellationToken.None) is null,"Invalid request replied");
        });
    }
}
internal sealed class ReplyHandler(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> callback) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => callback(request,token);
}
