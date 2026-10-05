; Mewndo's own uninstall steps, run by electron-builder's uninstaller (see "nsis.include" in package.json).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Take Mewndo's hooks out of Claude Code's settings (keeping everything else), while Mewndo.exe is still here.
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --remove-claude-hooks'
    ; Start at sign-in
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mewndo"
    ; The saved history is the user's to keep or delete. Keeping is the default (and what a silent uninstall does).
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete Mewndo's saved history?$\r$\n$\r$\nThis permanently deletes every save point of your protected folders, and Mewndo's trash (files that restores moved aside).$\r$\n$\r$\nChoose No to keep it: if you install Mewndo again, it finds your history." /SD IDNO IDNO mewndoKeepHistory
      RMDir /r "$APPDATA\mewndo"
    mewndoKeepHistory:
  ${endIf}
!macroend
