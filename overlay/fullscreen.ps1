# Emit 1 when the foreground window covers its whole monitor (true fullscreen), else 0.
# A maximized window only covers the work area, so it does NOT count.
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IslFs {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
}
"@

while ($true) {
  $full = 0
  $h = [IslFs]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero -and $h -ne [IslFs]::GetShellWindow()) {
    $r = New-Object IslFs+RECT
    if ([IslFs]::GetWindowRect($h, [ref]$r)) {
      $mon = [IslFs]::MonitorFromWindow($h, 2)
      $mi = New-Object IslFs+MONITORINFO
      $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
      if ([IslFs]::GetMonitorInfo($mon, [ref]$mi)) {
        $t = 2
        if ([Math]::Abs($r.L - $mi.rcMonitor.L) -le $t -and [Math]::Abs($r.T - $mi.rcMonitor.T) -le $t -and
            [Math]::Abs($r.R - $mi.rcMonitor.R) -le $t -and [Math]::Abs($r.B - $mi.rcMonitor.B) -le $t) { $full = 1 }
      }
    }
  }
  [Console]::Out.WriteLine($full)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 700
}
