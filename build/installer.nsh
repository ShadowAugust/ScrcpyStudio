; Extra NSIS steps (electron-builder include): Phone Link gets its own shortcuts,
; which open only the compact Phone Link window (--link).
!macro customInstall
  ${ifNot} ${isUpdated}
    CreateShortCut "$DESKTOP\Phone Link.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--link" "$INSTDIR\resources\link.ico" 0 "" "" "Use your phone as webcam, microphone and speakers"
  ${endIf}
  CreateShortCut "$SMPROGRAMS\Phone Link.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--link" "$INSTDIR\resources\link.ico" 0 "" "" "Use your phone as webcam, microphone and speakers"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\Phone Link.lnk"
    Delete "$SMPROGRAMS\Phone Link.lnk"
  ${endIf}
!macroend
