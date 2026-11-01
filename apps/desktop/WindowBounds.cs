namespace SatelliteStudio.Desktop;

// All arguments are WPF logical pixels (DIPs), including SystemParameters.WorkArea.
internal sealed record WindowBounds(double Left, double Top, double Width, double Height, double MinWidth, double MinHeight)
{
    public static WindowBounds Calculate(double left, double top, double width, double height)
    {
        if (!double.IsFinite(left) || !double.IsFinite(top) || !double.IsFinite(width) || !double.IsFinite(height) || width <= 0 || height <= 0)
            throw new ArgumentOutOfRangeException(nameof(width), "A finite positive work area is required.");
        var margin = Math.Min(16, Math.Min(width, height) / 10);
        var windowWidth = Math.Min(1120, width - 2 * margin);
        var windowHeight = Math.Min(680, height - 2 * margin);
        return new(left + (width - windowWidth) / 2, top + (height - windowHeight) / 2,
            windowWidth, windowHeight, Math.Min(960, windowWidth), Math.Min(600, windowHeight));
    }
}
