param([string]$ReadyPath, [string]$StopPath, [string]$ResultPath)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FocusEvidence {
  public delegate void Callback(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint a, uint b, IntPtr mod, Callback cb, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool PeekMessage(out Message msg, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message msg);
  [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr hwnd; public uint msg; public UIntPtr w; public IntPtr l; public uint time; public int x; public int y; public uint priv; }
  static Callback callback = Record;
  static IntPtr hook;
  public static List<uint> Pids = new List<uint>();
  static void Record(IntPtr h, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time) {
    uint pid; GetWindowThreadProcessId(hwnd, out pid); if (pid != 0) Pids.Add(pid);
  }
  public static bool Start() {
    hook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0);
    Record(IntPtr.Zero,3,GetForegroundWindow(),0,0,0,0);
    return hook != IntPtr.Zero;
  }
  public static void Pump() { Message msg; while(PeekMessage(out msg,IntPtr.Zero,0,0,1)) DispatchMessage(ref msg); }
  public static void Stop() { if(hook != IntPtr.Zero) UnhookWinEvent(hook); }
}
'@
$installed = [FocusEvidence]::Start()
@{ hookInstalled=$installed } | ConvertTo-Json | Set-Content -LiteralPath $ReadyPath -Encoding UTF8
try {
  $deadline = [DateTime]::UtcNow.AddMinutes(10)
  while (!(Test-Path -LiteralPath $StopPath) -and [DateTime]::UtcNow -lt $deadline) {
    [FocusEvidence]::Pump()
    Start-Sleep -Milliseconds 30
  }
} finally {
  [FocusEvidence]::Pump()
  [FocusEvidence]::Stop()
  @{ hookInstalled=$installed; foregroundPids=@([FocusEvidence]::Pids) } | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}
