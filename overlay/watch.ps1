# Resident watcher. Emits "<dshForeground> <fullscreen>" every 250ms, e.g. "0 0".
# Also accepts "activate" lines on stdin to bring the DSH main window forward.
# Being resident matters: spawning PowerShell per click cost ~1s (process start +
# Add-Type compile). One long-lived process makes it instant.
#
# fullscreen = the foreground window covers its WHOLE monitor. A maximized window
# only covers the work area, so it does NOT count.
# dshForeground = the foreground window belongs to the DSH main window (matched by
# pid, so our own overlay window can never be mistaken for it).
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IslWatch {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, int flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
}
"@

# The DSH main window is titled "<session> - DeepSeek Harness"; our overlay is also a
# "DeepSeek Harness" process but its window is untitled, so matching on the title keeps
# us from ever mistaking the pill for the app (and avoids slow WMI queries).
$mainPid = 0
$mainHwnd = [IntPtr]::Zero
function Find-MainWindow {
  $script:mainPid = 0
  $script:mainHwnd = [IntPtr]::Zero
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*DeepSeek Harness*') {
      $script:mainPid = $_.Id
      $script:mainHwnd = $_.MainWindowHandle
    }
  }
}
Find-MainWindow

function Activate-Main {
  if ($script:mainPid -eq 0 -or $script:mainHwnd -eq [IntPtr]::Zero) { Find-MainWindow }
  if ($script:mainHwnd -eq [IntPtr]::Zero) { return }
  # Only un-minimize; SW_RESTORE on a MAXIMIZED window would shrink it back to a
  # normal window, which is exactly the "it became a windowed app" complaint.
  if ([IslWatch]::IsIconic($script:mainHwnd)) { [IslWatch]::ShowWindow($script:mainHwnd, 9) | Out-Null }
  # Tap Alt so Windows lets us steal the foreground from another app.
  [IslWatch]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
  [IslWatch]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
  [IslWatch]::SetForegroundWindow($script:mainHwnd) | Out-Null
}

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $reader.ReadLineAsync()

$tick = 0
while ($true) {
  $fg = 0
  $full = 0
  $h = [IslWatch]::GetForegroundWindow()
  if ($h -ne [IntPtr]::Zero -and $h -ne [IslWatch]::GetShellWindow()) {
    $r = New-Object IslWatch+RECT
    if ([IslWatch]::GetWindowRect($h, [ref]$r)) {
      $mon = [IslWatch]::MonitorFromWindow($h, 2)
      $mi = New-Object IslWatch+MONITORINFO
      $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
      if ([IslWatch]::GetMonitorInfo($mon, [ref]$mi)) {
        $t = 2
        if ([Math]::Abs($r.L - $mi.rcMonitor.L) -le $t -and [Math]::Abs($r.T - $mi.rcMonitor.T) -le $t -and
            [Math]::Abs($r.R - $mi.rcMonitor.R) -le $t -and [Math]::Abs($r.B - $mi.rcMonitor.B) -le $t) { $full = 1 }
      }
    }
    $pid2 = 0
    [IslWatch]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    if ($script:mainPid -ne 0 -and [int]$pid2 -eq $script:mainPid) { $fg = 1 }
  }

  # stdin: "activate" from the overlay. Non-blocking via a pending async read.
  if ($pending -and $pending.IsCompleted) {
    $line = $pending.Result
    if ($line -eq $null) {
      $pending = $null          # stdin closed (parent gone) -> stop polling it
    } else {
      $pending = $reader.ReadLineAsync()
      if ($line.Trim() -eq 'activate') { Activate-Main }
    }
  }

  # Re-scan for the main window every ~5s (window can be recreated / pid can change).
  $tick++
  if ($tick % 20 -eq 0) { Find-MainWindow }

  [Console]::Out.WriteLine("$fg $full")
  [Console]::Out.Flush()
  # 150ms：点击到窗口抢到前台最多等这一拍。原来是 700ms，实测点击要 1.5 秒才响应。
  Start-Sleep -Milliseconds 150
}
