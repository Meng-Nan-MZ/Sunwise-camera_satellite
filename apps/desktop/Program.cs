using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace SatelliteStudio.Desktop;

internal static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        var application = new Application();
        try { application.Run(new StudioWindow(LaunchOptions.Parse(args))); }
        catch (Exception error) { MessageBox.Show(error.Message, "Satellite Dataset Studio V2.1", MessageBoxButton.OK, MessageBoxImage.Error); }
    }
}

internal sealed class StudioWindow : Window
{
    private readonly LaunchOptions options;
    private readonly ServiceProcess service;
    private readonly CancellationTokenSource closing = new();
    private WebView2? browser;

    public StudioWindow(LaunchOptions options)
    {
        this.options = options;
        service = new ServiceProcess(options);
        Title = "Satellite Dataset Studio V2.1";
        Width = 1440; Height = 960; MinWidth = 1080; MinHeight = 720;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = new SolidColorBrush(Color.FromRgb(14, 20, 29));
        ShowMessage("正在启动本机工作台…");
        service.Failed += message => Dispatcher.InvokeAsync(() => ShowMessage(message));
        Loaded += async (_, _) => await StartAsync();
        Closed += (_, _) => { closing.Cancel(); browser?.Dispose(); service.Dispose(); closing.Dispose(); };
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
                    new Window { Title = "正式图像 · Satellite Dataset Studio V2.1", Owner = this,
                        Width = 900, Height = 900, Background = Brushes.Black, Content = image }.Show();
                }
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
}
