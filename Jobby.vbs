' Jobby - Your Job Applications Tracking Buddy. The app itself, for Windows.
'
' Double-click it: the tracker's server starts with no console in the way, and
' the dashboard opens in its own window - Edge or Chrome in app mode, which is a
' plain window with no tab strip and no address bar, with the Jobby icon on the
' taskbar. Closing that window says goodbye to the server, which stops a few
' seconds later, so nothing is left running behind you.
'
' "Start Jobby.bat" is the same thing with a visible console window, for watching
' the server's log and stopping it with Ctrl+C.

Option Explicit

Const PORT = 8787
Const SERVER = "server.py"

Dim shell, fso, root, url, logFile, python, pythonArgs, windowOnly
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:" & PORT
logFile = fso.BuildPath(fso.BuildPath(root, "data"), "server.log")

If Not fso.FileExists(fso.BuildPath(root, SERVER)) Then
  MsgBox "server.py is not next to Jobby.vbs." & vbCrLf & vbCrLf & _
    "Keep this file in the Jobby folder, beside server.py.", vbExclamation, "Jobby"
  WScript.Quit 1
End If

' "Start Jobby.bat" keeps the server in its own console and asks for the window
' only, once the server answers; a window that cannot be opened leaves it there
' to print the error itself.
'
' The flag is a bare word rather than /wait: a named argument is only named with
' a colon and a value (/wait:1), so a slash and a name arrives as a plain
' argument and would be missed. The count is checked on its own line because
' And here does not short-circuit: Arguments(0) would fail on a double-click
' that has no arguments at all.
windowOnly = False
If WScript.Arguments.Count > 0 Then
  windowOnly = (LCase(WScript.Arguments(0)) = "wait")
End If
If windowOnly Then
  If WaitForServer() Then
    OpenDashboard
  End If
  WScript.Quit 0
End If

If Not ServerIsUp() Then
  python = FindPython(pythonArgs)
  If python = "" Then
    MsgBox "Python 3 was not found." & vbCrLf & vbCrLf & _
      "Install Python 3.8 or newer from https://www.python.org/downloads/ and tick " & _
      """Add python.exe to PATH"" during setup, then open Jobby again.", vbExclamation, "Jobby"
    WScript.Quit 1
  End If

  If Not fso.FolderExists(fso.BuildPath(root, "data")) Then
    fso.CreateFolder fso.BuildPath(root, "data")
  End If

  ' Compile can build a real PDF with Tectonic. It is optional: fetch it once
  ' into tools\tectonic, and carry on (in-app preview) if that is not possible.
  shell.CurrentDirectory = root
  shell.Run Quote(python) & pythonArgs & " install_tectonic.py --quiet", 0, True

  StartServer python, pythonArgs

  If Not WaitForServer() Then
    MsgBox "The tracker did not start." & vbCrLf & vbCrLf & _
      "The last lines of data\server.log say why - or run python server.py in the " & _
      "project folder to see the error itself.", vbExclamation, "Jobby"
    WScript.Quit 1
  End If
End If

OpenDashboard
WScript.Quit 0

' ---------------------------------------------------------------------------

Function Quote(value)
  Quote = """" & value & """"
End Function

' The one endpoint that needs no token, so it also answers while the dashboard
' is still starting up. ServerXMLHTTP is the WinHTTP one: it goes straight to
' the address instead of consulting the browser's proxy settings or hunting for
' one, which is what can leave a probe to a closed loopback port waiting for a
' minute - and the wait below is a loop of these. The timeouts hold even that
' to a second.
Function ServerIsUp()
  Dim request
  ServerIsUp = False
  On Error Resume Next
  Set request = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  request.setTimeouts 1000, 1000, 1000, 1000
  request.setProxy 1
  request.Open "GET", url & "/api/health", False
  request.Send
  If Err.Number = 0 Then
    If request.Status = 200 Then ServerIsUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function

' A cold start still has to open the database and (the first time) fetch the
' LaTeX engine, so give it twenty seconds - measured on the clock rather than
' counted in tries, so a probe that spends its own second failing cannot turn
' this into minutes.
Function WaitForServer()
  Dim started
  WaitForServer = False
  started = Now()
  Do While DateDiff("s", started, Now()) < 20
    If ServerIsUp() Then
      WaitForServer = True
      Exit Function
    End If
    WScript.Sleep 200
  Loop
End Function

Sub StartServer(python, extraArgs)
  Dim command
  ' Hidden, with the output appended to data\server.log as the Mac app does.
  ' --exit-when-idle is the backstop: the dashboard stops the server when it
  ' closes, and this catches a window that is killed without saying so.
  command = Quote(python) & extraArgs & " " & Quote(fso.BuildPath(root, SERVER)) & _
    " --port " & PORT & " --exit-when-idle 120 >> " & Quote(logFile) & " 2>&1"
  shell.CurrentDirectory = root
  shell.Run "cmd /c " & Quote(command), 0, False
End Sub

' The interpreter to run, plus any arguments that go before the script. The py
' launcher is asked for Python 3 explicitly, because on a machine that also has
' Python 2 installed it would run that one instead.
Function FindPython(ByRef extraArgs)
  Dim candidate, found
  extraArgs = ""
  For Each candidate In Array("python.exe", "python3.exe", "py.exe")
    found = OnPath(candidate)
    If found <> "" Then
      ' -3, the same thing "Start Jobby.bat" asks the py launcher for.
      If LCase(candidate) = "py.exe" Then extraArgs = " -3"
      FindPython = found
      Exit Function
    End If
  Next
  FindPython = ""
End Function

Function OnPath(name)
  Dim folders, folder, full
  OnPath = ""
  For Each folder In Split(shell.ExpandEnvironmentStrings("%PATH%"), ";")
    If folder <> "" Then
      full = fso.BuildPath(folder, name)
      If fso.FileExists(full) Then
        OnPath = full
        Exit Function
      End If
    End If
  Next
End Function

' Edge is on every Windows 10 and 11 machine; Chrome is the fallback. Both open
' a --app window without browser chrome, which is what "its own window" means
' here without shipping a compiled wrapper.
Function FindBrowser()
  Dim candidates, candidate
  For Each candidate In Array( _
      shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"), _
      shell.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"), _
      shell.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe"), _
      shell.ExpandEnvironmentStrings("%LocalAppData%\Google\Chrome\Application\chrome.exe"))
    If fso.FileExists(candidate) Then
      FindBrowser = candidate
      Exit Function
    End If
  Next
  FindBrowser = ""
End Function

Sub OpenDashboard()
  Dim browser
  browser = FindBrowser()
  If browser = "" Then
    ' No Chromium browser to host an app window: a normal browser window still
    ' gets the dashboard, and closing it still stops the server.
    shell.Run url, 1, False
    Exit Sub
  End If
  shell.Run Quote(browser) & " --app=" & url & " --window-size=1280,860", 1, False
End Sub
