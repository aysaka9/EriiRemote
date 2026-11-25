; Force-close running EriiRemote.exe and its child tree (including easytier-core.exe)
; before NSIS checks for locked files, because closing to tray intercepts WM_CLOSE.
!macro customInit
  nsExec::ExecToLog 'taskkill /F /T /IM "Erii远程.exe"'
  Sleep 800
!macroend

; Keep a copy of this installer inside the install dir so this device can
; share it with other LAN peers for automatic peer-to-peer upgrades.
; Also enable WDDM graphics display driver for Remote Desktop Connections
; so dynamic window-resize resolution works out of the box.
!macro customInstall
  CreateDirectory "$INSTDIR\update"
  CopyFiles /SILENT "$EXEPATH" "$INSTDIR\update\EriiRemote-Setup.exe"
  WriteRegDWORD HKLM "SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services" "fEnableWddmDriver" 1
!macroend
