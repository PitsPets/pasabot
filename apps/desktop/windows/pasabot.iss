; Inno Setup 6 script for PasaBot (W26). Per-user install: no admin rights, no UAC prompt, into
; %LOCALAPPDATA%\Programs\PasaBot. Start menu entries, optional desktop icon and start at sign-in. The uninstaller
; leaves the person's data (%USERPROFILE%\.pasabot) unless they say so. Unsigned (signing is the owner's step).
; The server listens on 127.0.0.1 only, so Windows Firewall never asks.
; Compiled by build-windows.ps1:  iscc /DVersion=x.y.z /DSource=<out\PasaBot> /O<out> [/DSignedUninstallerDir=<dir>] pasabot.iss
; NOT COMPILED by the author (no Windows machine): .github/workflows/desktop.yml compiles it.
; Every shortcut and every install or uninstall step runs the bundled node.exe (signed by its publisher) with
; windows-shell.js, never PowerShell: on a PC with Smart App Control, unsigned PowerShell runs in Constrained Language
; Mode. The tray (PowerShell) is started by windows-shell.js only where it can run.
#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Source
  #define Source "..\out\PasaBot"
#endif
#define Node "{app}\node.exe"
#define ShellJs "{app}\pasabot\apps\desktop\dist\windows-shell.js"

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
#ifdef SignedUninstallerDir
; release-windows.yml: the uninstaller is signed before the installer is made. The first compile writes
; uninst-<version>-<hash>.e32 here and stops ("signature needed"); once that file is signed (SignPath), the second
; compile embeds its signature in the uninstaller the installer writes (Inno Setup's SignedUninstaller)
SignedUninstaller=yes
SignedUninstallerDir={#SignedUninstallerDir}
#endif

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start PasaBot when I sign in to Windows"; Flags: unchecked
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Files]
Source: "{#Source}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
; node.exe is a console program: the shortcut starts it minimized, and windows-shell.js starts PasaBot hidden and exits
Name: "{group}\PasaBot"; Filename: "{#Node}"; Parameters: """{#ShellJs}"" start"; WorkingDir: "{app}"; IconFilename: "{app}\pasabot.ico"; Flags: runminimized
; asks the running PasaBot to quit (it stops its server cleanly); with no tray icon, this or Settings > Quit PasaBot
Name: "{group}\Stop PasaBot"; Filename: "{#Node}"; Parameters: """{#ShellJs}"" stop"; WorkingDir: "{app}"; IconFilename: "{app}\pasabot.ico"; Flags: runminimized
Name: "{group}\Check this computer (PasaBot)"; Filename: "{#Node}"; Parameters: """{app}\pasabot\apps\desktop\dist\selftest.js"" --pause"; WorkingDir: "{app}"; IconFilename: "{app}\pasabot.ico"
Name: "{group}\Uninstall PasaBot"; Filename: "{uninstallexe}"
Name: "{autodesktop}\PasaBot"; Filename: "{#Node}"; Parameters: """{#ShellJs}"" start"; WorkingDir: "{app}"; IconFilename: "{app}\pasabot.ico"; Flags: runminimized; Tasks: desktopicon

[Run]
; the workspace links the build wrote down (links.json): junctions, no admin rights needed
Filename: "{#Node}"; Parameters: """{#ShellJs}"" links"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; StatusMsg: "Setting up PasaBot..."
Filename: "{#Node}"; Parameters: """{#ShellJs}"" start"; WorkingDir: "{app}"; Description: "Open PasaBot"; Flags: postinstall nowait skipifsilent runminimized

[UninstallRun]
; stops this install's PasaBot and removes the junctions as links (never what they point to)
Filename: "{#Node}"; Parameters: """{#ShellJs}"" uninstall"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated; RunOnceId: "PasaBotLinks"

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
