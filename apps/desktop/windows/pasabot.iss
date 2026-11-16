; Inno Setup 6 script for PasaBot (W26). Per-user install: no admin rights, no UAC prompt, into
; %LOCALAPPDATA%\Programs\PasaBot. Start menu entries, optional desktop icon and start at sign-in. The uninstaller
; leaves the person's data (%USERPROFILE%\.pasabot) unless they say so. Unsigned (signing is the owner's step).
; The server listens on 127.0.0.1 only, so Windows Firewall never asks.
; Compiled by build-windows.ps1:  iscc /DVersion=x.y.z /DSource=<out\PasaBot> /O<out> pasabot.iss
; NOT COMPILED by the author (no Windows machine): .github/workflows/desktop.yml compiles it.
#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Source
  #define Source "..\out\PasaBot"
#endif
#define PS "{sys}\WindowsPowerShell\v1.0\powershell.exe"

[Setup]
AppId=PasaBot.Desktop
AppName=PasaBot
AppVersion={#Version}
AppPublisher=PasaBot contributors
DefaultDirName={localappdata}\Programs\PasaBot
DefaultGroupName=PasaBot
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
OutputBaseFilename=PasaBot-Setup-{#Version}
Compression=lzma2
SolidCompression=yes
LicenseFile={#Source}\pasabot\LICENSE
SetupIconFile={#Source}\pasabot.ico
UninstallDisplayIcon={app}\pasabot.ico
UninstallDisplayName=PasaBot
WizardStyle=modern
MinVersion=10.0
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; an update while PasaBot runs: close it (node.exe holds files in {app}) and start it again afterwards
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start PasaBot when I sign in to Windows"; Flags: unchecked
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Files]
Source: "{#Source}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; the tray, hidden: powershell is a console program, so the shortcut starts it minimized and it hides itself
Name: "{group}\PasaBot"; Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\PasaBotTray.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\pasabot.ico"; Flags: runminimized
Name: "{group}\Check this computer (PasaBot)"; Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\selftest.ps1"" -Pause"; WorkingDir: "{app}"; IconFilename: "{app}\pasabot.ico"
Name: "{group}\Uninstall PasaBot"; Filename: "{uninstallexe}"
Name: "{autodesktop}\PasaBot"; Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\PasaBotTray.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\pasabot.ico"; Flags: runminimized; Tasks: desktopicon

[Run]
; the workspace links the build wrote down (links.ps1): junctions, no admin rights needed
Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\links.ps1"""; Flags: runhidden waituntilterminated; StatusMsg: "Setting up PasaBot..."
Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\PasaBotTray.ps1"""; WorkingDir: "{app}"; Description: "Open PasaBot"; Flags: postinstall nowait skipifsilent runminimized

[UninstallRun]
; stops this install's PasaBot and removes the junctions as links (never what they point to)
Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\links.ps1"" -Remove"; Flags: runhidden waituntilterminated; RunOnceId: "PasaBotLinks"

[UninstallDelete]
; open-at-login, written by the tray's toggle or the autostart task
Type: files; Name: "{userstartup}\PasaBot.cmd"
; what "Check this computer" wrote next to itself (its report, and the logs of a failed check)
Type: files; Name: "{app}\selftest-report.txt"
Type: files; Name: "{app}\selftest-logs.txt"
Type: dirifempty; Name: "{app}"

[Code]
{ The same Startup script the tray's "Open at login" writes (apps/desktop/src/autostart.ts): it names
  %LOCALAPPDATA%, never the user folder, because cmd.exe reads a .cmd file in the OEM code page and a name such as
  Peña would be misread. It CALLs PasaBot.cmd (START would run it as cmd /K and leave a console open at every
  sign-in). Only for the default install folder; elsewhere the tray's toggle decides. }
procedure WriteAutostart();
var
  Local, App, Rest: String;
begin
  Local := ExpandConstant('{localappdata}');
  App := ExpandConstant('{app}');
  if CompareText(Copy(App, 1, Length(Local) + 1), Local + '\') <> 0 then exit;
  Rest := Copy(App, Length(Local) + 1, Length(App));
  SaveStringToFile(ExpandConstant('{userstartup}\PasaBot.cmd'),
    '@echo off' + #13#10 + 'call "%LOCALAPPDATA%' + Rest + '\PasaBot.cmd"' + #13#10, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('autostart') then WriteAutostart();
end;

{ Uninstall: the person's chats, helpers and keys stay unless they ask, and never in a silent uninstall. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
  Code: Integer;
begin
  if CurUninstallStep <> usPostUninstall then exit;
  if UninstallSilent() then exit;
  Data := GetEnv('PASABOT_HOME');
  if Data = '' then Data := ExpandConstant('{%USERPROFILE}\.pasabot');
  if not DirExists(Data) then exit;
  if MsgBox('PasaBot is removed. Also delete your PasaBot data (chats, helpers and saved keys) in ' + Data + '?' + #13#10#13#10 +
      'Choose No to keep it for a later install.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    { rmdir /s removes a junction a helper made in its workspace as a link, never what it points to }
    Exec(ExpandConstant('{cmd}'), '/c rmdir /s /q "' + Data + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;
