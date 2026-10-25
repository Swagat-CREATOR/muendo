; Mewndo's own installer and uninstaller steps, run by electron-builder's NSIS target (see "nsis.include" in
; package.json). Prompt P8.2: install mewndo-core and the desktop app together, and start the core at login.
;
; What ships, and where it lands (from "extraResources" in package.json):
;
;   $INSTDIR\Mewndo.exe                            the Electron app
;   $INSTDIR\resources\mewndo-core.exe             the always-on service (spec §38.1)
;   $INSTDIR\resources\mewndo-hook.exe             the hook forwarder (§33.10 Part B)
;   $INSTDIR\resources\claude-code\                the Claude Code plugin, with bin\mewndo-hook.exe staged
;                                                  into it by build\stage-binaries.js
;
; The app starts the core as `mewndo-core.exe --desk %LOCALAPPDATA%\Mewndo --data ... --rules
; %APPDATA%\Mewndo\rules.toml` (app\main.js, startCore); build\stage-binaries.js refuses to package an app whose
; startCore() lost --desk. What Mewndo writes outside $INSTDIR, and what uninstall does with it:
;
;   %APPDATA%\mewndo\        save points, trash, logs, settings, rules.toml    kept unless the user says delete
;   %LOCALAPPDATA%\Mewndo\   desk.db (the Inbox's card history), core.json     kept unless the user says delete
;   ~\.claude\settings.json  Mewndo's hook entries                            always taken out, the rest kept
;
; "Starts the core at login" means exactly this: the Run entry below starts **Mewndo.exe --hidden**, and the
; app starts mewndo-core.exe as a child (app\main.js, startCore). There is no Windows service and no separate
; entry for the core, on purpose - a service would need an elevated install (this one is per-user, so no UAC
; prompt), and a core with no app to answer to has nothing to show a card on. The cost is honest and worth
; writing down: if the app is killed, the core goes with it, and nothing restarts it until the next sign-in.
;
; This build is NOT signed. See "Installing and updates" in the root README.md for what that costs the user.
; Nothing in this file claims otherwise, and nothing here suppresses a SmartScreen prompt.

; Where Windows keeps per-user startup entries. The app writes the same value through
; app.setLoginItemSettings({ name: 'Mewndo' }) whenever the user changes the setting, so the installer only
; seeds it and the app stays the one source of truth afterwards.
!define MEWNDO_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

!macro customInstall
  ${ifNot} ${isUpdated}
    ; A first install, so there is no user choice to respect yet: protection should be on from the next
    ; sign-in without the user having to find a setting. --hidden makes the app open to the tray rather than
    ; to a window; app\main.js reads it, and app-settings.json's openAtLogin (default true) is what the
    ; Settings toggle then edits.
    ;
    ; Deliberately inside "not isUpdated": on an update the value is whatever the user last chose, and an
    ; installer that turned it back on would be overruling them.
    WriteRegStr HKCU "${MEWNDO_RUN_KEY}" "Mewndo" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hidden'
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Take Mewndo's hooks out of Claude Code's settings (keeping everything else), while Mewndo.exe is still here.
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-claude-hooks'
    ; Start at sign-in
    DeleteRegValue HKCU "${MEWNDO_RUN_KEY}" "Mewndo"
    ; The saved history is the user's to keep or delete. Keeping is the default (and what a silent uninstall does).
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete Mewndo's saved history?$\r$\n$\r$\nThis permanently deletes every save point of your protected folders, Mewndo's trash (files that restores moved aside), the Agent Inbox's card history, and your rules.toml.$\r$\n$\r$\nChoose No to keep it: if you install Mewndo again, it finds your history." /SD IDNO IDNO mewndoKeepHistory
      RMDir /r "$APPDATA\mewndo"
      ; The desk folder (decisions.md, "desk.db location"). Not $LOCALAPPDATA\Programs\Mewndo, which is $INSTDIR.
      RMDir /r "$LOCALAPPDATA\Mewndo"
    mewndoKeepHistory:
  ${endIf}
!macroend
