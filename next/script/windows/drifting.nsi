; Drifting's Windows installer (NSIS 3, Unicode, per user, no administrator).
;
; It writes the same install folder, Add/Remove Programs entry, vendor key and
; URL scheme as the 0.1 client's Tauri-made installer, so it installs over a
; Tauri install (the hand-over) and takes the flags Tauri's updater passes:
;
;   /S        silent            /P   passive: progress only, no questions
;   /UPDATE   an update: keep shortcuts as the author left them
;   /R        start the app when done (with /S or /P)
;   /ARGS …   arguments for that start
;   /NS       no shortcuts      /D=<folder>  install folder (NSIS's own)
;
; Build it with script/bundle-windows.ps1. The defaults below are the
; development identity (dr-platform's identity.rs checks they match); the
; hand-over passes the release identity instead:
;   /DPRODUCT_NAME=Drifting /DBUNDLE_ID=cc.drifting.client /DURL_SCHEME=drifting
;
; Unsigned during the alpha (decision D10); see the F7 doc.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "Drifting Next"
!endif
!ifndef BUNDLE_ID
  !define BUNDLE_ID "cc.drifting.next.dev"
!endif
!ifndef URL_SCHEME
  !define URL_SCHEME "drifting-next-dev"
!endif
!ifndef EXECUTABLE
  !define EXECUTABLE "drifting"
!endif
!ifndef PUBLISHER
  !define PUBLISHER "drifting"
!endif
!ifndef HOMEPAGE
  !define HOMEPAGE "https://github.com/chihumyum/Drifting"
!endif
!ifndef ICON
  !define ICON "..\..\..\src\assets\icon.ico"
!endif
!ifndef VERSION
  !error "pass /DVERSION=<semver>"
!endif
!ifndef VERSION_NUMERIC
  !error "pass /DVERSION_NUMERIC=<a.b.c.d>"
!endif
!ifndef EXE_SOURCE
  !error "pass /DEXE_SOURCE=<path to drifting.exe>"
!endif
!ifndef OUTFILE
  !define OUTFILE "${PRODUCT_NAME}_${VERSION}-setup.exe"
!endif

; Tauri's keys: HKCU because the 0.1 installer ran in currentUser mode.
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!define MANUKEY "Software\${PUBLISHER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCT_NAME}"
!define URLKEY "Software\Classes\${URL_SCHEME}"

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

Name "${PRODUCT_NAME}"
OutFile "${OUTFILE}"
; %LOCALAPPDATA%\<product>, unless an earlier install (Tauri's or ours)
; recorded another folder.
InstallDir "$LOCALAPPDATA\${PRODUCT_NAME}"
InstallDirRegKey HKCU "${MANUPRODUCTKEY}" ""
BrandingText "${PRODUCT_NAME} ${VERSION}"

VIProductVersion "${VERSION_NUMERIC}"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "LegalCopyright" "AGPL-3.0-or-later"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING

!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipUnlessAsked
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipUnlessAsked
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXECUTABLE}.exe"
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(DesktopShortcut)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; The 0.1 installer's two languages, picked by the system language.
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString AppRunning ${LANG_SIMPCHINESE} "${PRODUCT_NAME} 正在运行。请先退出它，再点「重试」。"
LangString AppRunning ${LANG_ENGLISH} "${PRODUCT_NAME} is running. Quit it, then choose Retry."
LangString DesktopShortcut ${LANG_SIMPCHINESE} "创建桌面快捷方式"
LangString DesktopShortcut ${LANG_ENGLISH} "Create a desktop shortcut"

!macro ReadFlags
  ${GetParameters} $R9
  StrCpy $PassiveMode 0
  StrCpy $UpdateMode 0
  StrCpy $NoShortcutMode 0
  ClearErrors
  ${GetOptions} $R9 "/P" $R8
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R9 "/UPDATE" $R8
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R9 "/NS" $R8
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}
!macroend

; The previous copy must have exited before its executable is replaced. After
; an update the old app is quitting on its own; wait up to 10 seconds. Then a
; passive or silent run ends this user's copies; an interactive one asks.
!macro WaitForApp un
Function ${un}WaitForApp
  StrCpy $R1 0
  ${Do}
    ${IfNot} ${FileExists} "$INSTDIR\${EXECUTABLE}.exe"
      Return
    ${EndIf}
    ClearErrors
    FileOpen $R2 "$INSTDIR\${EXECUTABLE}.exe" a
    ${IfNot} ${Errors}
      FileClose $R2
      Return
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 > 40
      ${If} $PassiveMode = 1
      ${OrIf} ${Silent}
        ReadEnvStr $R3 USERNAME
        nsExec::Exec '"$SYSDIR\taskkill.exe" /F /FI "IMAGENAME eq ${EXECUTABLE}.exe" /FI "USERNAME eq $R3"'
        Pop $R4
        Sleep 1000
        ${If} $R1 > 44
          SetErrorLevel 2
          Quit
        ${EndIf}
      ${Else}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(AppRunning)" IDRETRY retry
        Quit
        retry:
        StrCpy $R1 0
      ${EndIf}
    ${EndIf}
    Sleep 250
  ${Loop}
FunctionEnd
!macroend
!insertmacro WaitForApp ""
!insertmacro WaitForApp "un."

Function .onInit
  !insertmacro ReadFlags
  SetShellVarContext current
FunctionEnd

; Passive runs and updates show only the progress page.
Function SkipUnlessAsked
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    Abort
  ${EndIf}
FunctionEnd

Function CreateDesktopShortcut
  ${If} $NoShortcutMode <> 1
    CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXECUTABLE}.exe"
  ${EndIf}
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  Call WaitForApp
  File "/oname=${EXECUTABLE}.exe" "${EXE_SOURCE}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${MANUPRODUCTKEY}" "" "$INSTDIR"

  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" '"$INSTDIR\${EXECUTABLE}.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" '"$INSTDIR"'
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  ; Read by a 0.1 installer if the author goes back to a Tauri build.
  WriteRegStr HKCU "${UNINSTKEY}" "MainBinaryName" "${EXECUTABLE}.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
  WriteRegStr HKCU "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
  WriteRegStr HKCU "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"

  ; GPUI cannot register a scheme on Windows, so the installer does, as the
  ; Tauri installer did.
  WriteRegStr HKCU "${URLKEY}" "" "URL:${BUNDLE_ID} protocol"
  WriteRegStr HKCU "${URLKEY}" "URL Protocol" ""
  WriteRegStr HKCU "${URLKEY}\DefaultIcon" "" '"$INSTDIR\${EXECUTABLE}.exe",0'
  WriteRegStr HKCU "${URLKEY}\shell\open\command" "" '"$INSTDIR\${EXECUTABLE}.exe" "%1"'

  ; An update keeps the shortcuts the author has (and pinned); the target
  ; path is unchanged.
  ${If} $UpdateMode <> 1
  ${AndIf} $NoShortcutMode <> 1
    CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${EXECUTABLE}.exe"
    ${If} $PassiveMode = 1
    ${OrIf} ${Silent}
      Call CreateDesktopShortcut
    ${EndIf}
  ${EndIf}

  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetParameters} $R9
    ClearErrors
    ${GetOptions} $R9 "/R" $R8
    ${IfNot} ${Errors}
      ClearErrors
      ${GetOptions} $R9 "/ARGS" $R7
      ${If} ${Errors}
        StrCpy $R7 ""
      ${EndIf}
      Exec '"$INSTDIR\${EXECUTABLE}.exe" $R7'
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro ReadFlags
  SetShellVarContext current
FunctionEnd

; The library ($LOCALAPPDATA\<bundle id>) and the logs are never removed here.
Section "Uninstall"
  Call un.WaitForApp
  Delete "$INSTDIR\${EXECUTABLE}.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ReadRegStr $0 HKCU "${URLKEY}\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\${EXECUTABLE}.exe" "%1"'
    DeleteRegKey HKCU "${URLKEY}"
  ${EndIf}

  ${If} $UpdateMode <> 1
    Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    DeleteRegKey HKCU "${UNINSTKEY}"
    DeleteRegKey HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
  ${EndIf}
SectionEnd
