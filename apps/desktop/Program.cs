using System.IO;
using System.Net.Http;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;

namespace SatelliteStudio.Desktop;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        var application = new Application();
        try { application.Run(new StudioWindow(LaunchOptions.Parse(args))); }
        catch (Exception error) { MessageBox.Show(error.Message, "Satellite Dataset Studio V2.4.5", MessageBoxButton.OK, MessageBoxImage.Error); }
    }
}

internal sealed class StudioWindow : Window
{
    private readonly LaunchOptions options;
    private readonly ServiceProcess service;
    private readonly CancellationTokenSource closing = new();
    private WebView2? browser;
    private readonly DirectoryPickerProtocol directoryPicker = new();
    private readonly HttpClient directoryClient = new(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false });
    private readonly OutputDirectoryProtocol outputDirectory;
    private bool windowClosed;

    public StudioWindow(LaunchOptions options)
    {
        this.options = options;
        service = new ServiceProcess(options);
        Title = "Satellite Dataset Studio V2.4.5";
        outputDirectory = new OutputDirectoryProtocol(directoryClient, OutputDirectoryProtocol.OpenExplorer);
        var area = SystemParameters.WorkArea;
        var bounds = WindowBounds.Calculate(area.Left, area.Top, area.Width, area.Height);
        Width = bounds.Width; Height = bounds.Height; MinWidth = bounds.MinWidth; MinHeight = bounds.MinHeight;
        Left = bounds.Left; Top = bounds.Top;
        WindowStartupLocation = WindowStartupLocation.Manual;
        Background = new SolidColorBrush(Color.FromRgb(14, 20, 29));
        ShowMessage("正在启动本机工作台…");
        service.Failed += message => Dispatcher.InvokeAsync(() => ShowMessage(message));
        Loaded += async (_, _) => await StartAsync();
        Closed += (_, _) => { windowClosed = true; closing.Cancel(); browser?.Dispose(); service.Dispose(); directoryClient.Dispose(); closing.Dispose(); };
    }

    private void ShowMessage(string message) => Content = new TextBlock
    {
        Text = message, Foreground = Brushes.White, FontSize = 18,
        Margin = new Thickness(40), TextWrapping = TextWrapping.Wrap
    };

    private async Task StartAsync()
    {
        try
        {
            var uri = await service.StartAsync(closing.Token);
            if (closing.IsCancellationRequested) return;
            browser = new WebView2();
            Content = browser;
            var environment = await CoreWebView2Environment.CreateAsync(options.WebView2Runtime, options.WebView2UserData);
            await browser.EnsureCoreWebView2Async(environment);
            if (closing.IsCancellationRequested) return;
            browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            browser.CoreWebView2.NavigationStarting += (_, e) =>
            {
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var target) ||
                    target.Scheme != uri.Scheme || target.Host != uri.Host || target.Port != uri.Port)
                    e.Cancel = true;
            };
            browser.CoreWebView2.NewWindowRequested += (_, e) =>
            {
                e.Handled = true;
                if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var target) &&
                    target.Scheme == uri.Scheme && target.Host == uri.Host && target.Port == uri.Port &&
                    target.AbsolutePath.StartsWith("/data/", StringComparison.Ordinal) &&
                    target.AbsolutePath.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
                {
                    var image = new Image { Source = new BitmapImage(target), Stretch = Stretch.Uniform };
                    new Window { Title = "正式图像 · Satellite Dataset Studio V2.4.5", Owner = this,
                        Width = 900, Height = 900, Background = Brushes.Black, Content = image }.Show();
                }
            };
            browser.CoreWebView2.WebMessageReceived += async (_, e) =>
            {
                SelectOutputDirectory(e, uri);
                await OpenOutputDirectoryAsync(e, uri);
            };
            browser.Source = uri;
            File.AppendAllText(Path.Combine(options.Workspace, "logs", "desktop-host.log"), $"{DateTimeOffset.Now:O} WebView2 ready: {uri}\n");
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            service.Dispose();
            var diagnostics = $"工作台启动失败：{error.Message}";
            if (service.WorkspaceValidated)
            {
                Directory.CreateDirectory(Path.Combine(options.Workspace, "logs"));
                File.AppendAllText(Path.Combine(options.Workspace, "logs", "desktop-host.log"), $"{DateTimeOffset.Now:O} {error}\n");
                diagnostics += $"\n日志位于：{options.Workspace}";
            }
            if (!closing.IsCancellationRequested) ShowMessage(diagnostics);
        }
    }

    private async Task OpenOutputDirectoryAsync(CoreWebView2WebMessageReceivedEventArgs message, Uri origin)
    {
        if (windowClosed || closing.IsCancellationRequested) return;
        string json;
        try { json = message.WebMessageAsJson; }
        catch (ArgumentException) { return; }
        var reply = await outputDirectory.HandleAsync(message.Source, json, origin, closing.Token);
        if (reply is not null) PostPickerReply(reply);
    }

    private void SelectOutputDirectory(CoreWebView2WebMessageReceivedEventArgs message, Uri serviceOrigin)
    {
        if (windowClosed || closing.IsCancellationRequested) return;
        string json;
        try { json = message.WebMessageAsJson; }
        catch (ArgumentException) { return; }
        if (!DirectoryPickerProtocol.TryParseRequest(message.Source, json, serviceOrigin, out var request)) return;
        if (!directoryPicker.TryAcquire(request!))
        {
            PostPickerReply(DirectoryPickerProtocol.Reply(request!, null, "文件夹选择窗口已打开，请完成当前选择后重试。"));
            return;
        }
        // WebView2 disallows a nested modal loop inside its callbacks. Reserve
        // the request now, then open the owned dialog after this event returns.
        try { Dispatcher.BeginInvoke(new Action(() => ShowOutputDirectoryPicker(request!))); }
        catch (Exception)
        {
            var reply = directoryPicker.Complete(request!.RequestId, null, "无法打开文件夹选择窗口，请重试或手动输入路径。");
            if (reply is not null) PostPickerReply(reply);
        }
    }

    private void ShowOutputDirectoryPicker(DirectoryPickerRequest request)
    {
        string? path = null;
        string? error = null;
        try
        {
            if (windowClosed || closing.IsCancellationRequested) return;
            var dialog = new OpenFolderDialog { Title = "选择数据集保存位置", Multiselect = false };
            if (Directory.Exists(request!.InitialDirectory)) dialog.InitialDirectory = request.InitialDirectory;
            if (dialog.ShowDialog(this) == true) path = dialog.FolderName;
        }
        catch (Exception failure) { error = $"无法打开文件夹选择窗口：{failure.Message}。请重试或手动输入路径。"; }
        finally
        {
            var reply = directoryPicker.Complete(request!.RequestId, path, error);
            if (reply is not null) PostPickerReply(reply);
        }
    }

    private void PostPickerReply(string json)
    {
        if (windowClosed || closing.IsCancellationRequested) return;
        browser?.CoreWebView2.PostWebMessageAsJson(json);
    }
}
