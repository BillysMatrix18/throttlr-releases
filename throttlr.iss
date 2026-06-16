; ============================================================
; Throttlr — Inno Setup installer script
; ============================================================
;
; Builds Throttlr-Setup-X.X.X.exe — a single-file Windows installer
; that installs Throttlr.exe (built by build.bat / PyInstaller) to
; Program Files with proper shortcuts, uninstaller, and optional
; "launch on install" checkbox.
;
; To compile: install Inno Setup 6 from https://jrsoftware.org/isinfo.php
; then either right-click this file → "Compile" or run:
;   "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" throttlr.iss
;
; build.bat invokes this automatically if Inno Setup is installed.
; ============================================================

#define AppName       "Throttlr"
#define AppVersion    "3.1.4"
#define AppPublisher  "Billy's Matrix"
#define AppExeName    "Throttlr.exe"
#define AppURL        "https://github.com/BillysMatrix18/throttlr-releases"
#define AppSupportURL "https://github.com/BillysMatrix18/throttlr/issues"

[Setup]
; AppId — DO NOT CHANGE between versions. This GUID identifies "this is
; the same app" so installs upgrade in place instead of duplicating.
AppId={{2F502D18-1D8D-414E-953C-7CBDDA8B1BAD}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppSupportURL}
AppUpdatesURL={#AppURL}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=auto
OutputDir=dist
OutputBaseFilename=Throttlr-Setup
SetupIconFile=throttlr.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64
ArchitecturesAllowed=x64
MinVersion=10.0
CloseApplications=force
RestartApplications=no

; Branding
WizardImageFile=
WizardSmallImageFile=

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; The actual app — built by PyInstaller into dist\Throttlr.exe
Source: "dist\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Start Menu
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; IconFilename: "{app}\{#AppExeName}"
Name: "{group}\Throttlr on GitHub"; Filename: "{#AppURL}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

; Optional desktop icon (only if user ticked the box)
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon; IconFilename: "{app}\{#AppExeName}"

[Run]
; Optional "launch after install" — checkbox visible on final page.
; runasoriginaluser drops elevation so Windows can re-trigger UAC for
; Throttlr's own admin manifest (avoids CreateProcess error 740).
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent runasoriginaluser shellexec

[UninstallDelete]
; Clean up user data folder on uninstall — DISABLED by default. The user
; might want to keep their settings/profiles even if they uninstall.
; To enable, uncomment the line below:
; Type: filesandordirs; Name: "{userappdata}\Throttlr"
